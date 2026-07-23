import { RAW_BASE, REPO, ghHeaders, json } from "./_util.js";
import { buildHealthPayload, checkJson } from "./_health.mjs";

const VOLGUARD_LIVE = "https://sh50-volguard.pages.dev/api/live";

// GET /api/health
// 只暴露能力是否已配置，不返回任何 secret、token 或访问码。
export async function onRequestGet({ env }) {
  const checks = await Promise.all([
    checkJson("reports", `${RAW_BASE}/data/latest.json?ts=${Date.now()}`),
    checkJson("actions", `https://api.github.com/repos/${REPO}/actions/runs?per_page=1`, {
      headers: ghHeaders(env),
    }),
    checkJson("options_live", `${env.VOLGUARD_LIVE_URL || VOLGUARD_LIVE}?ts=${Date.now()}`),
  ]);

  return json(
    buildHealthPayload(env, checks),
    200,
    { "cache-control": "no-store" },
  );
}
