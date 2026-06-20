import { nanoid } from "nanoid";
import {
  Account,
  addAccount,
  clearExpiredRateLimits,
  getSettings,
  listAccounts,
  markAccountError,
  markRateLimited,
  recordError,
  recordSuccess,
  setAccountStatus,
} from "./db.js";

let roundRobinIndex = 0;

function isAvailable(account: Account): boolean {
  if (account.status === "disabled" || account.status === "error") return false;
  if (account.status === "rate_limited" && account.rate_limit_until) {
    if (new Date(account.rate_limit_until) > new Date()) return false;
  }
  return true;
}

export interface ZaiErrorInfo {
  code?: string;
  message: string;
  kind: "balance" | "rate_limit" | "auth" | "other";
}

export function parseZaiError(status: number, bodyText: string): ZaiErrorInfo {
  let code = "";
  let message = bodyText.slice(0, 300);

  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { code?: string | number; message?: string };
      message?: string;
      code?: string | number;
    };
    const err = parsed.error || parsed;
    code = String((err as { code?: string | number }).code ?? parsed.code ?? "");
    message = String(
      (err as { message?: string }).message || parsed.message || message
    );
  } catch {
    /* keep raw text */
  }

  const lower = message.toLowerCase();
  if (
    code === "3012" ||
    (status === 405 && lower.includes("method not allowed"))
  ) {
    return {
      code: code || "3012",
      message: message || "method not allowed (plan blocked or revoked)",
      kind: "auth",
    };
  }
  if (
    code === "1113" ||
    lower.includes("insufficient balance") ||
    lower.includes("resource package") ||
    lower.includes("recharge")
  ) {
    return { code, message, kind: "balance" };
  }
  if (
    status === 429 &&
    (lower.includes("rate") ||
      lower.includes("quota") ||
      lower.includes("limit") ||
      lower.includes("exceeded") ||
      lower.includes("too many"))
  ) {
    return { code, message, kind: "rate_limit" };
  }
  if (status === 401 || status === 403) {
    return { code, message, kind: "auth" };
  }
  return { code, message, kind: "other" };
}

function pickRoundRobin(accounts: Account[]): Account | null {
  const available = accounts.filter(isAvailable);
  if (available.length === 0) return null;
  roundRobinIndex = roundRobinIndex % available.length;
  const picked = available[roundRobinIndex];
  roundRobinIndex = (roundRobinIndex + 1) % available.length;
  return picked;
}

function pickLeastUsed(accounts: Account[]): Account | null {
  const available = accounts.filter(isAvailable);
  if (available.length === 0) return null;
  return available.reduce((a, b) => (a.requests <= b.requests ? a : b));
}

export function pickAccount(
  excludeIds: string[] = [],
  opts?: { kind?: "api_key" | "zcode_jwt" }
): Account | null {
  clearExpiredRateLimits();
  const settings = getSettings();
  let accounts = listAccounts().filter((a) => !excludeIds.includes(a.id));
  if (opts?.kind) {
    accounts = accounts.filter((a) => a.kind === opts.kind);
  } else if (settings.endpoint === "zcode-plan") {
    accounts = accounts.filter((a) => a.kind === "zcode_jwt");
  } else {
    accounts = accounts.filter((a) => a.kind === "api_key");
  }
  if (accounts.length === 0) return null;

  if (settings.rotation === "least_used") {
    return pickLeastUsed(accounts);
  }
  return pickRoundRobin(accounts);
}

export function getNextDailyReset(): Date {
  // Z.AI сбрасывает квоты раз в сутки — до полуночи по Пекину (UTC+8)
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const nextBjMidnight = new Date(
    Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() + 1)
  );
  return new Date(nextBjMidnight.getTime() - 8 * 60 * 60 * 1000);
}

export function parseBulkKeys(text: string): { key: string; kind: "api_key" | "zcode_jwt" }[] {
  return text
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8)
    .map((key) => ({
      key,
      kind: key.startsWith("eyJ") ? "zcode_jwt" as const : "api_key" as const,
    }));
}

export function importKeys(text: string): { added: number; skipped: number } {
  const keys = parseBulkKeys(text);
  let added = 0;
  let skipped = 0;

  for (const { key, kind } of keys) {
    try {
      addAccount(`Account ${added + skipped + 1}`, key, nanoid(10), { kind });
      added++;
    } catch {
      skipped++;
    }
  }
  return { added, skipped };
}

export function estimateTokens(body: unknown): number {
  try {
    const data = body as { usage?: { total_tokens?: number } };
    return data?.usage?.total_tokens ?? 0;
  } catch {
    return 0;
  }
}

export function handleUpstreamError(
  account: Account,
  status: number,
  bodyText = "",
  retryAfterHeader?: string | null
): void {
  const err = parseZaiError(status, bodyText);

  if (status === 429) {
    if (err.kind === "balance") {
      const settings = getSettings();
      const extra =
        settings.endpoint === "general"
          ? " Если есть Coding Plan в редакторе Z.AI — переключи endpoint на coding и ключ с того же аккаунта."
          : "";
      markAccountError(
        account.id,
        `Нет баланса на этом endpoint (${err.code || "1113"}).${extra}`
      );
      return;
    }
    if (err.kind === "rate_limit") {
      const until =
        retryAfterHeader && parseInt(retryAfterHeader, 10) > 60
          ? new Date(Date.now() + parseInt(retryAfterHeader, 10) * 1000)
          : getNextDailyReset();
      markRateLimited(account.id, until, err.message);
      return;
    }
    markAccountError(account.id, err.message || "HTTP 429 от Z.AI");
    return;
  }
  if (err.kind === "auth") {
    setAccountStatus(account.id, "disabled");
    markAccountError(account.id, err.message || `HTTP ${status}`);
    return;
  }
  if (status === 401 || status === 403) {
    setAccountStatus(account.id, "disabled");
    return;
  }
  if (status >= 500) {
    recordError(account.id);
  }
}

export function handleUpstreamSuccess(account: Account, body: unknown): void {
  recordSuccess(account.id, estimateTokens(body));
}
