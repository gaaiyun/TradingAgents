import {
  REPO,
  RequestBodyTooLargeError,
  gate,
  ghHeaders,
  json,
  proxyRaw,
  readJsonBody,
} from "./_util.js";
import {
  WorkbenchSettingsError,
  parseWorkbenchSettings,
  updateWorkbenchFullAnalysisTargets,
} from "./_workbench_settings.mjs";
import {
  d1Binding,
  readSettingsFromD1,
  SettingsConflictError,
  writeSettingsToD1,
} from "./_d1_repository.mjs";

// GET /api/settings -> D1 中即时生效的设置；不可用时回退到静态/GitHub 快照。
export async function onRequestGet({ env } = {}) {
  const db = d1Binding(env);
  if (db) {
    try {
      const stored = await readSettingsFromD1(db);
      if (stored) return json({
        ...parseWorkbenchSettings(stored.settings),
        updatedAt: stored.updatedAt,
      });
    } catch {
      // D1 故障或数据损坏不应使设置页不可用。
    }
  }
  return proxyRaw("data/workbench-settings.json", { cacheSeconds: 5 });
}

function settingsResponse(settings) {
  return { ...settings, tickers: settings.tickers };
}

function expectedRevision(body, stored) {
  if (!Object.prototype.hasOwnProperty.call(body, "expectedUpdatedAt")) {
    return stored?.updatedAt ?? null;
  }
  const value = body.expectedUpdatedAt;
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || Number.isNaN(new Date(value).valueOf())) {
    throw new WorkbenchSettingsError(
      "INVALID_EXPECTED_UPDATED_AT",
      "expectedUpdatedAt 必须是 ISO 时间或 null",
    );
  }
  return value;
}

function storageFailure() {
  return json(
    { error: "设置存储暂不可用", error_code: "SETTINGS_STORAGE_UNAVAILABLE" },
    503,
  );
}

async function saveToD1(db, settings, expectedUpdatedAt) {
  try {
    const updatedAt = await writeSettingsToD1(db, settings, expectedUpdatedAt);
    return json({
      ok: true,
      settings: settingsResponse(settings),
      updatedAt,
      message: "设置已保存并即时生效",
    });
  } catch (error) {
    if (error instanceof SettingsConflictError) {
      return json(
        { error: "设置已被其他请求更新，请刷新后重试", error_code: "SETTINGS_CONFLICT" },
        409,
      );
    }
    return storageFailure();
  }
}

async function dispatchSettings(env, settings, { legacy = false } = {}) {
  if (!env.GITHUB_DISPATCH_TOKEN) {
    if (legacy) return json({ error: "服务端未配置 GITHUB_DISPATCH_TOKEN" }, 500);
    return json(
      { error: "设置存储暂不可用", error_code: "SETTINGS_STORAGE_UNAVAILABLE" },
      503,
    );
  }
  const resp = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/settings-update.yml/dispatches`,
    {
      method: "POST",
      headers: { ...ghHeaders(env), "content-type": "application/json" },
      body: JSON.stringify({
        ref: "main",
        inputs: { settings_json: JSON.stringify(settings) },
      }),
    },
  );
  if (resp.status !== 204) {
    const detail = await resp.text();
    return json(
      { error: `GitHub dispatch 失败 (${resp.status})`, detail: detail.slice(0, 300) },
      502,
    );
  }
  return json(
    { ok: true, settings: settingsResponse(settings), message: "清单更新已受理，通常会在一分钟内生效" },
    202,
  );
}

// PUT /api/settings -> 以 D1 为即时主存储，同时接受 v1/v2 设置。
export async function onRequestPut({ request, env }) {
  const headerCode = request.headers.get("x-access-code");
  if (!gate(env, headerCode)) return json({ error: "访问码不正确" }, 401);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return json({ error: "请求体过大" }, 413);
    }
    throw error;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "请求体不是合法 JSON 对象" }, 400);
  }

  const db = d1Binding(env);
  let stored = null;
  if (db) {
    try {
      stored = await readSettingsFromD1(db);
    } catch {
      return storageFailure();
    }
  }

  let settings;
  let expectedUpdatedAt;
  try {
    expectedUpdatedAt = expectedRevision(body, stored);
    const current = body.settings ?? stored?.settings ?? body;
    settings = body.tickers === undefined
      ? parseWorkbenchSettings(current)
      : updateWorkbenchFullAnalysisTargets(current, body.tickers);
  } catch (error) {
    if (error instanceof WorkbenchSettingsError) {
      return json({ error: error.message, error_code: error.code }, 400);
    }
    throw error;
  }

  if (db) {
    return saveToD1(db, settings, expectedUpdatedAt);
  }
  return dispatchSettings(env, settings);
}

// POST /api/settings {code, tickers, settings?} -> 校验后异步触发持久化工作流。
export async function onRequestPost({ request, env }) {
  const headerCode = request.headers.get("x-access-code");
  if (headerCode !== null && !gate(env, headerCode)) {
    return json({ error: "访问码不正确" }, 401);
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return json({ error: "请求体过大" }, 413);
    }
    throw error;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "请求体不是合法 JSON 对象" }, 400);
  }
  if (!gate(env, headerCode ?? body.code)) return json({ error: "访问码不正确" }, 401);

  const db = d1Binding(env);
  let stored = null;
  if (db) {
    try {
      stored = await readSettingsFromD1(db);
    } catch {
      return storageFailure();
    }
  }

  const hasExpectedRevision = Object.prototype.hasOwnProperty.call(body, "expectedUpdatedAt");
  let currentSettings = hasExpectedRevision
    ? body.settings ?? stored?.settings
    : stored?.settings ?? body.settings;
  const loadedCurrentSettings = !currentSettings;
  if (loadedCurrentSettings) {
    let currentResponse;
    try {
      currentResponse = await proxyRaw("data/workbench-settings.json", { cacheSeconds: 5 });
    } catch {
      return json(
        { error: "无法读取当前工作台设置", error_code: "CURRENT_SETTINGS_UNAVAILABLE" },
        502,
      );
    }
    if (!currentResponse.ok) {
      return json(
        { error: "无法读取当前工作台设置", error_code: "CURRENT_SETTINGS_UNAVAILABLE" },
        502,
      );
    }
    try {
      currentSettings = await currentResponse.json();
    } catch {
      return json(
        { error: "当前工作台设置不是合法 JSON", error_code: "CURRENT_SETTINGS_INVALID" },
        502,
      );
    }
  }

  let settings;
  let expectedUpdatedAt;
  try {
    expectedUpdatedAt = expectedRevision(body, stored);
    settings = updateWorkbenchFullAnalysisTargets(currentSettings, body.tickers);
  } catch (error) {
    if (error instanceof WorkbenchSettingsError) {
      if (loadedCurrentSettings) {
        return json(
          { error: "当前工作台设置无法通过校验", error_code: "CURRENT_SETTINGS_INVALID" },
          502,
        );
      }
      return json({ error: error.message, error_code: error.code }, 400);
    }
    throw error;
  }

  if (db) return saveToD1(db, settings, expectedUpdatedAt);
  return dispatchSettings(env, settings, { legacy: true });
}
