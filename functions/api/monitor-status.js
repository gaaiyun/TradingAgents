import { serveDynamic } from "./_dynamic_api.mjs";
import { querySourceHealth } from "./_d1_repository.mjs";

export function onRequestGet(context) {
  return serveDynamic(context, {
    capabilities: { source: true },
    query: querySourceHealth,
    health: true,
  });
}
