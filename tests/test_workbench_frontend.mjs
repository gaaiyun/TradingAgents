import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import * as workbenchData from "../public/assets/workbench-data.mjs";

const {
  DEFAULT_TARGETS,
  computeNextRun,
  filterFeedItems,
  mergeIncrementalBars,
  normalizeEnvelope,
} = workbenchData;

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/assets/workbench.css", import.meta.url), "utf8");
const script = readFileSync(new URL("../public/assets/workbench.js", import.meta.url), "utf8");

test("research terminal exposes the continuous three-column workspace and indicator panes", () => {
  assert.match(html, /class="research-layout"/);
  assert.match(html, /id="watchlist"/);
  assert.match(html, /id="task-timeline"/);
  assert.match(html, /id="market-chart"/);
  assert.match(html, /id="macd-chart"/);
  assert.match(html, /id="rsi-chart"/);
  assert.match(html, /id="research-feed"/);
  assert.match(html, /id="cross-market-drivers"/);
  assert.match(html, /data-timeframe="5m"/);
  assert.match(html, /data-timeframe="15m"/);
  assert.match(html, /data-timeframe="1h"/);
  assert.match(html, /data-timeframe="1d"/);
});

test("default universe contains the full ETF and semiconductor driver set", () => {
  assert.deepEqual(
    DEFAULT_TARGETS.map(({ symbol }) => symbol),
    ["515880.SS", "512480.SS", "159995.SZ", "SOXX", "SMH", "NVDA", "TSM", "AVGO", "AMD", "ASML"],
  );
});

test("dynamic API envelopes retain provenance and expose an unavailable fallback", () => {
  const normalized = normalizeEnvelope({
    status: "stale",
    asOf: "2026-07-23T08:00:00.000Z",
    data: [{ symbol: "NVDA" }],
    sources: [{ source: "stooq", fetchedAt: "2026-07-23T08:01:00.000Z", freshness: "stale" }],
  });
  assert.equal(normalized.status, "stale");
  assert.equal(normalized.data[0].symbol, "NVDA");
  assert.equal(normalized.sources[0].freshness, "stale");

  const unavailable = normalizeEnvelope(null);
  assert.deepEqual(unavailable, { status: "unavailable", asOf: null, data: [], sources: [] });
});

test("market polling replaces only the matching last bar and appends a newer bar", () => {
  const bars = [
    { ts: "2026-07-23T01:00:00.000Z", close: 10 },
    { ts: "2026-07-23T01:05:00.000Z", close: 11 },
  ];
  const replaced = mergeIncrementalBars(bars, [
    { ts: "2026-07-23T01:05:00.000Z", close: 11.5 },
  ]);
  assert.deepEqual(replaced, [
    { ts: "2026-07-23T01:00:00.000Z", close: 10 },
    { ts: "2026-07-23T01:05:00.000Z", close: 11.5 },
  ]);
  assert.equal(replaced[0], bars[0]);

  const appended = mergeIncrementalBars(replaced, [
    { ts: "2026-07-23T01:10:00.000Z", close: 12 },
  ]);
  assert.equal(appended.length, 3);
  assert.equal(appended.at(-1).close, 12);
});

test("feed filtering supports symbol, source hierarchy, and minimum importance", () => {
  const items = [
    { symbol: "NVDA", source: "sec", importance: "high" },
    { symbol: "NVDA", source: "reuters", importance: "medium" },
    { symbol: "TSM", source: "reuters", importance: "critical" },
  ];
  assert.deepEqual(
    filterFeedItems(items, { symbol: "NVDA", source: "sec", importance: "medium" }),
    [items[0]],
  );
  assert.deepEqual(
    filterFeedItems(items, { symbol: "all", source: "reuters", importance: "high" }),
    [items[2]],
  );
});

test("next-run calculation uses enabled profile timezone schedule without inventing results", () => {
  const profile = {
    enabled: true,
    timezone: "Asia/Shanghai",
    schedules: {
      preMarketBrief: { enabled: true, time: "08:25" },
      closeDeepAnalysis: { enabled: true, time: "15:20" },
      usCloseSnapshot: { enabled: false, time: "05:35" },
    },
  };
  const next = computeNextRun(profile, new Date("2026-07-23T01:00:00.000Z"));
  assert.equal(next.label, "收盘深度分析");
  assert.match(next.at, /^2026-07-23T07:20:00/);
});

