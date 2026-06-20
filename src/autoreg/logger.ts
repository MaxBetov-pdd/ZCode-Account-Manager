import type { AutoregJob, JobLog, LogLevel } from "./types.js";

export function jobLog(
  job: AutoregJob,
  level: LogLevel,
  step: string,
  message: string,
  data?: unknown
): void {
  const entry: JobLog = {
    ts: new Date().toISOString(),
    level,
    step,
    message,
  };
  if (data !== undefined) {
    entry.data =
      typeof data === "object" && data !== null
        ? sanitizeForLog(data as Record<string, unknown>)
        : data;
  }
  job.logs.push(entry);
  if (job.logs.length > 200) job.logs.shift();
  job.updated_at = entry.ts;
}

const REDACT_EXACT = new Set([
  "password",
  "secret",
  "api_key",
  "access_token",
  "refresh_token",
  "token",
]);

function shouldRedactLogKey(key: string): boolean {
  const k = key.toLowerCase();
  if (REDACT_EXACT.has(k)) return true;
  if (k.includes("password") || k.includes("secret") || k === "api_key") return true;
  // Do not redact captcha_verify_param — needed for autoreg debug (prefix only in messages).
  return false;
}

function sanitizeForLog(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (shouldRedactLogKey(k)) {
      out[k] = typeof v === "string" ? maskSecret(v) : "[redacted]";
    } else if (k === "profile_image_url") {
      out[k] = "[base64 image]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

function maskSecret(s: string): string {
  if (s.length <= 12) return "***";
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}
