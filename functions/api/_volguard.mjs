export const DEFAULT_LIVE_URL = "https://sh50-volguard.pages.dev/api/live";
export const DEFAULT_SNAPSHOT_URL = "https://sh50-volguard.pages.dev/data/latest.json";

function safeStatus(response) {
  return Number.isInteger(response?.status) ? response.status : 0;
}

async function requestJson(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  cacheSeconds = 15,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      cf: { cacheTtl: cacheSeconds, cacheEverything: true },
    });
    if (!response.ok) {
      return { ok: false, status: safeStatus(response), error: `upstream ${safeStatus(response)}` };
    }

    try {
      const data = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return { ok: false, status: safeStatus(response), error: "invalid payload" };
      }
      return { ok: true, status: safeStatus(response), data };
    } catch {
      return { ok: false, status: safeStatus(response), error: "invalid json" };
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error?.name === "AbortError" ? "timeout" : "unreachable",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadVolguardData({
  liveUrl = DEFAULT_LIVE_URL,
  snapshotUrl = DEFAULT_SNAPSHOT_URL,
  fetchImpl = globalThis.fetch,
  liveTimeoutMs = 8000,
  snapshotTimeoutMs = 6000,
} = {}) {
  const live = await requestJson(liveUrl, {
    fetchImpl,
    timeoutMs: liveTimeoutMs,
    cacheSeconds: 15,
  });
  if (live.ok) {
    return { ok: true, mode: "live", data: live.data, attempts: { live: live.status } };
  }

  const snapshot = await requestJson(snapshotUrl, {
    fetchImpl,
    timeoutMs: snapshotTimeoutMs,
    cacheSeconds: 120,
  });
  if (snapshot.ok) {
    return {
      ok: true,
      mode: "snapshot",
      data: snapshot.data,
      attempts: { live: live.status, snapshot: snapshot.status },
      fallback_reason: live.error,
    };
  }

  return {
    ok: false,
    mode: "unavailable",
    attempts: { live: live.status, snapshot: snapshot.status },
    errors: { live: live.error, snapshot: snapshot.error },
  };
}
