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
  updateWorkbenchFullAnalysisTargets,
} from "./_workbench_settings.mjs";

// GET /api/settings -> main 分支上的每日分析清单。
export async function onRequestGet() {
  return proxyRaw("data/workbench-settings.json", { cacheSeconds: 5 });
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

  let currentSettings = body.settings;
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
  try {
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

  if (!env.GITHUB_DISPATCH_TOKEN) {
    return json({ error: "服务端未配置 GITHUB_DISPATCH_TOKEN" }, 500);
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

  const responseSettings = { ...settings, tickers: settings.tickers };
  return json(
    { ok: true, settings: responseSettings, message: "清单更新已受理，通常会在一分钟内生效" },
    202,
  );
}
