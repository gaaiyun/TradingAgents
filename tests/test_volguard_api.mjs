import assert from "node:assert/strict";
import test from "node:test";

import { loadVolguardData } from "../functions/api/_volguard.mjs";

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("uses the realtime payload when the live endpoint is healthy", async () => {
  const requested = [];
  const result = await loadVolguardData({
    liveUrl: "https://example.test/live",
    snapshotUrl: "https://example.test/snapshot",
    fetchImpl: async (url) => {
      requested.push(url);
      return reply({ schema_version: 2, source_status: { overall: "market_closed" } });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "live");
  assert.equal(result.data.schema_version, 2);
  assert.deepEqual(requested, ["https://example.test/live"]);
});

test("falls back to the snapshot and records why realtime failed", async () => {
  const result = await loadVolguardData({
    liveUrl: "https://example.test/live",
    snapshotUrl: "https://example.test/snapshot",
    fetchImpl: async (url) =>
      url.endsWith("/live")
        ? reply({ error: "not deployed" }, 404)
        : reply({ schema_version: 1, generated_at: "2026-07-22T16:39:46+08:00" }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "snapshot");
  assert.equal(result.fallback_reason, "upstream 404");
  assert.equal(result.data.schema_version, 1);
});

test("returns stable diagnostics when both upstreams fail", async () => {
  const result = await loadVolguardData({
    fetchImpl: async () => reply({ error: "down" }, 503),
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "unavailable");
  assert.deepEqual(result.attempts, { live: 503, snapshot: 503 });
  assert.deepEqual(result.errors, { live: "upstream 503", snapshot: "upstream 503" });
});
