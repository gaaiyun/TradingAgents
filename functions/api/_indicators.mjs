const VERSION = "ta-indicators-v1";

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(8)) : null;
}

function normalizeBars(input) {
  return (Array.isArray(input) ? input : [])
    .map((bar) => ({
      ...bar,
      ts: String(bar?.ts || ""),
      open: finite(bar?.open),
      high: finite(bar?.high),
      low: finite(bar?.low),
      close: finite(bar?.close),
      volume: finite(bar?.volume),
    }))
    .filter((bar) => Number.isFinite(Date.parse(bar.ts)) && bar.close !== null)
    .sort((left, right) => left.ts.localeCompare(right.ts));
}

function simpleAverage(values, period) {
  if (values.length < period) return null;
  const window = values.slice(-period);
  return window.reduce((sum, value) => sum + value, 0) / period;
}

function emaSeries(values, period) {
  const result = Array(values.length).fill(null);
  if (values.length < period) return result;
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = current;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    current = (values[index] - current) * multiplier + current;
    result[index] = current;
  }
  return result;
}

function rsi14(values) {
  if (values.length < 15) return null;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= 14; index += 1) {
    const change = values[index] - values[index - 1];
    gains += Math.max(0, change);
    losses += Math.max(0, -change);
  }
  let averageGain = gains / 14;
  let averageLoss = losses / 14;
  for (let index = 15; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * 13 + Math.max(0, change)) / 14;
    averageLoss = (averageLoss * 13 + Math.max(0, -change)) / 14;
  }
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function atr14(bars) {
  const eligible = bars.filter((bar) => bar.high !== null && bar.low !== null);
  if (eligible.length < 14) return null;
  const ranges = eligible.map((bar, index) => {
    if (index === 0) return bar.high - bar.low;
    const previousClose = eligible[index - 1].close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );
  });
  let current = ranges.slice(0, 14).reduce((sum, value) => sum + value, 0) / 14;
  for (let index = 14; index < ranges.length; index += 1) {
    current = (current * 13 + ranges[index]) / 14;
  }
  return current;
}

function realizedVolatility(values, periodsPerYear) {
  if (values.length < 21) return null;
  const returns = [];
  for (let index = values.length - 20; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous <= 0 || current <= 0) return null;
    returns.push(Math.log(current / previous));
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0)
    / Math.max(1, returns.length - 1);
  return Math.sqrt(variance * periodsPerYear) * 100;
}

function adjustmentOf(bars) {
  const missing = bars.some((bar) => typeof bar.adjustment !== "string" || !bar.adjustment);
  const values = new Set(
    bars.map((bar) => bar.adjustment).filter((value) => typeof value === "string" && value),
  );
  if (values.size === 0) return "none";
  if (missing) return "unknown";
  return values.size === 1 ? [...values][0] : "unknown";
}

export function calculateTechnicalSnapshot(input, { periodsPerYear = 252 } = {}) {
  const bars = normalizeBars(input);
  const closes = bars.map(({ close }) => close);
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const macdValues = [];
  const macdIndexes = [];
  for (let index = 0; index < closes.length; index += 1) {
    if (fast[index] === null || slow[index] === null) continue;
    macdIndexes.push(index);
    macdValues.push(fast[index] - slow[index]);
  }
  const signalValues = emaSeries(macdValues, 9);
  const latestMacd = macdValues.at(-1) ?? null;
  const latestSignal = signalValues.at(-1) ?? null;
  return {
    version: VERSION,
    bars: bars.length,
    asOf: bars.at(-1)?.ts || null,
    adjustment: adjustmentOf(bars),
    ma20: round(simpleAverage(closes, 20)),
    ma60: round(simpleAverage(closes, 60)),
    macd: round(latestMacd),
    macdSignal: round(latestSignal),
    macdHistogram: round(
      latestMacd !== null && latestSignal !== null ? latestMacd - latestSignal : null,
    ),
    rsi14: round(rsi14(closes)),
    atr14: round(atr14(bars)),
    realizedVolatility20: round(realizedVolatility(closes, periodsPerYear)),
    methodology: {
      macd: "EMA 12/26, signal EMA 9",
      rsi: "Wilder 14",
      atr: "Wilder 14",
      realizedVolatility: `20-period log returns, annualized with ${periodsPerYear}`,
    },
  };
}
