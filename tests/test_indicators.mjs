import assert from "node:assert/strict";
import test from "node:test";

import { calculateTechnicalSnapshot } from "../functions/api/_indicators.mjs";

function sampleBars(count = 80) {
  const start = Date.parse("2026-07-23T01:30:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.2 + Math.sin(index / 4);
    return {
      ts: new Date(start + index * 5 * 60_000).toISOString(),
      open: close - 0.1,
      high: close + 0.4,
      low: close - 0.5,
      close,
      volume: 1_000_000 + index * 10_000,
    };
  });
}

test("technical snapshot calculates the agreed server-side indicator set", () => {
  const snapshot = calculateTechnicalSnapshot(sampleBars());
  assert.equal(snapshot.version, "ta-indicators-v1");
  assert.equal(snapshot.bars, 80);
  for (const key of [
    "ma20", "ma60", "macd", "macdSignal", "macdHistogram",
    "rsi14", "atr14", "realizedVolatility20",
  ]) {
    assert.equal(Number.isFinite(snapshot[key]), true, `${key} should be finite`);
  }
  assert.equal(snapshot.asOf, "2026-07-23T08:05:00.000Z");
  assert.equal(snapshot.adjustment, "none");
});

test("technical snapshot is explicit when history is insufficient or malformed", () => {
  const short = calculateTechnicalSnapshot(sampleBars(10));
  assert.equal(short.ma20, null);
  assert.equal(short.rsi14, null);
  assert.equal(short.atr14, null);
  assert.equal(short.realizedVolatility20, null);
  assert.equal(short.ma60, null);

  const malformed = calculateTechnicalSnapshot([
    { ts: "bad", close: 1 },
    { ts: "2026-07-23T00:00:00.000Z", close: null },
  ]);
  assert.equal(malformed.bars, 0);
  assert.equal(malformed.asOf, null);
});

test("split adjustment metadata is never invented by the indicator engine", () => {
  const bars = sampleBars();
  bars.forEach((bar) => { bar.adjustment = "split-adjusted"; });
  const snapshot = calculateTechnicalSnapshot(bars);
  assert.equal(snapshot.adjustment, "split-adjusted");

  bars.at(-1).adjustment = null;
  assert.equal(calculateTechnicalSnapshot(bars).adjustment, "unknown");
});
