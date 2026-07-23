export const WORKBENCH_SETTINGS_VERSION = 1;
export const MAX_WORKBENCH_TICKERS = 10;

const A_SHARE = /^(\d{6})(?:\.(SS|SH|SZ))?$/;
const US_EQUITY = /^([A-Z]{1,5})(?:[.-]([A-Z]))?$/;

export class WorkbenchSettingsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkbenchSettingsError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new WorkbenchSettingsError(code, message);
}

/**
 * Normalize one supported equity symbol.
 *
 * A-share bare codes are mapped to Yahoo Finance suffixes. US class-share
 * separators are normalized to the Yahoo-compatible dash form (BRK.B -> BRK-B).
 */
export function normalizeWorkbenchTicker(raw) {
  if (typeof raw !== "string") {
    fail("INVALID_TICKER", "标的代码必须是字符串");
  }

  const ticker = raw.trim().toUpperCase();
  if (!ticker) {
    fail("INVALID_TICKER", "标的代码不能为空");
  }

  const aShare = A_SHARE.exec(ticker);
  if (aShare) {
    const [, code, rawExchange] = aShare;
    let expectedExchange = null;
    if ("569".includes(code[0])) expectedExchange = "SS";
    if ("0123".includes(code[0])) expectedExchange = "SZ";
    if (!expectedExchange) {
      fail("INVALID_TICKER", `不支持的 A 股代码：${ticker}`);
    }

    const exchange = rawExchange === "SH" ? "SS" : rawExchange;
    if (exchange && exchange !== expectedExchange) {
      fail("INVALID_TICKER", `A 股代码与交易所后缀不匹配：${ticker}`);
    }
    return `${code}.${expectedExchange}`;
  }

  const usEquity = US_EQUITY.exec(ticker);
  if (usEquity) {
    const [, root, shareClass] = usEquity;
    return shareClass ? `${root}-${shareClass}` : root;
  }

  fail("INVALID_TICKER", `仅支持 A 股或美股代码：${ticker}`);
}

function tickerItems(input) {
  if (typeof input === "string") {
    return input.split(/[,，\s]+/).filter(Boolean);
  }
  if (Array.isArray(input)) {
    return input;
  }
  fail("INVALID_TICKERS_TYPE", "tickers 必须是代码数组或逗号分隔字符串");
}

/** Normalize, de-duplicate in first-seen order, and enforce the saved-list cap. */
export function normalizeWorkbenchTickers(input) {
  const items = tickerItems(input);
  if (items.length === 0) {
    fail("EMPTY_TICKERS", "每日分析清单不能为空");
  }

  const seen = new Set();
  const tickers = [];
  for (const item of items) {
    const ticker = normalizeWorkbenchTicker(item);
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    tickers.push(ticker);
    if (tickers.length > MAX_WORKBENCH_TICKERS) {
      fail("TOO_MANY_TICKERS", `每日分析清单最多 ${MAX_WORKBENCH_TICKERS} 个标的`);
    }
  }
  return tickers;
}

export function buildWorkbenchSettings(input) {
  return {
    version: WORKBENCH_SETTINGS_VERSION,
    tickers: normalizeWorkbenchTickers(input),
  };
}

export function parseWorkbenchSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_SETTINGS", "设置文件必须是 JSON 对象");
  }
  if (value.version !== WORKBENCH_SETTINGS_VERSION) {
    fail("UNSUPPORTED_SETTINGS_VERSION", `不支持的设置版本：${String(value.version)}`);
  }
  return buildWorkbenchSettings(value.tickers);
}
