import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as settingsApi from "../functions/api/settings.js";
import { FakeD1 } from "./helpers/fake_d1.mjs";

const staticSettings = JSON.parse(
  readFileSync(new URL("../public/data/workbench-settings.json", import.meta.url), "utf8"),
);

function put(body, code = "correct-code") {
  return new Request("https://workbench.test/api/settings", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-access-code": code,
    },
    body: JSON.stringify(body),
  });
}

test("PUT persists v1 settings in D1 and GET reads the normalized value immediately", async () => {
  assert.equal(typeof settingsApi.onRequestPut, "function");
  const DB = new FakeD1();
  const env = { DB, ACCESS_CODE: "correct-code" };

  const saved = await settingsApi.onRequestPut({
    request: put({ settings: { version: 1, tickers: ["spy", "600519"] } }),
    env,
  });
  const savePayload = await saved.json();
  const loaded = await settingsApi.onRequestGet({ env });
  const loadPayload = await loaded.json();

  assert.equal(saved.status, 200);
  assert.equal(savePayload.ok, true);
  assert.equal(savePayload.settings.version, 2);
  assert.deepEqual(savePayload.settings.tickers, ["SPY", "600519.SS"]);
  assert.equal(loaded.status, 200);
  assert.equal(loadPayload.version, 2);
  assert.deepEqual(
    loadPayload.profiles[0].targets.map(({ symbol }) => symbol),
    ["SPY", "600519.SS"],
  );
  assert.equal(DB.calls.some(({ sql }) => /INSERT\s+INTO\s+workbench_settings/i.test(sql)), true);
  assert.equal(JSON.stringify(DB.calls).includes("correct-code"), false);
});

test("GET falls back to the static GitHub settings when D1 is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return Response.json(staticSettings);
  };
  try {
    const response = await settingsApi.onRequestGet({ env: { DB: new FakeD1({ fail: true }) } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), staticSettings);
    assert.match(requestedUrl, /data\/workbench-settings\.json/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PUT falls back to the existing GitHub persistence path when D1 is absent", async () => {
  const originalFetch = globalThis.fetch;
  let dispatchBody;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("raw.githubusercontent.com")) return Response.json(staticSettings);
    dispatchBody = JSON.parse(init.body);
    return new Response(null, { status: 204 });
  };
  try {
    const response = await settingsApi.onRequestPut({
      request: put({ settings: { version: 1, tickers: ["nvda"] } }),
      env: {
        ACCESS_CODE: "correct-code",
        GITHUB_DISPATCH_TOKEN: "dispatch-token",
      },
    });
    assert.equal(response.status, 202);
    assert.equal(JSON.parse(dispatchBody.inputs.settings_json).version, 2);
    assert.equal(JSON.stringify(dispatchBody).includes("correct-code"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
