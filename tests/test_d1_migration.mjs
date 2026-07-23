import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migrationUrl = new URL("../migrations/0001_workbench_dynamic.sql", import.meta.url);

test("D1 migration defines every dynamic workbench table and its lookup indexes", () => {
  const sql = readFileSync(migrationUrl, "utf8");
  const tables = [
    "workbench_settings",
    "market_bars",
    "news_items",
    "market_events",
    "source_health",
    "scheduled_slots",
    "research_runs",
    "chat_sessions",
    "chat_messages",
  ];

  for (const table of tables) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "i"));
  }

  assert.match(sql, /UNIQUE\s*\(\s*symbol\s*,\s*timeframe\s*,\s*ts\s*,\s*source\s*,\s*adjustment\s*\)/i);
  assert.match(sql, /CREATE INDEX[^;]+market_bars[^;]+symbol[^;]+timeframe[^;]+ts/i);
  assert.match(sql, /CREATE INDEX[^;]+news_items[^;]+symbol[^;]+published_at/i);
  assert.match(sql, /CREATE INDEX[^;]+market_events[^;]+profile_id[^;]+event_at/i);
  assert.match(sql, /(?:expires_at|retention_until|delete_after)/i);
});

test("D1 migration stores stable source metadata on dynamic records", () => {
  const sql = readFileSync(migrationUrl, "utf8");
  for (const column of ["source", "as_of", "fetched_at", "freshness", "adjustment", "quality"]) {
    assert.match(sql, new RegExp(`\\b${column}\\b`, "i"));
  }
  assert.match(sql, /workbench_settings[\s\S]+version[\s\S]+updated_at/i);
});
