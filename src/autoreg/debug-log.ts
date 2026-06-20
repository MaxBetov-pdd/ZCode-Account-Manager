/** Structured debug helpers for autoreg captcha/signup (safe to show in job logs). */

export interface CaptchaParamInfo {
  length: number;
  format: "json" | "json-invalid" | "jwt-like" | "opaque";
  prefix: string;
  suffix: string;
  json_keys?: string[];
}

export function describeCaptchaParam(param: string): CaptchaParamInfo {
  const trimmed = param.trim();
  let format: CaptchaParamInfo["format"] = "opaque";
  let json_keys: string[] | undefined;

  if (trimmed.startsWith("{")) {
    format = "json";
    try {
      json_keys = Object.keys(JSON.parse(trimmed) as object);
    } catch {
      format = "json-invalid";
    }
  } else if (/^eyJ[A-Za-z0-9_-]/.test(trimmed)) {
    format = "jwt-like";
  }

  return {
    length: trimmed.length,
    format,
    prefix: trimmed.slice(0, 48),
    suffix: trimmed.slice(-16),
    json_keys,
  };
}

export function formatCaptchaParamSummary(param: string): string {
  const d = describeCaptchaParam(param);
  const keys = d.json_keys?.join(",") ?? "—";
  return `${d.format} len=${d.length} keys=[${keys}] head=${JSON.stringify(d.prefix)}`;
}

export interface SignupHttpInfo {
  status: number;
  ok: boolean;
  success?: boolean;
  detail?: string;
  bodyPreview: string;
}

export function describeSignupHttpResult(result: {
  status: number;
  ok: boolean;
  body: string;
}): SignupHttpInfo {
  let detail: string | undefined;
  let success: boolean | undefined;
  try {
    const d = JSON.parse(result.body) as {
      detail?: string;
      message?: string;
      success?: boolean;
    };
    detail = d.detail ?? d.message;
    success = d.success;
  } catch {
    detail = result.body.slice(0, 200) || undefined;
  }
  return {
    status: result.status,
    ok: result.ok,
    success,
    detail,
    bodyPreview: result.body.slice(0, 500),
  };
}

export function formatSignupFailureSummary(result: {
  status: number;
  body: string;
  ok?: boolean;
}): string {
  const d = describeSignupHttpResult({
    status: result.status,
    ok: result.ok ?? false,
    body: result.body,
  });
  if (d.detail) return `HTTP ${d.status}: ${d.detail}`;
  if (d.bodyPreview) return `HTTP ${d.status}: ${d.bodyPreview.slice(0, 280)}`;
  return `HTTP ${d.status} (empty body)`;
}

export function isCaptchaRelatedSignupError(status: number, body: string): boolean {
  const lower = body.toLowerCase();
  if (lower.includes("captcha")) return true;
  if (lower.includes("verify_param") || lower.includes("verify param")) return true;
  if (lower.includes("slider") || lower.includes("aliyun")) return true;
  // Bare 400 with no parseable detail — often captcha/IP binding on this API.
  if (status === 400 && body.trim().length < 80) return true;
  return false;
}
