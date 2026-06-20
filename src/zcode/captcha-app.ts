/** Fetch fresh Aliyun captcha param from running ZCode app (local HTTP). */

const DEFAULT_CAPTCHA_APP_URL = "http://127.0.0.1:9999/get-captcha";

export function zcodeCaptchaAppUrl(): string {
  return process.env.ZCODE_CAPTCHA_URL?.trim() || DEFAULT_CAPTCHA_APP_URL;
}

function extractCaptchaParam(data: unknown): string | null {
  if (typeof data === "string") {
    const t = data.trim();
    if (t.length > 20 && !t.startsWith("{")) return t;
    return null;
  }
  if (!data || typeof data !== "object") return null;

  const o = data as Record<string, unknown>;
  for (const key of [
    "param",
    "token",
    "captchaVerifyParam",
    "captcha_verify_param",
    "verifyParam",
    "X-Aliyun-Captcha-Verify-Param",
    "x-aliyun-captcha-verify-param",
  ]) {
    const v = o[key];
    if (typeof v === "string" && v.trim().length > 20) return v.trim();
  }

  if (o.data) return extractCaptchaParam(o.data);
  if (o.headers) return extractCaptchaParam(o.headers);
  return null;
}

export async function fetchCaptchaFromZcodeApp(opts?: {
  url?: string;
  timeoutMs?: number;
}): Promise<string> {
  const url = opts?.url ?? zcodeCaptchaAppUrl();
  const timeoutMs = opts?.timeoutMs ?? 130_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: ac.signal });
    const text = (await res.text()).trim();
    if (!res.ok) {
      throw new Error(`ZCode captcha app HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    let param: string | null = null;
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        param = extractCaptchaParam(JSON.parse(text));
      } catch {
        /* plain text */
      }
    }
    param ??= extractCaptchaParam(text);
    if (!param || param.length < 20) {
      throw new Error(
        `ZCode captcha app: invalid param (${text.slice(0, 80) || "empty"})`
      );
    }
    return param;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`ZCode captcha app timeout (${timeoutMs}ms): ${url}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("fetch failed") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("ECONNRESET")
    ) {
      throw new Error(
        `ZCode captcha app недоступен (${url}). Убедись, что ZCode запущен.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