test("mobile layout switches usable regions instead of shrinking the desktop grid", () => {
  assert.match(html, /class="mobile-nav"/);
  assert.match(html, /data-mobile-section="watch"/);
  assert.match(html, /data-mobile-section="chart"/);
  assert.match(html, /data-mobile-section="feed"/);
  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
  assert.match(css, /body\[data-mobile-view="watch"\]/);
  assert.match(script, /setMobileView/);
});

test("chart uses vendored Lightweight Charts 5.2.0 with panes, axes, and incremental series updates", () => {
  const vendorUrl = new URL("../public/vendor/lightweight-charts.production.mjs", import.meta.url);
  const licenseUrl = new URL("../public/vendor/LICENSE-lightweight-charts", import.meta.url);
  const noticeUrl = new URL("../public/vendor/NOTICE-lightweight-charts", import.meta.url);
  assert.equal(existsSync(vendorUrl), true);
  assert.equal(existsSync(licenseUrl), true);
  assert.equal(existsSync(noticeUrl), true);
  assert.match(script, /lightweight-charts\.production\.mjs/);
  assert.match(script, /createChart/);
  assert.match(script, /addSeries\([^)]*,[^)]*,\s*1\)/);
  assert.match(script, /addSeries\([^)]*,[^)]*,\s*2\)/);
  assert.match(script, /\.update\(/);
  assert.doesNotMatch(script, /attributionLogo\s*:\s*false/);
});

test("scheduled refresh updates selected bars, watch quotes, feeds, and monitor without reloading the page", () => {
  assert.match(script, /function pollWorkbenchData/);
  assert.match(script, /loadMarket\(\{\s*incremental:\s*true\s*\}\)/);
  assert.match(script, /loadQuoteStrip\(\)/);
  assert.match(script, /loadFeeds\(\)/);
  assert.match(script, /loadMonitor\(\)/);
  assert.doesNotMatch(script, /location\.reload/);
});

test("task timeline never maps source health rows to schedule slots by array position", () => {
  assert.equal(typeof workbenchData.buildTaskTimeline, "function");
  const profile = {
    schedules: {
      usCloseSnapshot: { enabled: true, time: "05:35" },
      preMarketBrief: { enabled: true, time: "08:25" },
      cnIntraday: { enabled: true, windows: [{ start: "09:30", end: "11:30" }] },
      closeDeepAnalysis: { enabled: true, time: "15:20" },
    },
  };
  const timeline = workbenchData.buildTaskTimeline(profile, [
    { source: "yahoo", status: "ok", detail: "healthy" },
  ]);
  assert.equal(timeline.length, 4);
  assert.equal(timeline.every((item) => item.status === "pending"), true);
  assert.equal(timeline.every((item) => item.detail === "任务结果接口未提供"), true);
});

test("current-symbol conclusion never falls back to a different symbol", () => {
  assert.equal(typeof workbenchData.selectConclusion, "function");
  const latest = { results: [{ ticker: "NVDA", rating: "Buy" }] };
  assert.equal(workbenchData.selectConclusion(latest, "515880.SS"), null);
  assert.equal(workbenchData.selectConclusion(latest, "NVDA"), latest.results[0]);
});

test("chat keeps persistent local threads and streams SSE with history context", () => {
  assert.match(script, /ta\.workbench\.threads\.v1/);
  assert.match(script, /function loadThreads/);
  assert.match(script, /function saveThreads/);
  assert.match(script, /history:\s*historyMessages/);
  assert.match(script, /stream:\s*true/);
  assert.match(script, /response\.body\.getReader\(\)/);
  assert.match(script, /event\s*===\s*"delta"/);
  assert.match(html, /id="thread-select"/);
  assert.match(html, /id="new-thread"/);
  assert.match(html, /id="delete-thread"/);
});

test("mobile chart view keeps cross-market drivers accessible", () => {
  assert.doesNotMatch(css, /\.driver-deck\s*\{\s*display:\s*none/);
  assert.match(css, /body\[data-mobile-view="watch"\]\s+\.driver-deck/);
});

test("settings expose every schedule and PushPlus switch plus local credential clearing", () => {
  for (const id of [
    "enable-us-close", "enable-premarket", "enable-intraday", "enable-close-analysis",
    "alert-pushplus", "clear-credential",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /function clearCredential/);
  assert.match(script, /localStorage\.removeItem\(STORAGE\.deviceKey\)/);
});
