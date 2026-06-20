import type { Account } from "../db.js";
import { fetchWithProxy } from "../proxy-util.js";
import { proxyForZcodeAccount } from "./account-proxy.js";
import {
  ZCODE_APP_VERSION,
  ZCODE_BASE_URL,
} from "./constants.js";
import { buildZcodeBillingHeaders } from "./headers.js";

export interface ZcodeBalanceRow {
  show_name: string;
  entitlement_id: string;
  total_units: number;
  used_units: number;
  remaining_units: number;
  available_units: number;
  period_start: number;
  period_end: number;
  expires_at: number;
}

export interface ZcodeQuotaSnapshot {
  fetched_at: string;
  plan_name: string;
  plan_id: string;
  plan_status: string;
  server_time: number;
  balances: ZcodeBalanceRow[];
  /** Earliest period_end among balances (daily reset) */
  reset_at: string;
}

interface BillingCurrentResponse {
  code: number;
  msg: string;
  data?: {
    plans?: Array<{
      name: string;
      plan_id: string;
      status: string;
    }>;
  };
}

interface BillingBalanceResponse {
  code: number;
  msg: string;
  data?: {
    server_time: number;
    balances?: Array<{
      show_name: string;
      entitlement_id: string;
      total_units: number;
      used_units: number;
      remaining_units: number;
      available_units: number;
      period_start: number;
      period_end: number;
      expires_at: number;
    }>;
  };
}


function zcodeBillingHeaders(jwt: string): Record<string, string> {
  return buildZcodeBillingHeaders(jwt);
}

export async function fetchZcodeQuota(jwt: string): Promise<ZcodeQuotaSnapshot> {
  const q = `app_version=${encodeURIComponent(ZCODE_APP_VERSION)}`;
  const headers = zcodeBillingHeaders(jwt);

  const [currentRes, balanceRes] = await Promise.all([
    fetch(`${ZCODE_BASE_URL}/api/v1/zcode-plan/billing/current?${q}`, {
      headers,
    }),
    fetch(`${ZCODE_BASE_URL}/api/v1/zcode-plan/billing/balance?${q}`, {
      headers,
    }),
  ]);

  const currentText = await currentRes.text();
  const balanceText = await balanceRes.text();

  let current: BillingCurrentResponse = { code: -1, msg: currentText.slice(0, 200) };
  let balance: BillingBalanceResponse = { code: -1, msg: balanceText.slice(0, 200) };
  try {
    current = JSON.parse(currentText) as BillingCurrentResponse;
  } catch {
    /* keep raw */
  }
  try {
    balance = JSON.parse(balanceText) as BillingBalanceResponse;
  } catch {
    /* keep raw */
  }

  if (!currentRes.ok || current.code !== 0) {
    throw new Error(
      `billing/current ${currentRes.status}: ${current.msg || currentText.slice(0, 200)}`
    );
  }
  if (!balanceRes.ok || balance.code !== 0) {
    throw new Error(
      `billing/balance ${balanceRes.status}: ${balance.msg || balanceText.slice(0, 200)}`
    );
  }

  const plan = current.data?.plans?.[0];
  const balances = (balance.data?.balances || []).map((b) => ({
    show_name: b.show_name,
    entitlement_id: b.entitlement_id,
    total_units: b.total_units,
    used_units: b.used_units,
    remaining_units: b.remaining_units,
    available_units: b.available_units,
    period_start: b.period_start,
    period_end: b.period_end,
    expires_at: b.expires_at,
  }));

  const resetUnix = balances.reduce(
    (min, b) => (b.period_end < min ? b.period_end : min),
    balances[0]?.period_end ?? 0
  );

  return {
    fetched_at: new Date().toISOString(),
    plan_name: plan?.name || "ZCode Start Plan",
    plan_id: plan?.plan_id || "",
    plan_status: plan?.status || "unknown",
    server_time: balance.data?.server_time ?? Math.floor(Date.now() / 1000),
    balances,
    reset_at: resetUnix ? new Date(resetUnix * 1000).toISOString() : "",
  };
}

export async function fetchZcodeQuotaForAccount(
  account: Account
): Promise<ZcodeQuotaSnapshot> {
  if (account.kind !== "zcode_jwt" || !account.api_key.startsWith("eyJ")) {
    throw new Error("account is not zcode_jwt");
  }
  return fetchZcodeQuota(account.api_key);
}

/** Quick JWT health — 3012 means account banned for zcode-plan API. */
export async function probeZcodeJwtHealth(
  jwt: string,
  proxy?: string | null
): Promise<{
  ok: boolean;
  httpStatus: number;
  code?: number;
  msg?: string;
}> {
  const q = `app_version=${encodeURIComponent(ZCODE_APP_VERSION)}`;
  const headers = zcodeBillingHeaders(jwt);
  try {
    const res = await fetchWithProxy(
      `${ZCODE_BASE_URL}/api/v1/zcode-plan/billing/balance?${q}`,
      { headers, proxy: proxy ?? null, signal: AbortSignal.timeout(15_000) }
    );
    const text = await res.text();
    let parsed: { code?: number; msg?: string } = {};
    try {
      parsed = JSON.parse(text) as { code?: number; msg?: string };
    } catch {
      /* raw */
    }
    const code = parsed.code;
    if (res.ok && code === 0) {
      return { ok: true, httpStatus: res.status, code: 0, msg: parsed.msg };
    }
    return {
      ok: false,
      httpStatus: res.status,
      code,
      msg: parsed.msg || text.slice(0, 120),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, httpStatus: 0, msg: message };
  }
}

export async function probeZcodeAccountHealth(
  account: Account
): Promise<ReturnType<typeof probeZcodeJwtHealth>> {
  if (account.kind !== "zcode_jwt") {
    return { ok: false, httpStatus: 0, msg: "not zcode_jwt" };
  }
  return probeZcodeJwtHealth(account.api_key, proxyForZcodeAccount(account));
}

export function formatQuotaShort(snapshot: ZcodeQuotaSnapshot | null | undefined): string {
  if (!snapshot?.balances?.length) return "—";
  return snapshot.balances
    .map((b) => `${b.show_name}: ${formatTokens(b.remaining_units)}/${formatTokens(b.total_units)}`)
    .join(" · ");
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function formatResetCountdown(resetAtIso: string): string {
  if (!resetAtIso) return "";
  const ms = new Date(resetAtIso).getTime() - Date.now();
  if (ms <= 0) return "скоро";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `через ${h}ч ${m}м`;
  return `через ${m}м`;
}
