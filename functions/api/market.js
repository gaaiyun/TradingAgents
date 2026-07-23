import {
  DynamicQueryError,
  dynamicEnvelope,
  parseDynamicQuery,
  unavailableEnvelope,
} from "./_dynamic_api.mjs";
import { d1Binding, queryMarketBars } from "./_d1_repository.mjs";
import { calculateTechnicalSnapshot } from "./_indicators.mjs";
import { json } from "./_util.js";

const PERIODS_PER_YEAR = {
  "1m": 240 * 252,
  "5m": 48 * 252,
  "15m": 16 * 252,
  "30m": 8 * 252,
  "1h": 4 * 252,
  "4h": 252,
  "1d": 252,
};

export async function onRequestGet({ request, env }) {
  let query;
  try {
    query = parseDynamicQuery(request, {
      symbol: true,
      profile: true,
      timeframe: true,
    });
  } catch (error) {
    if (error instanceof DynamicQueryError) {
      return json(unavailableEnvelope(error.message), 400, { "cache-control": "no-store" });
    }
    throw error;
  }
  const db = d1Binding(env);
  if (!db) return json(unavailableEnvelope(), 200, { "cache-control": "no-store" });
  try {
    const rows = await queryMarketBars(db, query);
    const envelope = dynamicEnvelope(rows);
    return json({
      ...envelope,
      indicators: rows.length
        ? calculateTechnicalSnapshot(rows, {
          periodsPerYear: PERIODS_PER_YEAR[query.timeframe] || 252,
        })
        : null,
    }, 200, { "cache-control": "no-store" });
  } catch {
    return json(unavailableEnvelope(), 200, { "cache-control": "no-store" });
  }
}
