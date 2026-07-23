PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workbench_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_bars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  profile_id TEXT NOT NULL DEFAULT '',
  timeframe TEXT NOT NULL,
  ts TEXT NOT NULL,
  open REAL,
  high REAL,
  low REAL,
  close REAL,
  volume REAL,
  source TEXT NOT NULL,
  as_of TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  freshness TEXT NOT NULL,
  adjustment TEXT NOT NULL DEFAULT 'none',
  quality TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (profile_id, symbol, timeframe, ts, source, adjustment)
);

CREATE INDEX IF NOT EXISTS idx_market_bars_symbol_timeframe_ts
  ON market_bars (symbol, timeframe, ts DESC);
CREATE INDEX IF NOT EXISTS idx_market_bars_profile_ts
  ON market_bars (profile_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_market_bars_expires_at
  ON market_bars (expires_at);

CREATE TABLE IF NOT EXISTS news_items (
  id TEXT PRIMARY KEY,
  symbol TEXT,
  profile_id TEXT,
  topic TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  url TEXT,
  published_at TEXT NOT NULL,
  source TEXT NOT NULL,
  as_of TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  freshness TEXT NOT NULL,
  adjustment TEXT,
  quality TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_news_items_symbol_published_at
  ON news_items (symbol, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_items_profile_topic_published_at
  ON news_items (profile_id, topic, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_items_expires_at
  ON news_items (expires_at);

CREATE TABLE IF NOT EXISTS market_events (
  id TEXT PRIMARY KEY,
  symbol TEXT,
  profile_id TEXT,
  topic TEXT,
  importance TEXT NOT NULL,
  event_at TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL,
  as_of TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  freshness TEXT NOT NULL,
  adjustment TEXT,
  quality TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_market_events_symbol_event_at
  ON market_events (symbol, event_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_events_profile_id_event_at
  ON market_events (profile_id, event_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_events_importance_event_at
  ON market_events (importance, event_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_events_expires_at
  ON market_events (expires_at);

CREATE TABLE IF NOT EXISTS source_health (
  source TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('ok', 'degraded', 'stale', 'unavailable')),
  as_of TEXT,
  fetched_at TEXT,
  freshness TEXT,
  adjustment TEXT,
  quality TEXT,
  detail TEXT,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_health_status_as_of
  ON source_health (status, as_of DESC);
CREATE INDEX IF NOT EXISTS idx_source_health_expires_at
  ON source_health (expires_at);

CREATE TABLE IF NOT EXISTS scheduled_slots (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  slot_type TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL,
  claimed_at TEXT,
  completed_at TEXT,
  expires_at TEXT NOT NULL,
  UNIQUE (profile_id, slot_type, scheduled_for)
);

CREATE INDEX IF NOT EXISTS idx_scheduled_slots_profile_time
  ON scheduled_slots (profile_id, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_slots_status_time
  ON scheduled_slots (status, scheduled_for);

CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  symbol TEXT,
  slot_id TEXT,
  run_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  summary_json TEXT,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (slot_id) REFERENCES scheduled_slots(id)
);

CREATE INDEX IF NOT EXISTS idx_research_runs_profile_started_at
  ON research_runs (profile_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_runs_symbol_started_at
  ON research_runs (symbol, started_at DESC);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  profile_id TEXT,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_profile_updated_at
  ON chat_sessions (profile_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created_at
  ON chat_messages (session_id, created_at);
