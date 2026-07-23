import assert from "node:assert/strict";
import test from "node:test";

const writerUrl = new URL(
  "../workers/monitor/src/providers/market-bar-writer.mjs",
  import.meta.url,
);

function marketBar(overrides = {}) {
  return {
    symbol: "515880.SS",
    timeframe: "5m",
    timestamp: "2026-07-23T02:00:00.000Z",
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 1000,
    source: "tencent",
    asOf: "2026-07-23T02:00:00.000Z",
    fetchedAt: "2026-07-23T02:05:00.000Z",
    freshness: "fresh",
    adjustment: "none",
    quality: "good",
    ...overrides,
  };
}

class FakeBarsD1 {
  constructor() {
    this.rows = new Map();
    this.prepared = [];
    this.runCalls = 0;
    this.binds = [];
  }

  prepare(sql) {
    this.prepared.push(sql);
    return {
      bind: (...values) => {
        this.binds.push(values);
        return {
        sql,
        values,
        run: async () => {
            this.runCalls += 1;
            const payload = JSON.parse(values[0]);
            for (const row of payload) {
              const key = [
                row.profileId,
                row.symbol,
                row.timeframe,
                row.timestamp,
                row.source,
                row.adjustment,
              ].join("|");
              this.rows.set(key, row);
            }
            return { meta: { changes: payload.length } };
          },
        };
      },
    };
  }
}

test("writes normalized bars with one parameterized JSON1 statement", async () => {
  const { writeMarketBars } = await import(writerUrl);
  const db = new FakeBarsD1();
  const result = await writeMarketBars(db, {
    profileId: "profile-a",
    bars: [marketBar()],
    now: new Date("2026-07-23T02:05:00.000Z"),
  });

  assert.deepEqual(result, { written: 1 });
  assert.equal(db.runCalls, 1);
  assert.equal(db.rows.size, 1);
  assert.match(db.prepared[0], /INSERT INTO market_bars/i);
  assert.match(db.prepared[0], /json_each\s*\(\s*\?\s*\)/i);
  assert.match(db.prepared[0], /ON CONFLICT\s*\(\s*profile_id\s*,\s*symbol/i);
  assert.equal(db.prepared[0].includes("profile-a"), false);
  assert.equal(db.prepared[0].includes("515880.SS"), false);
  assert.equal(db.binds[0].length, 1);
  const row = [...db.rows.values()][0];
  assert.deepEqual(
    [row.profileId, row.symbol, row.timeframe, row.timestamp],
    ["profile-a", "515880.SS", "5m", "2026-07-23T02:00:00.000Z"],
  );
});

test("keeps the same source bar for two profiles and makes repeats idempotent", async () => {
  const { writeMarketBars } = await import(writerUrl);
  const db = new FakeBarsD1();
  const now = new Date("2026-07-23T02:05:00.000Z");

  await writeMarketBars(db, { profileId: "profile-a", bars: [marketBar()], now });
  await writeMarketBars(db, { profileId: "profile-a", bars: [marketBar()], now });
  await writeMarketBars(db, { profileId: "profile-b", bars: [marketBar()], now });

  assert.equal(db.rows.size, 2);
  assert.equal(
    [...db.rows.keys()].some((key) => key.startsWith("profile-a|")),
    true,
  );
  assert.equal(
    [...db.rows.keys()].some((key) => key.startsWith("profile-b|")),
    true,
  );
});

test("rejects bad numeric, timestamp, and metadata values before touching D1", async () => {
  const { MarketBarWriteError, writeMarketBars } = await import(writerUrl);
  const invalidBars = [
    marketBar({ close: Number.NaN }),
    marketBar({ timestamp: "invalid" }),
    marketBar({ high: 8 }),
    marketBar({ freshness: "cached-but-fresh" }),
    marketBar({ source: "" }),
    marketBar({ adjustment: "mystery" }),
  ];

  for (const bar of invalidBars) {
    const db = new FakeBarsD1();
    await assert.rejects(
      () => writeMarketBars(db, {
        profileId: "profile-a",
        bars: [bar],
        now: new Date("2026-07-23T02:05:00.000Z"),
      }),
      (error) => error instanceof MarketBarWriteError && error.code === "INVALID_BAR",
    );
    assert.equal(db.prepared.length, 0);
    assert.equal(db.runCalls, 0);
  }
});

test("retains 5m bars for 90 days and 1d bars for five calendar years", async () => {
  const { retentionExpiry, writeMarketBars } = await import(writerUrl);
  const now = new Date("2026-07-23T02:05:00.000Z");
  assert.equal(
    retentionExpiry("5m", now),
    new Date(now.valueOf() + 90 * 24 * 60 * 60 * 1000).toISOString(),
  );
  assert.equal(retentionExpiry("1d", now), "2031-07-23T02:05:00.000Z");

  const db = new FakeBarsD1();
  await writeMarketBars(db, {
    profileId: "profile-a",
    bars: [marketBar(), marketBar({
      timeframe: "1d",
      timestamp: "2026-07-23T00:00:00.000Z",
      asOf: "2026-07-23T00:00:00.000Z",
    })],
    now,
  });
  const expiries = [...db.rows.values()].map((row) => row.expiresAt).sort();
  assert.deepEqual(expiries, [
    "2026-10-21T02:05:00.000Z",
    "2031-07-23T02:05:00.000Z",
  ]);
});

test("executes 1255 bars as one SQLite JSON1 UPSERT and stays profile-scoped and idempotent", async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite is unavailable on this Node version");
    return;
  }
  const { readFileSync } = await import("node:fs");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(
    new URL("../migrations/0001_workbench_dynamic.sql", import.meta.url),
    "utf8",
  ));
  const db = {
    queries: [],
    prepare(sql) {
      this.queries.push(sql);
      return {
        bind: (...values) => ({
          run: async () => sqlite.prepare(sql).run(...values),
        }),
      };
    },
  };
  const { writeMarketBars } = await import(writerUrl);
  const now = new Date("2026-07-23T02:05:00.000Z");
  const bars = Array.from({ length: 1255 }, (_, index) => {
    const timestamp = new Date(
      Date.UTC(2026, 6, 23, 2) - index * 5 * 60 * 1000,
    ).toISOString();
    return marketBar({ timestamp, asOf: timestamp });
  });

  await writeMarketBars(db, { profileId: "profile-a", bars, now });
  assert.equal(db.queries.length, 1);
  assert.equal(
    sqlite.prepare("SELECT count(*) AS count FROM market_bars").get().count,
    1255,
  );

  await writeMarketBars(db, { profileId: "profile-a", bars, now });
  assert.equal(db.queries.length, 2);
  assert.equal(
    sqlite.prepare("SELECT count(*) AS count FROM market_bars").get().count,
    1255,
  );

  await writeMarketBars(db, { profileId: "profile-b", bars, now });
  assert.equal(db.queries.length, 3);
  assert.equal(
    sqlite.prepare("SELECT count(*) AS count FROM market_bars").get().count,
    2510,
  );
});
