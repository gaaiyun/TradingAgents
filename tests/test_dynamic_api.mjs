import assert from "node:assert/strict";
import test from "node:test";

import * as eventsApi from "../functions/api/events.js";
import * as marketApi from "../functions/api/market.js";
import * as monitorApi from "../functions/api/monitor-status.js";
import * as newsApi from "../functions/api/news.js";
import { FakeD1 } from "./helpers/fake_d1.mjs";

const SOURCE_KEYS = ["source", "asOf", "fetchedAt", "freshness", "adjustment", "quality"];
const VALID_STATUSES = new Set(["ok", "degraded", "stale", "unavailable"]);

function request(path) {
  return new Request(`https://workbench.test${path}`);
}

function assertEnvelope(payload) {
  assert.deepEqual(Object.keys(payload).slice(0, 4), ["status", "asOf", "data", "sources"]);
  assert.equal(VALID_STATUSES.has(payload.status), true);
  assert.equal(Array.isArray(payload.data), true);
  assert.equal(Array.isArray(payload.sources), true);
  for (const source of payload.sources) assert.deepEqual(Object.keys(source), SOURCE_KEYS);
}

test("market API builds parameterized symbol/profile/timeframe/date filters and source metadata", async () => {
  const row = {
    symbol: "SPY",
    profile_id: "us-core",
    timeframe: "5m",
    ts: "2026-07-23T10:00:00Z",
    open: 620,
    high: 622,
    low: 619,
    close: 621,
    volume: 1000,
    source: "market-provider",
    as_of: "2026-07-23T10:01:00Z",
    fetched_at: "2026-07-23T10:01:05Z",
    freshness: "fresh",
    adjustment: "split",
    quality: "good",
  };
  const DB = new FakeD1({ rows: { market_bars: [row] } });
  const response = await marketApi.onRequestGet({
    request: request("/api/market?symbol=spy&profile=us-core&timeframe=5m&from=2026-07-23T09:00:00Z&to=2026-07-23T11:00:00Z&limit=25"),
    env: { DB },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assertEnvelope(payload);
  assert.equal(payload.status, "ok");
  assert.deepEqual(payload.data, [row]);
  assert.deepEqual(payload.sources[0], {
    source: "market-provider",
    asOf: "2026-07-23T10:01:00Z",
    fetchedAt: "2026-07-23T10:01:05Z",
    freshness: "fresh",
    adjustment: "split",
    quality: "good",
  });
  const [{ sql, params }] = DB.calls;
  assert.match(sql, /symbol\s*=\s*\?/i);
  assert.match(sql, /profile_id\s*=\s*\?/i);
  assert.match(sql, /timeframe\s*=\s*\?/i);
  assert.match(sql, /ts\s*>=\s*\?/i);
  assert.match(sql, /ts\s*<=\s*\?/i);
  assert.match(sql, /LIMIT\s+\?/i);
  assert.deepEqual(params, ["SPY", "us-core", "5m", "2026-07-23T09:00:00.000Z", "2026-07-23T11:00:00.000Z", 25]);
});

test("news and events APIs support topic and importance filters without interpolating input", async () => {
  const injectedTopic = "chips' OR 1=1 --";
  const newsRow = {
    id: "news-1",
    symbol: "NVDA",
    profile_id: "semi",
    topic: injectedTopic,
    title: "Chip update",
    published_at: "2026-07-23T09:00:00Z",
    source: "wire",
    as_of: "2026-07-23T09:01:00Z",
    fetched_at: "2026-07-23T09:01:05Z",
    freshness: "stale",
    adjustment: null,
    quality: "good",
  };
  const eventRow = {
    id: "event-1",
    profile_id: "semi",
    importance: "high",
    topic: "earnings",
    event_at: "2026-07-24T09:00:00Z",
    title: "Earnings",
    source: "calendar",
    as_of: "2026-07-23T09:00:00Z",
    fetched_at: "2026-07-23T09:00:05Z",
    freshness: "fresh",
    adjustment: null,
    quality: "good",
  };
  const DB = new FakeD1({ rows: { news_items: [newsRow], market_events: [eventRow] } });

  const newsResponse = await newsApi.onRequestGet({
    request: request(`/api/news?symbol=nvda&profile=semi&topic=${encodeURIComponent(injectedTopic)}&limit=9999`),
    env: { DB },
  });
  const eventResponse = await eventsApi.onRequestGet({
    request: request("/api/events?profile=semi&topic=earnings&importance=high&from=2026-07-23&to=2026-07-25"),
    env: { DB },
  });
  const newsPayload = await newsResponse.json();
  const eventPayload = await eventResponse.json();

  assertEnvelope(newsPayload);
  assertEnvelope(eventPayload);
  assert.equal(newsPayload.status, "stale");
  assert.equal(eventPayload.status, "ok");
  const newsCall = DB.calls[0];
  assert.equal(newsCall.sql.includes(injectedTopic), false);
  assert.equal(newsCall.params.includes(injectedTopic), true);
  assert.equal(newsCall.params.at(-1), 500);
  assert.match(DB.calls[1].sql, /importance\s*=\s*\?/i);
  assert.deepEqual(DB.calls[1].params.slice(0, 3), ["semi", "earnings", "high"]);
});

test("monitor status returns source health in the same envelope", async () => {
  const DB = new FakeD1({ rows: { source_health: [{
    source: "wire",
    status: "degraded",
    as_of: "2026-07-23T09:00:00Z",
    fetched_at: "2026-07-23T09:00:05Z",
    freshness: "fresh",
    adjustment: null,
    quality: "partial",
    detail: "rate limited",
  }] } });
  const response = await monitorApi.onRequestGet({
    request: request("/api/monitor-status?source=wire&limit=10"),
    env: { DB },
  });
  const payload = await response.json();

  assertEnvelope(payload);
  assert.equal(payload.status, "degraded");
  assert.equal(payload.sources[0].adjustment, null);
  assert.deepEqual(DB.calls[0].params, ["wire", 10]);
});

test("dynamic APIs return unavailable envelopes for missing, empty, or failing D1", async () => {
  const apis = [marketApi, newsApi, eventsApi, monitorApi];
  for (const api of apis) {
    for (const env of [{}, { DB: new FakeD1() }, { DB: new FakeD1({ fail: true }) }]) {
      const response = await api.onRequestGet({ request: request("/api/data"), env });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assertEnvelope(payload);
      assert.equal(payload.status, "unavailable");
      assert.deepEqual(payload.data, []);
    }
  }
});

test("dynamic APIs reject invalid filters without querying D1", async () => {
  const DB = new FakeD1();
  const cases = [
    [marketApi, "/api/market?symbol=SPY%27%20OR%201%3D1--"],
    [marketApi, "/api/market?timeframe=yearly"],
    [newsApi, "/api/news?limit=-2"],
    [eventsApi, "/api/events?importance=urgent"],
    [eventsApi, "/api/events?from=2026-07-25&to=2026-07-23"],
  ];
  for (const [api, path] of cases) {
    const response = await api.onRequestGet({ request: request(path), env: { DB } });
    assert.equal(response.status, 400);
    assertEnvelope(await response.json());
  }
  assert.equal(DB.calls.length, 0);
});
