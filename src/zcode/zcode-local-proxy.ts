/** ZCode patched app: local captcha + Electron net.fetch proxy on :9999 */

const DEFAULT_LOCAL_APP = "http://127.0.0.1:9999";

export function zcodeLocalAppBase(): string {
  const raw = process.env.ZCODE_LOCAL_APP_URL?.trim() || DEFAULT_LOCAL_APP;
  return raw.replace(/\/$/, "");
}

/**
 * POST via ZCode Electron proxy (:9999). Off by default — external /proxy
 * requests can trigger upstream 3012 account blocks. Set ZCODE_LOCAL_PROXY=1 to enable.
 */
export function useZcodeLocalProxy(): boolean {
  const v = process.env.ZCODE_LOCAL_PROXY?.toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  return false;
}

/** `http://127.0.0.1:9999/proxy/api/v1/zcode-plan/anthropic/v1/messages` */
export function zcodeLocalProxyUrl(upstreamPath: string): string {
  const path = upstreamPath.startsWith("/") ? upstreamPath : `/${upstreamPath}`;
  return `${zcodeLocalAppBase()}/proxy${path}`;
}

export function zcodePlanAnthropicMessagesUrl(directBaseUrl: string): string {
  if (!useZcodeLocalProxy()) {
    return `${directBaseUrl.replace(/\/$/, "")}/v1/messages`;
  }
  try {
    const u = new URL(directBaseUrl);
    return zcodeLocalProxyUrl(`${u.pathname}/v1/messages`);
  } catch {
    return zcodeLocalProxyUrl("/api/v1/zcode-plan/anthropic/v1/messages");
  }
}

export function isZcodeLocalProxyConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("fetch failed") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ECONNRESET")
  );
}
