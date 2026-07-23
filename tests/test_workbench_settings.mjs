import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkbenchSettingsError,
  buildWorkbenchSettings,
  normalizeWorkbenchTickers,
  parseWorkbenchSettings,
} from "../functions/api/_workbench_settings.mjs";

function assertSettingsError(code, callback) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof WorkbenchSettingsError);
    assert.equal(error.code, code);
    return true;
  });
}

test("normalizes A-share and US symbols while preserving first-seen order", () => {
  assert.deepEqual(
    normalizeWorkbenchTickers(" nvda, 600519.sh，000001  BRK.B nvda "),
    ["NVDA", "600519.SS", "000001.SZ", "BRK-B"],
  );
});

test("builds and parses the versioned settings contract", () => {
  const settings = buildWorkbenchSettings(["spy", "600519.ss"]);
  assert.deepEqual(settings, { version: 1, tickers: ["SPY", "600519.SS"] });
  assert.deepEqual(parseWorkbenchSettings(settings), settings);
});

test("rejects empty, unsupported, and exchange-mismatched symbols", () => {
  assertSettingsError("EMPTY_TICKERS", () => normalizeWorkbenchTickers("  ,， "));
  assertSettingsError("INVALID_TICKER", () => normalizeWorkbenchTickers(["BTC-USD"]));
  assertSettingsError("INVALID_TICKER", () => normalizeWorkbenchTickers(["600519.SZ"]));
  assertSettingsError("INVALID_TICKER", () => normalizeWorkbenchTickers(["0700.HK"]));
});

test("rejects more than ten unique symbols instead of truncating", () => {
  const validEleven = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"];
  assertSettingsError("TOO_MANY_TICKERS", () => normalizeWorkbenchTickers(validEleven));
});

test("rejects unknown schema versions", () => {
  assertSettingsError("UNSUPPORTED_SETTINGS_VERSION", () =>
    parseWorkbenchSettings({ version: 2, tickers: ["SPY"] }),
  );
});
