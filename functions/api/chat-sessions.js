import { d1Binding } from "./_d1_repository.mjs";
import {
  deleteChatSession,
  getChatSession,
  normalizeChatId,
} from "./_chat_repository.mjs";
import { gate, json, readJsonBody } from "./_util.js";

function noStore(data, status = 200) {
  return json(data, status, { "cache-control": "no-store" });
}

function authorized(request, env) {
  return gate(env, request.headers.get("x-access-code"));
}

export async function onRequestGet({ request, env }) {
  if (!authorized(request, env)) {
    return noStore({ status: "unavailable", error: "访问码不正确", code: "invalid_access_code" }, 401);
  }
  const sessionId = normalizeChatId(new URL(request.url).searchParams.get("sessionId"));
  if (!sessionId) {
    return noStore({ status: "unavailable", error: "会话 ID 无效", code: "invalid_session_id" }, 400);
  }
  const db = d1Binding(env);
  if (!db) {
    return noStore({ status: "unavailable", asOf: null, data: null, sources: [] }, 503);
  }
  try {
    const session = await getChatSession(db, sessionId);
    return noStore({
      status: "ok",
      asOf: session?.updatedAt || null,
      data: session || { id: sessionId, messages: [] },
      sources: [{ source: "d1", asOf: session?.updatedAt || null }],
    });
  } catch {
    return noStore({ status: "unavailable", asOf: null, data: null, sources: [] }, 503);
  }
}

export async function onRequestDelete({ request, env }) {
  if (!authorized(request, env)) {
    return noStore({ status: "unavailable", error: "访问码不正确", code: "invalid_access_code" }, 401);
  }
  const body = await readJsonBody(request);
  const sessionId = normalizeChatId(body?.sessionId);
  if (!sessionId) {
    return noStore({ status: "unavailable", error: "会话 ID 无效", code: "invalid_session_id" }, 400);
  }
  const db = d1Binding(env);
  if (!db) return noStore({ status: "unavailable", error: "会话存储不可用" }, 503);
  try {
    const deleted = await deleteChatSession(db, sessionId);
    return noStore({
      status: "ok",
      asOf: new Date().toISOString(),
      data: { sessionId, deleted },
      sources: [{ source: "d1" }],
    });
  } catch {
    return noStore({ status: "unavailable", error: "会话删除失败" }, 503);
  }
}
