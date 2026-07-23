function eligibleTargets(profile) {
  return profile.targets.filter((target) =>
    target.market === "CN" &&
    (target.role === "core" || target.role === "comparison"));
}

function changes(result) {
  return result?.meta?.changes ?? result?.changes ?? 0;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function zScore(value, history) {
  if (!Number.isFinite(value) || history.length < 10) return null;
  const average = mean(history);
  const variance = history.reduce((sum, item) => sum + (item - average) ** 2, 0)
    / Math.max(1, history.length - 1);
  const deviation = Math.sqrt(variance);
  return deviation > 0 ? (value - average) / deviation : null;
}

async function eventId(profileId, symbol, scheduledFor) {
  const material = `${profileId}\n${symbol}\nintraday-signal\n${scheduledFor}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `event-${hex}`;
}

async function recentBars(db, profileId, symbol, scheduledFor, now) {
  const result = await db.prepare(
    `SELECT symbol, timeframe, ts, open, high, low, close, volume,
            source, as_of, fetched_at, freshness, adjustment, quality
     FROM market_bars
     WHERE profile_id = ? AND symbol = ? AND timeframe = '5m'
       AND ts <= ? AND expires_at > ?
     ORDER BY ts DESC LIMIT 80`,
  ).bind(profileId, symbol, scheduledFor, now.toISOString()).all();
  return (result?.results || [])
    .filter((bar) => Number.isFinite(Number(bar.close)))
    .reverse();
}

function priceMove15m(bars) {
  const latest = bars.at(-1);
  if (!latest || bars.length < 4) return null;
  const targetTime = Date.parse(latest.ts) - 15 * 60_000;
  let baseline = null;
  for (let index = bars.length - 2; index >= 0; index -= 1) {
    if (Date.parse(bars[index].ts) <= targetTime) {
      baseline = bars[index];
      break;
    }
  }
  const before = Number(baseline?.close);
  const current = Number(latest.close);
  if (!Number.isFinite(before) || before === 0 || !Number.isFinite(current)) return null;
  return (current / before - 1) * 100;
}

function volumeAnomaly(bars) {
  const latest = bars.at(-1);
  const current = Number(latest?.volume);
  const history = bars
    .slice(-21, -1)
    .map(({ volume }) => Number(volume))
    .filter(Number.isFinite);
  return zScore(current, history);
}

function importanceFor(priceMove, volumeZ) {
  const absoluteMove = Math.abs(priceMove ?? 0);
  if (absoluteMove >= 2 || (volumeZ ?? -Infinity) >= 3) return "high";
  if (absoluteMove >= 1 || (volumeZ ?? -Infinity) >= 2) return "medium";
  return null;
}

function description(priceMove, volumeZ, latest) {
  const parts = [];
  if (priceMove !== null) parts.push(`15分钟涨跌 ${priceMove.toFixed(2)}%`);
  if (volumeZ !== null) parts.push(`成交量 z-score ${volumeZ.toFixed(2)}`);
  parts.push(`收盘 ${Number(latest.close)}`);
  parts.push(`行情来源 ${latest.source}`);
  return parts.join("；");
}

async function insertEvent(db, {
  id,
  profileId,
  symbol,
  importance,
  latest,
  priceMove,
  volumeZ,
  now,
}) {
  const expiresAt = new Date(now.valueOf() + 180 * 24 * 60 * 60 * 1000).toISOString();
  const result = await db.prepare(
    `INSERT INTO market_events (
       id, symbol, profile_id, topic, importance, event_at, title, description,
       source, as_of, fetched_at, freshness, adjustment, quality, expires_at
     ) VALUES (?, ?, ?, 'market_move', ?, ?, ?, ?, 'signal-engine', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(
    id,
    symbol,
    profileId,
    importance,
    latest.ts,
    `${symbol} 15分钟价格异动`,
    description(priceMove, volumeZ, latest),
    latest.as_of || latest.ts,
    now.toISOString(),
    latest.freshness || "unknown",
    latest.adjustment || "none",
    latest.quality || "unknown",
    expiresAt,
  ).run();
  return changes(result);
}

export async function evaluateIntradaySignals({
  db,
  profile,
  scheduledFor,
  now = new Date(),
}) {
  const counts = {
    targets: 0,
    evaluated: 0,
    medium: 0,
    high: 0,
    inserted: 0,
    unavailable: 0,
  };
  const sources = [];
  const targets = eligibleTargets(profile);
  counts.targets = targets.length;

  for (const target of targets) {
    let bars;
    try {
      bars = await recentBars(db, profile.id, target.symbol, scheduledFor, now);
    } catch {
      counts.unavailable += 1;
      continue;
    }
    const latest = bars.at(-1);
    const latestTime = Date.parse(latest?.ts);
    if (
      bars.length < 4 ||
      !Number.isFinite(latestTime) ||
      now.valueOf() - latestTime > 10 * 60_000
    ) {
      counts.unavailable += 1;
      continue;
    }
    counts.evaluated += 1;
    const priceMove = priceMove15m(bars);
    const volumeZ = volumeAnomaly(bars);
    const importance = importanceFor(priceMove, volumeZ);
    sources.push({
      source: latest.source,
      status: latest.freshness === "stale" ? "stale" : "ok",
      symbol: target.symbol,
      asOf: latest.as_of || latest.ts,
    });
    if (!importance) continue;
    counts[importance] += 1;
    counts.inserted += await insertEvent(db, {
      id: await eventId(profile.id, target.symbol, scheduledFor),
      profileId: profile.id,
      symbol: target.symbol,
      importance,
      latest,
      priceMove,
      volumeZ,
      now,
    });
  }

  if (counts.evaluated === 0) {
    return {
      status: "deferred",
      errorCode: "SIGNAL_INPUT_UNAVAILABLE",
      counts,
      sources,
    };
  }
  return {
    status: counts.unavailable > 0 ? "degraded" : "completed",
    ...(counts.unavailable > 0 ? { errorCode: "SIGNAL_INPUT_PARTIAL" } : {}),
    counts,
    sources,
  };
}
