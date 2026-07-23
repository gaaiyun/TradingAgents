import { serveDynamic } from "./_dynamic_api.mjs";
import { queryMarketBars } from "./_d1_repository.mjs";

export function onRequestGet(context) {
  return serveDynamic(context, {
    capabilities: { symbol: true, profile: true, timeframe: true },
    query: queryMarketBars,
  });
}
