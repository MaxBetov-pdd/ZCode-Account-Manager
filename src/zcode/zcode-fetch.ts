import { fetchWithProxy } from "../proxy-util.js";
import { ZCODE_BASE_URL } from "./constants.js";
import {
  isZcodeLocalProxyConnectionError,
  zcodeLocalProxyUrl,
} from "./zcode-local-proxy.js";

let electronProbe: { at: number; ok: boolean; detail: string } | null = null;
const PROBE_TTL_MS = 5000;

function upstreamMode(): "direct" | "electron" | "auto" {
  const v = (process.env.ZCODE_UPSTREAM || "direct")
    .trim()
    .toLowerCase();
  if (v === "0" || v === "false" || v === "direct") return "direct";
  if (v === "1" || v === "true" || v === "electron") return "electron";
  return "auto";
}

/** GET :9999/get-captcha — ZCode patched app must be running with UI loaded. */
export async function probeZcodeElectronProxy(): Promise<{
  ok: boolean;
  detail: string;
}> {
  const now = Date.now();
  if (electronProbe && now - electronProbe.at < PROBE_TTL_MS) {
    return { ok: electronProbe.ok, detail: electronProbe.detail };
  }

  const base =
    process.env.ZCODE_LOCAL_APP_URL?.trim().replace(/\/$/, "") ||
    "http://127.0.0.1:9999";

  try {
    const res = await fetch(`${base}/get-captcha`, {
      method: "GET",
      signal: AbortSignal.timeout(4000),
    });
    const text = await res.text();
    if (res.ok) {
      electronProbe = { at: now, ok: true, detail: "get-captcha OK" };
      return electronProbe;
    }
    if (text.includes("No active ZCode renderer")) {
      electronProbe = {
        at: now,
        ok: false,
        detail: "ZCode запущен, но UI не загружен — открой главное окно",
      };
      return electronProbe;
    }
    electronProbe = {
      at: now,
      ok: false,
      detail: `get-captcha HTTP ${res.status}: ${text.slice(0, 120)}`,
    };
    return electronProbe;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    electronProbe = {
      at: now,
      ok: false,
      detail: isZcodeLocalProxyConnectionError(err)
        ? "ZCode :9999 недоступен — запусти пропатченный ZCode"
        : msg,
    };
    return electronProbe;
  }
}

export async function shouldUseZcodeElectronProxy(): Promise<boolean> {
  const mode = upstreamMode();
  if (mode === "direct") return false;
  const probe = await probeZcodeElectronProxy();
  if (mode === "electron" && !probe.ok) {
    throw new Error(
      `ZCODE_UPSTREAM=electron но Electron proxy недоступен: ${probe.detail}`
    );
  }
  return probe.ok;
}

export function zcodePlanMessagesPath(): string {
  return "/api/v1/zcode-plan/anthropic/v1/messages";
}

export function zcodeUpstreamUrl(
  upstreamPath: string,
  viaElectron: boolean
): string {
  const path = upstreamPath.startsWith("/") ? upstreamPath : `/${upstreamPath}`;
  if (viaElectron) {
    return zcodeLocalProxyUrl(path);
  }
  return `${ZCODE_BASE_URL}${path}`;
}

/**
 * Chat API is accepted only via ZCode Electron net.fetch (:9999/proxy).
 * Node/Playwright direct POST → 3012 even with valid JWT + captcha.
 */
export async function fetchZcodeUpstream(
  upstreamPath: string,
  init: RequestInit & { proxy?: string | null; forceDirect?: boolean }
): Promise<Response> {
  const { proxy, forceDirect, ...rest } = init;
  const viaElectron = forceDirect ? false : await shouldUseZcodeElectronProxy();
  const url = zcodeUpstreamUrl(upstreamPath, viaElectron);

  if (viaElectron) {
    return fetch(url, rest);
  }

  const res = await fetchWithProxy(url, { ...rest, proxy: proxy ?? null });

  if (
    upstreamMode() === "auto" &&
    !forceDirect &&
    res.status === 405
  ) {
    const text = await res.clone().text();
    if (text.includes("3012") || text.toLowerCase().includes("method not allowed")) {
      const probe = await probeZcodeElectronProxy();
      if (probe.ok) {
        const retryUrl = zcodeUpstreamUrl(upstreamPath, true);
        return fetch(retryUrl, rest);
      }
    }
  }

  return res;
}

export function invalidateElectronProbe(): void {
  electronProbe = null;
}
