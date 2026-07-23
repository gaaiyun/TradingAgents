import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createAdapters } from "../workers/monitor/src/providers/adapters.mjs";
import { ProviderError } from "../workers/monitor/src/providers/contracts.mjs";

function fixture(name) {
  return JSON.parse(readFileSync(
    new URL(`./fixtures/providers/${name}.json`, import.meta.url),
    "utf8",
  ));
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

const runtime = {
  fetchedAt: "2026-07-23T07:05:00.000Z",
  now: new Date("2026-07-23T07:05:00.000Z"),
  freshnessThresholdMs: 10 * 60 * 1000,
};

test("Tencent uses the live mkline 5m and kline 1d contracts for all configured CN symbols", async () => {
  const requests = [];
  const adapters = createAdapters({
    fetch: async (url) => {
      requests.push(String(url));
      if (String(url).includes("sh515880")) {
        return jsonResponse(fixture("tencent-515880-5m"));
      }
      if (String(url).includes("sz159995")) {
        return jsonResponse(fixture("tencent-159995-5m"));
      }
      return jsonResponse(fixture("tencent-512480-1d"));
    },
    timeoutMs: 100,
  });

  const first = await adapters.tencent({
    symbol: "515880.SS",
    market: "CN",
    timeframe: "5m",
  }, runtime);
  const second = await adapters.tencent({
    symbol: "159995.SZ",
    market: "CN",
    timeframe: "5m",
  }, runtime);
  const daily = await adapters.tencent({
    symbol: "512480.SS",
    market: "CN",
    timeframe: "1d",
  }, {
    ...runtime,
    freshnessThresholdMs: 36 * 60 * 60 * 1000,
  });

  assert.deepEqual(requests, [
    "https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=sh515880,m5,,320",
    "https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=sz159995,m5,,320",
    "https://ifzq.gtimg.cn/appstock/app/kline/kline?param=sh512480,day,,,320",
  ]);
  assert.equal(first.at(-1).close, 0.671);
  assert.equal(second.at(-1).close, 1.262);
  assert.equal(daily.at(-1).close, 1.106);
});

test("Eastmoney includes its required range parameters and validates rc/data/klines", async () => {
  let requestedUrl;
  const adapters = createAdapters({
    fetch: async (url) => {
      requestedUrl = String(url);
      return jsonResponse(fixture("eastmoney-159995-5m"));
    },
    timeoutMs: 100,
  });
  const bars = await adapters.eastmoney({
    symbol: "159995.SZ",
    market: "CN",
    timeframe: "5m",
  }, runtime);

  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get("secid"), "0.159995");
  assert.equal(url.searchParams.get("beg"), "0");
  assert.equal(url.searchParams.get("end"), "20500101");
  assert.equal(url.searchParams.get("lmt"), "320");
  assert.equal(bars.at(-1).close, 1.262);

  for (const payload of [
    { rc: 102, data: null },
    { rc: 0, data: { code: "159995", klines: [] } },
  ]) {
    const invalid = createAdapters({
      fetch: async () => jsonResponse(payload),
      timeoutMs: 100,
    });
    await assert.rejects(
      () => invalid.eastmoney({
        symbol: "159995.SZ",
        market: "CN",
        timeframe: "5m",
      }, runtime),
      (error) => error instanceof ProviderError && error.code === "MALFORMED_DATA",
    );
  }
});

test("Yahoo drops timestamp-aligned null points but rejects an entirely bad series", async () => {
  const payload = fixture("yahoo-515880-null-points");
  const adapters = createAdapters({
    fetch: async () => jsonResponse(payload),
    timeoutMs: 100,
  });
  const bars = await adapters.yahoo({
    symbol: "515880.SS",
    market: "CN",
    timeframe: "5m",
  }, runtime);

  assert.equal(bars.length, 1);
  assert.equal(bars[0].close, 0.6790000200271606);

  const entirelyBad = structuredClone(payload);
  for (const values of Object.values(
    entirelyBad.chart.result[0].indicators.quote[0],
  )) {
    values[0] = null;
  }
  const invalid = createAdapters({
    fetch: async () => jsonResponse(entirelyBad),
    timeoutMs: 100,
  });
  await assert.rejects(
    () => invalid.yahoo({
      symbol: "515880.SS",
      market: "CN",
      timeframe: "5m",
    }, runtime),
    (error) => error instanceof ProviderError && error.code === "MALFORMED_DATA",
  );
});

test("Yahoo daily retries query2 as the same source when query1 fails", async () => {
  const urls = [];
  const payload = fixture("yahoo-515880-null-points");
  const adapters = createAdapters({
    fetch: async (url) => {
      urls.push(String(url));
      return urls.length === 1 ? new Response("", { status: 503 }) : jsonResponse(payload);
    },
    timeoutMs: 100,
  });

  const bars = await adapters.yahoo({
    symbol: "515880.SS",
    market: "CN",
    timeframe: "1d",
  }, {
    ...runtime,
    freshnessThresholdMs: 36 * 60 * 60 * 1000,
  });
  assert.equal(bars.length, 1);
  assert.match(urls[0], /^https:\/\/query1\.finance\.yahoo\.com\//);
  assert.match(urls[1], /^https:\/\/query2\.finance\.yahoo\.com\//);
});

test("Stooq validates CSV content and reports its JS challenge with a stable code", async () => {
  const challenge = [
    "<!DOCTYPE html><html><body><noscript>",
    "This site requires JavaScript to verify your browser.",
    "</noscript></body></html>",
  ].join("");
  const challenged = createAdapters({
    fetch: async () => new Response(challenge, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
    timeoutMs: 100,
  });
  await assert.rejects(
    () => challenged.stooq({
      symbol: "NVDA",
      market: "US",
      timeframe: "1d",
    }, runtime),
    (error) => error instanceof ProviderError && error.code === "UPSTREAM_CHALLENGE",
  );

  const csv = createAdapters({
    fetch: async () => new Response([
      "Date,Open,High,Low,Close,Volume",
      "2026-07-23,10,12,9,11,1000",
    ].join("\n"), {
      status: 200,
      headers: { "content-type": "text/csv" },
    }),
    timeoutMs: 100,
  });
  const bars = await csv.stooq({
    symbol: "NVDA",
    market: "US",
    timeframe: "1d",
  }, runtime);
  assert.equal(bars[0].close, 11);
});
