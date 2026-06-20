import crypto from "node:crypto";
import {
  ZCODE_APP_VERSION,
  ZCODE_CAPTCHA_REGION,
  ZCODE_PLATFORM,
} from "./constants.js";

export interface ZcodeRequestHeadersInput {
  jwt: string;
  captchaVerifyParam?: string | null;
  sessionId?: string | null;
  traceId?: string | null;
  stream?: boolean;
}

export function newZcodeTraceId(): string {
  return crypto.randomUUID();
}

export function newZcodeSessionId(): string {
  return crypto.randomUUID();
}

/** Headers matching ZCode editor requests to zcode-plan/anthropic (traffic capture). */
export function buildZcodeAnthropicHeaders(
  input: ZcodeRequestHeadersInput
): Record<string, string> {
  const requestId = crypto.randomUUID();
  const sessionId = input.sessionId || newZcodeSessionId();
  const traceId = input.traceId || newZcodeTraceId();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    Authorization: `Bearer ${input.jwt}`,
    "http-referer": "https://zcode.z.ai",
    "HTTP-Referer": "https://zcode.z.ai",
    "User-Agent": `ZCode/${ZCODE_APP_VERSION}`,
    "X-ZCode-App-Version": ZCODE_APP_VERSION,
    "X-Title": "Z Code@electron",
    "x-title": "Z Code@electron",
    "X-ZCode-Agent": "glm",
    "x-client-language": process.env.ZCODE_CLIENT_LANGUAGE || "en-US",
    "x-client-timezone":
      process.env.ZCODE_CLIENT_TIMEZONE ||
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      "UTC",
    "x-os-category": "windows",
    "x-os-version": process.env.ZCODE_OS_VERSION || "Windows 11",
    "x-platform": ZCODE_PLATFORM,
    "x-release-channel": "production",
    "x-request-id": requestId,
    "x-zcode-trace-id": traceId,
    "x-query-id": crypto.randomUUID(),
    "x-session-id": sessionId,
  };

  if (input.captchaVerifyParam?.trim()) {
    headers["X-Aliyun-Captcha-Verify-Param"] = input.captchaVerifyParam.trim();
    headers["X-Aliyun-Captcha-Verify-Region"] = ZCODE_CAPTCHA_REGION;
  }

  return headers;
}

/** Billing / quota — no x-api-key (matches ZCode host.fetch capture). */
export function buildZcodeBillingHeaders(jwt: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${jwt}`,
    "http-referer": "https://zcode.z.ai",
    "HTTP-Referer": "https://zcode.z.ai",
    "User-Agent": `ZCode/${ZCODE_APP_VERSION}`,
    "x-zcode-app-version": ZCODE_APP_VERSION,
    "x-title": "Z Code@electron",
    "x-client-language": process.env.ZCODE_CLIENT_LANGUAGE || "en-US",
    "x-platform": ZCODE_PLATFORM,
    "x-release-channel": "production",
  };
}
