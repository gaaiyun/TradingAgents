import { normalizeMarketRequest } from "./contracts.mjs";

const FRESHNESS_VALUES = new Set(["fresh", "stale"]);

export class MarketBarWriteError extends Error {
  constructor(code) {
    super(code);
    this.name = "MarketBarWriteError";
    this.code = code;
  }
}

function invalidBar() {
  throw new MarketBarWriteError("INVALID_BAR");
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(new Date(value).valueOf());
}

function validFinite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateBar(bar) {
  if (!bar || typeof bar !== "object") invalidBar();
  let request;
  try {
    request = normalizeMarketRequest({
      symbol: bar.symbol,
      timeframe: bar.timeframe,
    });
  } catch {
    invalidBar();
  }
  if (
    request.symbol !== bar.symbol ||
    !validTimestamp(bar.timestamp) ||
    !validTimestamp(bar.asOf) ||
    !validTimestamp(bar.fetchedAt) ||
    bar.timestamp !== bar.asOf ||
    ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(validFinite) ||
    bar.open <= 0 ||
    bar.high <= 0 ||
    bar.low <= 0 ||
    bar.close <= 0 ||
    bar.volume < 0 ||
    bar.high < Math.max(bar.open, bar.close, bar.low) ||
    bar.low > Math.min(bar.open, bar.close, bar.high) ||
    typeof bar.source !== "string" ||
    !bar.source ||
    !FRESHNESS_VALUES.has(bar.freshness) ||
    bar.adjustment !== "none" ||
    typeof bar.quality !== "string" ||
    !bar.quality
  ) {
    invalidBar();
  }
}

export function retentionExpiry(timeframe, now = new Date()) {
  if (timeframe === "5m") {
    return new Date(now.valueOf() + 90 * 24 * 60 * 60 * 1000).toISOString();
  }
  if (timeframe === "1d") {
    const expiresAt = new Date(now);
    expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 5);
    return expiresAt.toISOString();
  }
  invalidBar();
}

export async function writeMarketBars(db, { profileId, bars, now = new Date() }) {
  if (!db || typeof db.prepare !== "function") {
    throw new MarketBarWriteError("DB_REQUIRED");
  }
  if (typeof profileId !== "string" || !profileId.trim() || !Array.isArray(bars)) {
    invalidBar();
  }
  for (const bar of bars) validateBar(bar);
  if (bars.length === 0) return { written: 0 };

  const payload = bars.map((bar) => ({
    profileId: profileId.trim(),
    symbol: bar.symbol,
    timeframe: bar.timeframe,
    timestamp: bar.timestamp,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    source: bar.source,
    asOf: bar.asOf,
    fetchedAt: bar.fetchedAt,
    freshness: bar.freshness,
    adjustment: bar.adjustment,
    quality: bar.quality,
    expiresAt: retentionExpiry(bar.timeframe, now),
  }));
  await db.prepare(`
    INSERT INTO market_bars (
      profile_id, symbol, timeframe, ts, open, high, low, close, volume,
      source, as_of, fetched_at, freshness, adjustment, quality, expires_at
    )
    SELECT
      json_extract(value, '$.profileId'),
      json_extract(value, '$.symbol'),
      json_extract(value, '$.timeframe'),
      json_extract(value, '$.timestamp'),
      json_extract(value, '$.open'),
      json_extract(value, '$.high'),
      json_extract(value, '$.low'),
      json_extract(value, '$.close'),
      json_extract(value, '$.volume'),
      json_extract(value, '$.source'),
      json_extract(value, '$.asOf'),
      json_extract(value, '$.fetchedAt'),
      json_extract(value, '$.freshness'),
      json_extract(value, '$.adjustment'),
      json_extract(value, '$.quality'),
      json_extract(value, '$.expiresAt')
    FROM json_each(?)
    WHERE 1
    ON CONFLICT(profile_id, symbol, timeframe, ts, source, adjustment)
    DO UPDATE SET
      open = excluded.open,
      high = excluded.high,
      low = excluded.low,
      close = excluded.close,
      volume = excluded.volume,
      as_of = excluded.as_of,
      fetched_at = excluded.fetched_at,
      freshness = excluded.freshness,
      quality = excluded.quality,
      expires_at = excluded.expires_at
  `).bind(JSON.stringify(payload)).run();
  return { written: bars.length };
}
