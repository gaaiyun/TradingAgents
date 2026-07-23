CREATE TABLE IF NOT EXISTS chat_requests (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  profile_id TEXT,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  response_json TEXT,
  context_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_requests_session_id_updated_at
  ON chat_requests (session_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_requests_expires_at
  ON chat_requests (expires_at);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_expires_at
  ON chat_sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_expires_at
  ON chat_messages (expires_at);
