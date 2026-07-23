import { json } from "./_util.js";
import {
  DEFAULT_LIVE_URL,
  DEFAULT_SNAPSHOT_URL,
  loadVolguardData,
} from "./_volguard.mjs";

// GET /api/volguard → 优先返回实时行情，上游不可用时自动降级为慢速快照。
export async function onRequestGet({ env }) {
  const result = await loadVolguardData({
    liveUrl: env.VOLGUARD_LIVE_URL || DEFAULT_LIVE_URL,
    snapshotUrl: env.VOLGUARD_SNAPSHOT_URL || DEFAULT_SNAPSHOT_URL,
  });

  if (!result.ok) {
    return json(
      {
        error: "VolGuard 实时与快照数据均不可用",
        mode: result.mode,
        attempts: result.attempts,
        errors: result.errors,
      },
      502,
      { "cache-control": "no-store", "x-volguard-mode": "unavailable" },
    );
  }

  return json(result.data, 200, {
    "cache-control": result.mode === "live" ? "public, max-age=15" : "public, max-age=120",
    "x-volguard-mode": result.mode,
    ...(result.fallback_reason ? { "x-volguard-fallback": result.fallback_reason } : {}),
  });
}
