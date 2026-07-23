import assert from "node:assert/strict";
import test from "node:test";

import { onRequestPost as analyze } from "../functions/api/analyze.js";
import { onRequestPost as saveSettings } from "../functions/api/settings.js";

const env = {
  ACCESS_CODE: "correct-code",
  GITHUB_DISPATCH_TOKEN: "dispatch-token",
};

function post(body, code = "correct-code") {
  return new Request("https://workbench.test/api/action", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(code === null ? {} : { "x-access-code": code }),
    },
    body,
  });
}

test("manual analysis normalizes the same ticker contract used by saved tasks", async () => {
  const originalFetch = globalThis.fetch;
  let dispatch;
  globalThis.fetch = async (_url, init) => {
    dispatch = JSON.parse(init.body);
    return new Response(null, { status: 204 });
  };
  try {
    const response = await analyze({
      request: post(JSON.stringify({ tickers: "nvda, 600519,BRK.B" })),
      env,
    });
    const payload = await response.json();
    assert.equal(response.status, 202);
    assert.deepEqual(payload.tickers, ["NVDA", "600519.SS", "BRK-B"]);
    assert.equal(dispatch.inputs.tickers, "NVDA,600519.SS,BRK-B");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an invalid access header is rejected before parsing a malformed body", async () => {
  const response = await analyze({ request: post("{not-json", "wrong"), env });
  assert.equal(response.status, 401);
});

test("settings and analysis reject oversized request bodies", async () => {
  const body = JSON.stringify({ tickers: ["NVDA"], padding: "x".repeat(17 * 1024) });
  const [analysisResponse, settingsResponse] = await Promise.all([
    analyze({ request: post(body), env }),
    saveSettings({ request: post(body), env }),
  ]);
  assert.equal(analysisResponse.status, 413);
  assert.equal(settingsResponse.status, 413);
});

test("saved settings support header authentication without persisting the code", async () => {
  const originalFetch = globalThis.fetch;
  let dispatch;
  globalThis.fetch = async (_url, init) => {
    dispatch = JSON.parse(init.body);
    return new Response(null, { status: 204 });
  };
  try {
    const response = await saveSettings({
      request: post(JSON.stringify({ tickers: ["spy", "000001"] })),
      env,
    });
    const payload = await response.json();
    assert.equal(response.status, 202);
    assert.deepEqual(payload.settings.tickers, ["SPY", "000001.SZ"]);
    assert.equal(dispatch.inputs.tickers_json, '["SPY","000001.SZ"]');
    assert.equal(JSON.stringify(dispatch).includes("correct-code"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
