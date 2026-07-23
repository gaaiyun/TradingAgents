const CHAT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/;
const DEFAULT_SESSION_DAYS = 90;
const DEFAULT_REQUEST_DAYS = 30;

function iso(date) {
  return (date instanceof Date ? date : new Date(date)).toISOString();
}

function addDays(date, days) {
  return new Date(date.valueOf() + days * 24 * 60 * 60 * 1000).toISOString();
}

function changes(result) {
  return result?.meta?.changes ?? result?.changes ?? 0;
}

function safeJson(value, fallback = null) {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function normalizeChatId(value) {
  const normalized = String(value || "").trim();
  return CHAT_ID.test(normalized) ? normalized : "";
}

export async function hashChatValue(value) {
  const input = typeof value === "string" ? value : JSON.stringify(value);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function claimChatRequest(db, {
  requestId,
  sessionId,
  profileId = null,
  requestHash,
  now = new Date(),
  requestDays = DEFAULT_REQUEST_DAYS,
}) {
  const at = iso(now);
  const expiresAt = addDays(now, requestDays);
  await ensureSession(db, {
    sessionId,
    profileId,
    title: "新研究会话",
    now,
    sessionDays: DEFAULT_SESSION_DAYS,
  });
  const result = await db.prepare(
    `INSERT INTO chat_requests (
       request_id, session_id, profile_id, request_hash, status,
       response_json, context_hash, created_at, updated_at, expires_at
     ) VALUES (?, ?, ?, ?, 'processing', NULL, NULL, ?, ?, ?)
     ON CONFLICT(request_id) DO NOTHING`,
  ).bind(
    requestId,
    sessionId,
    profileId || null,
    requestHash,
    at,
    at,
    expiresAt,
  ).run();
  if (changes(result) === 1) return { state: "claimed" };

  const existing = await db.prepare(
    `SELECT request_id, session_id, profile_id, request_hash, status,
            response_json, context_hash, updated_at, expires_at
     FROM chat_requests WHERE request_id = ?`,
  ).bind(requestId).first();
  if (!existing) return { state: "unavailable" };
  if (
    existing.request_hash !== requestHash ||
    existing.session_id !== sessionId ||
    (existing.profile_id || null) !== (profileId || null)
  ) {
    return { state: "conflict" };
  }
  if (existing.status === "completed") {
    return {
      state: "completed",
      response: safeJson(existing.response_json, {}),
      contextHash: existing.context_hash || null,
      updatedAt: existing.updated_at,
    };
  }
  if (existing.status === "failed") {
    return {
      state: "failed",
      response: safeJson(existing.response_json, {}),
      updatedAt: existing.updated_at,
    };
  }
  return { state: "processing", updatedAt: existing.updated_at };
}

async function ensureSession(db, {
  sessionId,
  profileId,
  title,
  now,
  sessionDays,
}) {
  const at = iso(now);
  await db.prepare(
    `INSERT INTO chat_sessions (id, profile_id, title, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       profile_id = excluded.profile_id,
       title = CASE
         WHEN chat_sessions.title IS NULL OR chat_sessions.title = '' OR chat_sessions.title = '新研究会话'
         THEN excluded.title
         ELSE chat_sessions.title
       END,
       updated_at = excluded.updated_at,
       expires_at = excluded.expires_at`,
  ).bind(
    sessionId,
    profileId || null,
    String(title || "新研究会话").slice(0, 120),
    at,
    at,
    addDays(now, sessionDays),
  ).run();
}

export async function completeChatRequest(db, {
  requestId,
  sessionId,
  profileId = null,
  title,
  question,
  answer,
  contextHash = null,
  response,
  now = new Date(),
  sessionDays = DEFAULT_SESSION_DAYS,
  requestDays = DEFAULT_REQUEST_DAYS,
}) {
  const at = iso(now);
  const messageExpiresAt = addDays(now, sessionDays);
  await ensureSession(db, { sessionId, profileId, title, now, sessionDays });
  await db.prepare(
    `INSERT INTO chat_messages (id, session_id, role, content, created_at, expires_at)
     VALUES (?, ?, 'user', ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(`${requestId}:user`, sessionId, String(question), at, messageExpiresAt).run();
  await db.prepare(
    `INSERT INTO chat_messages (id, session_id, role, content, created_at, expires_at)
     VALUES (?, ?, 'assistant', ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(
    `${requestId}:assistant`,
    sessionId,
    String(answer),
    new Date(now.valueOf() + 1).toISOString(),
    messageExpiresAt,
  ).run();
  const result = await db.prepare(
    `UPDATE chat_requests
     SET status = 'completed', response_json = ?, context_hash = ?,
         updated_at = ?, expires_at = ?
     WHERE request_id = ? AND status = 'processing'`,
  ).bind(
    JSON.stringify(response || {}),
    contextHash || null,
    at,
    addDays(now, requestDays),
    requestId,
  ).run();
  return changes(result) === 1;
}

export async function failChatRequest(db, {
  requestId,
  response,
  now = new Date(),
  requestDays = DEFAULT_REQUEST_DAYS,
}) {
  const result = await db.prepare(
    `UPDATE chat_requests
     SET status = 'failed', response_json = ?, updated_at = ?, expires_at = ?
     WHERE request_id = ? AND status = 'processing'`,
  ).bind(
    JSON.stringify(response || {}),
    iso(now),
    addDays(now, requestDays),
    requestId,
  ).run();
  return changes(result) === 1;
}

export async function getChatSession(db, sessionId, now = new Date(), limit = 80) {
  const at = iso(now);
  const session = await db.prepare(
    `SELECT id, profile_id, title, created_at, updated_at, expires_at
     FROM chat_sessions
     WHERE id = ? AND expires_at > ?`,
  ).bind(sessionId, at).first();
  if (!session) return null;
  const result = await db.prepare(
    `SELECT id, role, content, created_at
     FROM chat_messages
     WHERE session_id = ? AND expires_at > ?
     ORDER BY created_at ASC LIMIT ?`,
  ).bind(sessionId, at, Math.max(1, Math.min(200, Math.trunc(limit)))).all();
  return {
    id: session.id,
    profileId: session.profile_id || null,
    title: session.title || "新研究会话",
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    messages: (result?.results || []).map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      at: message.created_at,
    })),
  };
}

export async function deleteChatSession(db, sessionId) {
  await db.prepare("DELETE FROM chat_messages WHERE session_id = ?").bind(sessionId).run();
  await db.prepare("DELETE FROM chat_requests WHERE session_id = ?").bind(sessionId).run();
  const result = await db.prepare("DELETE FROM chat_sessions WHERE id = ?").bind(sessionId).run();
  return changes(result) > 0;
}
