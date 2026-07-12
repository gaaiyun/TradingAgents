import { json } from "./_util.js";

const VOLGUARD_URL = "https://sh50-volguard.pages.dev/data/latest.json";

// GET /api/volguard → 上证50ETF 期权风控快照（VolGuard 项目, 同账号 Pages）
export async function onRequestGet() {
  const resp = await fetch(VOLGUARD_URL, { cf: { cacheTtl: 120, cacheEverything: true } });
  if (!resp.ok) return json({ error: `VolGuard 上游 ${resp.status}` }, 502);
  const body = await resp.text();
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=120" },
  });
}
