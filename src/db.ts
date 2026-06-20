import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";

export type AccountStatus = "active" | "rate_limited" | "disabled" | "error";

export interface Account {
  id: string;
  label: string;
  /** api_key (id.secret) or zcode JWT (eyJ...) */
  api_key: string;
  kind: "api_key" | "zcode_jwt";
  email: string | null;
  status: AccountStatus;
  requests: number;
  tokens: number;
  errors: number;
  last_used_at: string | null;
  rate_limit_until: string | null;
  last_error: string | null;
  created_at: string;
  /** ZCode Start Plan extras (kind=zcode_jwt) */
  zcode_oauth_access_token?: string | null;
  zcode_user_id?: string | null;
  zcode_session_id?: string | null;
  zcode_captcha_param?: string | null;
  zcode_captcha_expires_at?: string | null;
  platform_api_key?: string | null;
  chat_token?: string | null;
  /** Cached ZCode Start Plan quota (from billing/balance) */
  zcode_quota?: import("./zcode/billing.js").ZcodeQuotaSnapshot | null;
  /** Egress proxy for this account (autoreg job proxy, sticky IP) */
  proxy?: string | null;
}

export interface Settings {
  endpoint: import("./endpoints.js").GatewayEndpoint;
  proxy_api_key: string;
  rotation: "round_robin" | "least_used";
  default_model: string;
  zcode_config_path: string;
  autoreg: import("./autoreg.js").AutoregSettings;
}

export type AutoregStatus = import("./autoreg.js").AutoregStatus;
export type { ExportFormat } from "./autoreg.js";

export interface AutoregAccount {
  id: string;
  email: string;
  mail_password: string | null;
  password: string;
  api_key: string | null;
  proxy: string | null;
  status: AutoregStatus;
  note: string;
  created_at: string;
  updated_at: string;
}

export type AutoregJob = import("./autoreg/types.js").AutoregJob;

interface Store {
  accounts: Account[];
  autoreg_accounts: AutoregAccount[];
  autoreg_jobs: AutoregJob[];
  proxies: string[];
  proxy_disabled?: string[];
  /** Proxies where POST /auths/signup returns WAF 405 (datacenter IP block). */
  proxy_signup_blocked?: string[];
  proxy_stats?: Record<
    string,
    {
      jobs_total: number;
      jobs_active: number;
      last_used_at: string | null;
      errors: number;
    }
  >;
  settings: Settings;
}

import {
  DEFAULT_AUTOREG_SETTINGS,
  appendAccountLine,
  formatAutoregLine,
  generatePassword,
  normalizeProxy,
  writeAccountsFile,
} from "./autoreg.js";
import type { ExportFormat } from "./autoreg.js";
import { ENDPOINT_META, type GatewayEndpoint } from "./endpoints.js";

const ENDPOINTS = {
  general: ENDPOINT_META.general.baseUrl,
  coding: ENDPOINT_META.coding.baseUrl,
  anthropic: ENDPOINT_META.anthropic.baseUrl,
  "zcode-plan": ENDPOINT_META["zcode-plan"].baseUrl,
} as const;

const DEFAULT_SETTINGS: Settings = {
  endpoint: "coding",
  proxy_api_key: "",
  rotation: "round_robin",
  default_model: "glm-5.2",
  zcode_config_path: "",
  autoreg: { ...DEFAULT_AUTOREG_SETTINGS },
};

let storePath = "";
let dataDirPath = "";
let store: Store = {
  accounts: [],
  autoreg_accounts: [],
  autoreg_jobs: [],
  proxies: [],
  settings: { ...DEFAULT_SETTINGS },
};

function save(): void {
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
}

function load(): void {
  if (fs.existsSync(storePath)) {
    store = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Store;
    store.settings = {
      ...DEFAULT_SETTINGS,
      ...store.settings,
      autoreg: { ...DEFAULT_AUTOREG_SETTINGS, ...store.settings?.autoreg },
    };
    store.settings.zcode_config_path ??= "";
    store.accounts ??= [];
    store.autoreg_accounts ??= [];
    store.autoreg_jobs ??= [];
    store.proxies ??= [];
    store.proxy_disabled ??= [];
    store.proxy_signup_blocked ??= [];
    store.proxy_stats ??= {};
    for (const a of store.autoreg_accounts) {
      a.mail_password ??= null;
    }
    for (const j of store.autoreg_jobs) {
      j.mail_password ??= null;
    }
    for (const a of store.accounts) {
      a.last_error ??= null;
      a.kind ??= a.api_key.startsWith("eyJ") ? "zcode_jwt" : "api_key";
      a.email ??= null;
      a.zcode_oauth_access_token ??= null;
      a.zcode_user_id ??= null;
      a.zcode_session_id ??= null;
      a.zcode_captcha_param ??= null;
      a.zcode_captcha_expires_at ??= null;
      a.platform_api_key ??= null;
      a.chat_token ??= null;
      a.proxy ??= null;
    }
    for (const j of store.autoreg_jobs) {
      j.zcode_jwt ??= null;
      j.zcode_oauth_access_token ??= null;
      j.zcode_user_id ??= null;
      j.zcode_session_id ??= null;
      j.zcode_oauth_flow_id ??= null;
      j.zcode_oauth_poll_token ??= null;
      j.zcode_authorize_url ??= null;
      j.zcode_captcha_param ??= null;
      j.zcode_captcha_expires_at ??= null;
      j.signup_at ??= null;
      j.captcha_solved_at ??= null;
      j.last_verify_mail_at ??= null;
      j.last_verify_token ??= null;
      j.pending_verify_token ??= null;
      j.pending_verify_mail_at ??= null;
      j.pending_verify_username ??= null;
      j.signup_via_proxy ??= false;
    }
  }
}

export function getZaiBaseUrl(endpoint: GatewayEndpoint): string {
  return ENDPOINTS[endpoint] || ENDPOINT_META.general.baseUrl;
}

export function initDb(dataDir: string): void {
  dataDirPath = dataDir;
  fs.mkdirSync(dataDir, { recursive: true });
  storePath = path.join(dataDir, "store.json");
  load();
  if (!fs.existsSync(storePath)) save();
}

export function getDataDir(): string {
  return dataDirPath;
}

export function getSettings(): Settings {
  return { ...store.settings };
}

export function updateSettings(partial: Partial<Settings>): Settings {
  store.settings = { ...store.settings, ...partial };
  save();
  return getSettings();
}

export function listAccounts(): Account[] {
  return [...store.accounts].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
}

export function getAccount(id: string): Account | undefined {
  return store.accounts.find((a) => a.id === id);
}

export function addAccount(
  label: string,
  apiKey: string,
  id: string,
  opts?: {
    kind?: "api_key" | "zcode_jwt";
    email?: string | null;
    zcode_oauth_access_token?: string | null;
    zcode_user_id?: string | null;
    zcode_session_id?: string | null;
    zcode_captcha_param?: string | null;
    zcode_captcha_expires_at?: string | null;
    platform_api_key?: string | null;
    chat_token?: string | null;
    proxy?: string | null;
  }
): Account {
  const trimmed = apiKey.trim();
  if (store.accounts.some((a) => a.api_key === trimmed)) {
    throw new Error("duplicate key");
  }
  const kind =
    opts?.kind || (trimmed.startsWith("eyJ") ? "zcode_jwt" : "api_key");
  const account: Account = {
    id,
    label: label.trim(),
    api_key: trimmed,
    kind,
    email: opts?.email ?? null,
    status: "active",
    requests: 0,
    tokens: 0,
    errors: 0,
    last_used_at: null,
    rate_limit_until: null,
    last_error: null,
    created_at: new Date().toISOString(),
    zcode_oauth_access_token: opts?.zcode_oauth_access_token ?? null,
    zcode_user_id: opts?.zcode_user_id ?? null,
    zcode_session_id: opts?.zcode_session_id ?? null,
    zcode_captcha_param: opts?.zcode_captcha_param ?? null,
    zcode_captcha_expires_at: opts?.zcode_captcha_expires_at ?? null,
    platform_api_key: opts?.platform_api_key ?? null,
    chat_token: opts?.chat_token ?? null,
    proxy: opts?.proxy ? normalizeProxy(opts.proxy) : null,
  };
  store.accounts.push(account);
  save();
  return account;
}

export function updateAccountZcodeFields(
  id: string,
  patch: Partial<
    Pick<
      Account,
      | "email"
      | "zcode_oauth_access_token"
      | "zcode_user_id"
      | "zcode_session_id"
      | "zcode_captcha_param"
      | "zcode_captcha_expires_at"
      | "platform_api_key"
      | "chat_token"
      | "proxy"
    >
  >
): Account | null {
  const account = getAccount(id);
  if (!account) return null;
  if (patch.email !== undefined) account.email = patch.email;
  if (patch.zcode_oauth_access_token !== undefined) {
    account.zcode_oauth_access_token = patch.zcode_oauth_access_token;
  }
  if (patch.zcode_user_id !== undefined) account.zcode_user_id = patch.zcode_user_id;
  if (patch.zcode_session_id !== undefined) {
    account.zcode_session_id = patch.zcode_session_id;
  }
  if (patch.zcode_captcha_param !== undefined) {
    account.zcode_captcha_param = patch.zcode_captcha_param;
  }
  if (patch.zcode_captcha_expires_at !== undefined) {
    account.zcode_captcha_expires_at = patch.zcode_captcha_expires_at;
  }
  if (patch.platform_api_key !== undefined) {
    account.platform_api_key = patch.platform_api_key;
  }
  if (patch.chat_token !== undefined) account.chat_token = patch.chat_token;
  if (patch.proxy !== undefined) {
    account.proxy = patch.proxy ? normalizeProxy(patch.proxy) : null;
  }
  save();
  return account;
}

export function updateAccountZcodeQuota(
  id: string,
  quota: import("./zcode/billing.js").ZcodeQuotaSnapshot | null
): Account | null {
  const account = getAccount(id);
  if (!account) return null;
  account.zcode_quota = quota;
  save();
  return account;
}

export function deleteAccount(id: string): boolean {
  const before = store.accounts.length;
  store.accounts = store.accounts.filter((a) => a.id !== id);
  if (store.accounts.length < before) {
    save();
    return true;
  }
  return false;
}

export function deleteAllAccounts(): number {
  const count = store.accounts.length;
  store.accounts = [];
  save();
  return count;
}

export function setAccountStatus(id: string, status: AccountStatus): void {
  const account = getAccount(id);
  if (!account) return;
  account.status = status;
  save();
}

export function markRateLimited(id: string, until: Date, reason?: string): void {
  const account = getAccount(id);
  if (!account) return;
  account.status = "rate_limited";
  account.rate_limit_until = until.toISOString();
  account.last_error = reason || "Дневной лимит Z.AI";
  account.last_used_at = new Date().toISOString();
  account.requests += 1;
  save();
}

export function markAccountError(id: string, message: string): void {
  const account = getAccount(id);
  if (!account) return;
  account.status = "error";
  account.rate_limit_until = null;
  account.last_error = message;
  account.last_used_at = new Date().toISOString();
  account.requests += 1;
  account.errors += 1;
  save();
}

export function recordSuccess(id: string, tokens: number): void {
  const account = getAccount(id);
  if (!account) return;
  account.status = "active";
  account.rate_limit_until = null;
  account.last_error = null;
  account.requests += 1;
  account.tokens += tokens;
  account.last_used_at = new Date().toISOString();
  save();
}

export function recordError(id: string): void {
  const account = getAccount(id);
  if (!account) return;
  account.errors += 1;
  account.last_used_at = new Date().toISOString();
  save();
}

export function resetStats(): void {
  for (const a of store.accounts) {
    a.requests = 0;
    a.tokens = 0;
    a.errors = 0;
  }
  save();
}

export function clearRateLimits(): void {
  for (const a of store.accounts) {
    if (a.status === "rate_limited" || a.status === "error") {
      a.status = "active";
      a.rate_limit_until = null;
      a.last_error = null;
    }
  }
  save();
}

export function clearExpiredRateLimits(): number {
  const now = new Date();
  let cleared = 0;
  for (const a of store.accounts) {
    if (
      a.status === "rate_limited" &&
      a.rate_limit_until &&
      new Date(a.rate_limit_until) <= now
    ) {
      a.status = "active";
      a.rate_limit_until = null;
      cleared++;
    }
  }
  if (cleared) save();
  return cleared;
}

export function getStats() {
  const accounts = store.accounts;
  const autoreg = store.autoreg_accounts;
  return {
    total: accounts.length,
    active: accounts.filter((a) => a.status === "active").length,
    rate_limited: accounts.filter((a) => a.status === "rate_limited").length,
    error: accounts.filter((a) => a.status === "error").length,
    disabled: accounts.filter((a) => a.status === "disabled").length,
    total_requests: accounts.reduce((s, a) => s + a.requests, 0),
    total_tokens: accounts.reduce((s, a) => s + a.tokens, 0),
    total_errors: accounts.reduce((s, a) => s + a.errors, 0),
    autoreg_total: autoreg.length,
    autoreg_pending: autoreg.filter((a) => a.status === "pending").length,
    autoreg_ready: autoreg.filter((a) => a.status === "ready").length,
    autoreg_synced: autoreg.filter((a) => a.status === "synced").length,
    proxies: store.proxies.length,
    proxies_enabled: listEnabledProxies().length,
  };
}

function isProxyEnabled(url: string): boolean {
  return !(store.proxy_disabled ?? []).includes(url);
}

function isProxySignupAllowed(url: string): boolean {
  return !(store.proxy_signup_blocked ?? []).includes(url);
}

export function listEnabledProxies(): string[] {
  return store.proxies.filter(isProxyEnabled);
}

export function listSignupProxies(): string[] {
  return store.proxies.filter(
    (url) => isProxyEnabled(url) && isProxySignupAllowed(url)
  );
}

export function markProxySignupBlocked(url: string): void {
  store.proxy_signup_blocked ??= [];
  if (!store.proxy_signup_blocked.includes(url)) {
    store.proxy_signup_blocked.push(url);
    save();
  }
}

export function clearProxySignupBlocked(url: string): void {
  store.proxy_signup_blocked = (store.proxy_signup_blocked ?? []).filter(
    (p) => p !== url
  );
  save();
}

function getProxyStat(url: string) {
  store.proxy_stats ??= {};
  return (
    store.proxy_stats[url] ?? {
      jobs_total: 0,
      jobs_active: 0,
      last_used_at: null,
      errors: 0,
    }
  );
}

/** Меньше active/total → свободнее прокси. extraLoad — локальный счётчик при пакетном назначении. */
export function pickLeastUsedProxy(
  extraLoad?: Map<string, number>,
  opts?: { forSignup?: boolean }
): string | null {
  const enabled = opts?.forSignup ? listSignupProxies() : listEnabledProxies();
  if (!enabled.length) return null;

  const extra = (url: string) => extraLoad?.get(url) ?? 0;
  const sorted = [...enabled].sort((a, b) => {
    const sa = getProxyStat(a);
    const sb = getProxyStat(b);
    const scoreA = (sa.jobs_active + extra(a)) * 10_000 + sa.jobs_total;
    const scoreB = (sb.jobs_active + extra(b)) * 10_000 + sb.jobs_total;
    if (scoreA !== scoreB) return scoreA - scoreB;
    const ta = sa.last_used_at ? new Date(sa.last_used_at).getTime() : 0;
    const tb = sb.last_used_at ? new Date(sb.last_used_at).getTime() : 0;
    return ta - tb;
  });
  return sorted[0]!;
}

/** Один прокси — одна задача в пакете (пока не освободится). */
export function pickLeastUsedProxyExcluding(
  excluded: Set<string>,
  opts?: { forSignup?: boolean }
): string | null {
  const enabled = (opts?.forSignup ? listSignupProxies() : listEnabledProxies()).filter(
    (url) => !excluded.has(url)
  );
  if (!enabled.length) return null;

  const sorted = [...enabled].sort((a, b) => {
    const sa = getProxyStat(a);
    const sb = getProxyStat(b);
    const scoreA = sa.jobs_active * 10_000 + sa.jobs_total;
    const scoreB = sb.jobs_active * 10_000 + sb.jobs_total;
    if (scoreA !== scoreB) return scoreA - scoreB;
    const ta = sa.last_used_at ? new Date(sa.last_used_at).getTime() : 0;
    const tb = sb.last_used_at ? new Date(sb.last_used_at).getTime() : 0;
    return ta - tb;
  });
  return sorted[0]!;
}

export function markProxyJobStart(url: string): void {
  store.proxy_stats ??= {};
  const s = getProxyStat(url);
  store.proxy_stats[url] = {
    ...s,
    jobs_active: s.jobs_active + 1,
    jobs_total: s.jobs_total + 1,
    last_used_at: new Date().toISOString(),
  };
  save();
}

export function markProxyJobEnd(url: string, failed = false): void {
  store.proxy_stats ??= {};
  const s = getProxyStat(url);
  store.proxy_stats[url] = {
    ...s,
    jobs_active: Math.max(0, s.jobs_active - 1),
    errors: failed ? s.errors + 1 : s.errors,
  };
  save();
}

export function listProxiesDetailed(): Array<{
  index: number;
  url: string;
  enabled: boolean;
  signup_blocked: boolean;
  jobs_total: number;
  jobs_active: number;
  errors: number;
  last_used_at: string | null;
}> {
  return store.proxies.map((url, index) => {
    const stat = getProxyStat(url);
    return {
      index,
      url,
      enabled: isProxyEnabled(url),
      signup_blocked: !isProxySignupAllowed(url),
      jobs_total: stat.jobs_total,
      jobs_active: stat.jobs_active,
      errors: stat.errors,
      last_used_at: stat.last_used_at,
    };
  });
}

export function toggleProxyByIndex(index: number, enabled: boolean): boolean {
  const url = store.proxies[index];
  if (!url) return false;
  store.proxy_disabled ??= [];
  if (enabled) {
    store.proxy_disabled = store.proxy_disabled.filter((p) => p !== url);
  } else if (!store.proxy_disabled.includes(url)) {
    store.proxy_disabled.push(url);
  }
  save();
  return true;
}

export function deleteProxyByIndex(index: number): boolean {
  const url = store.proxies[index];
  if (!url) return false;
  store.proxies.splice(index, 1);
  store.proxy_disabled = (store.proxy_disabled ?? []).filter((p) => p !== url);
  store.proxy_signup_blocked = (store.proxy_signup_blocked ?? []).filter(
    (p) => p !== url
  );
  if (store.proxy_stats) delete store.proxy_stats[url];
  save();
  return true;
}

// --- Autoreg accounts ---

export function listAutoregAccounts(): AutoregAccount[] {
  return [...store.autoreg_accounts].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
}

export function getAutoregAccount(id: string): AutoregAccount | undefined {
  return store.autoreg_accounts.find((a) => a.id === id);
}

export function listProxies(): string[] {
  return [...store.proxies];
}

export function setProxies(proxies: string[]): string[] {
  store.proxies = proxies
    .map((p) => normalizeProxy(p) || p.trim())
    .filter(Boolean);
  save();
  return store.proxies;
}

export function addProxies(text: string): { added: number; total: number } {
  const lines = text.split(/[\n\r,;]+/).map((l) => l.trim()).filter(Boolean);
  const existing = new Set(store.proxies);
  let added = 0;
  for (const line of lines) {
    const proxy = normalizeProxy(line);
    if (!proxy || existing.has(proxy)) continue;
    store.proxies.push(proxy);
    existing.add(proxy);
    added++;
  }
  save();
  return { added, total: store.proxies.length };
}

export function clearProxies(): void {
  store.proxies = [];
  store.proxy_disabled = [];
  store.proxy_signup_blocked = [];
  store.proxy_stats = {};
  save();
}

export function createAutoregAccount(
  id: string,
  email: string,
  password: string,
  opts?: {
    mail_password?: string | null;
    api_key?: string;
    proxy?: string | null;
    note?: string;
  }
): AutoregAccount {
  const emailNorm = email.trim().toLowerCase();
  if (store.autoreg_accounts.some((a) => a.email === emailNorm)) {
    throw new Error("duplicate email");
  }

  const apiKey = opts?.api_key?.trim() || null;
  const account: AutoregAccount = {
    id,
    email: emailNorm,
    mail_password: opts?.mail_password?.trim() || null,
    password,
    api_key: apiKey,
    proxy: opts?.proxy ? normalizeProxy(opts.proxy) : null,
    status: apiKey ? "ready" : "pending",
    note: opts?.note || "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  store.autoreg_accounts.push(account);
  save();

  if (apiKey && store.settings.autoreg.auto_save_file) {
    const line = formatAutoregLine(account, store.settings.autoreg.export_format);
    appendAccountLine(dataDirPath, line);
  }

  return account;
}

export function updateAutoregAccount(
  id: string,
  patch: Partial<
    Pick<
      AutoregAccount,
      "mail_password" | "password" | "api_key" | "proxy" | "status" | "note"
    >
  >
): AutoregAccount | null {
  const account = getAutoregAccount(id);
  if (!account) return null;

  if (patch.mail_password !== undefined) {
    account.mail_password = patch.mail_password?.trim() || null;
  }
  if (patch.password !== undefined) account.password = patch.password;
  if (patch.proxy !== undefined) {
    account.proxy = patch.proxy ? normalizeProxy(patch.proxy) : null;
  }
  if (patch.note !== undefined) account.note = patch.note;
  if (patch.status !== undefined) account.status = patch.status;

  if (patch.api_key !== undefined) {
    const key = patch.api_key?.trim() || null;
    account.api_key = key;
    if (key) {
      account.status = account.status === "synced" ? "synced" : "ready";
      if (store.settings.autoreg.auto_save_file) {
        const line = formatAutoregLine(account, store.settings.autoreg.export_format);
        appendAccountLine(dataDirPath, line);
      }
    } else if (account.status !== "synced") {
      account.status = "pending";
    }
  }

  account.updated_at = new Date().toISOString();
  save();
  return account;
}

export function deleteAutoregAccount(id: string): boolean {
  const before = store.autoreg_accounts.length;
  store.autoreg_accounts = store.autoreg_accounts.filter((a) => a.id !== id);
  if (store.autoreg_accounts.length < before) {
    save();
    return true;
  }
  return false;
}

export function deleteAllAutoregAccounts(): number {
  const count = store.autoreg_accounts.length;
  store.autoreg_accounts = [];
  save();
  return count;
}

export function updateAutoregSettings(
  partial: Partial<import("./autoreg.js").AutoregSettings>
): Settings {
  store.settings.autoreg = { ...store.settings.autoreg, ...partial };
  save();
  return getSettings();
}

export function exportAutoregAccounts(opts?: {
  format?: ExportFormat;
  only_ready?: boolean;
  write_file?: boolean;
}): { lines: string[]; file?: string } {
  const format = opts?.format || store.settings.autoreg.export_format;
  let accounts = listAutoregAccounts();
  if (opts?.only_ready) {
    accounts = accounts.filter((a) => a.api_key);
  }
  const lines = accounts
    .map((a) => formatAutoregLine(a, format))
    .filter((l) => l && (format !== "api_key" || l.length > 8));

  let file: string | undefined;
  if (opts?.write_file && lines.length) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    file = writeAccountsFile(dataDirPath, lines, `accounts-${ts}.txt`);
  }
  return { lines, file };
}

export function syncAutoregToPool(): { synced: number; skipped: number } {
  let synced = 0;
  let skipped = 0;

  const proxyForEmail = (email: string | null | undefined): string | null => {
    if (!email) return null;
    const lower = email.toLowerCase();
    const ar = store.autoreg_accounts.find(
      (a) => a.email?.toLowerCase() === lower && a.proxy?.trim()
    );
    if (ar?.proxy) return normalizeProxy(ar.proxy);
    const job = [...store.autoreg_jobs]
      .reverse()
      .find(
        (j) =>
          j.email?.toLowerCase() === lower &&
          j.proxy?.trim() &&
          (j.step === "done" || j.zcode_jwt)
      );
    return job?.proxy ? normalizeProxy(job.proxy) : null;
  };

  const backfillProxy = (account: Account): void => {
    if (account.proxy?.trim()) return;
    const px = proxyForEmail(account.email);
    if (px) account.proxy = px;
  };

  for (const ar of store.autoreg_accounts) {
    if (!ar.api_key || ar.status === "synced") {
      if (!ar.api_key) skipped++;
      continue;
    }
    if (store.accounts.some((a) => a.api_key === ar.api_key)) {
      ar.status = "synced";
      skipped++;
      continue;
    }
    try {
      addAccount(ar.email, ar.api_key, `ar_${ar.id}`, {
        kind: "api_key",
        email: ar.email,
      });
      ar.status = "synced";
      ar.updated_at = new Date().toISOString();
      synced++;
    } catch {
      skipped++;
    }
  }

  for (const job of store.autoreg_jobs) {
    if (job.step !== "done" || !job.zcode_jwt) continue;
    const existing = store.accounts.find((a) => a.api_key === job.zcode_jwt);
    if (existing) {
      backfillProxy(existing);
      if (job.proxy?.trim() && !existing.proxy) {
        existing.proxy = normalizeProxy(job.proxy);
      }
      skipped++;
      continue;
    }
    try {
      addAccount(job.email, job.zcode_jwt, `job_${job.id}`, {
        kind: "zcode_jwt",
        email: job.email,
        zcode_oauth_access_token: job.zcode_oauth_access_token,
        zcode_user_id: job.zcode_user_id,
        zcode_session_id: job.zcode_session_id,
        zcode_captcha_param: job.zcode_captcha_param,
        zcode_captcha_expires_at: job.zcode_captcha_expires_at,
        platform_api_key: job.api_key,
        chat_token: job.chat_token,
        proxy: job.proxy,
      });
      synced++;
    } catch {
      skipped++;
    }
  }

  for (const account of store.accounts) {
    if (account.kind === "zcode_jwt") backfillProxy(account);
  }

  save();
  return { synced, skipped };
}

export function importAutoregBulk(
  lines: import("./autoreg.js").ParsedAutoregLine[],
  opts?: { assign_proxy?: boolean; generate_password?: boolean }
): { added: number; skipped: number } {
  const assignProxy = opts?.assign_proxy ?? true;
  const genPass = opts?.generate_password ?? true;
  let added = 0;
  let skipped = 0;

  for (const line of lines) {
    try {
      const zaiPassword =
        line.password ||
        (genPass ? generatePassword(store.settings.autoreg.password_length) : "");
      if (!zaiPassword) {
        skipped++;
        continue;
      }
      const proxy =
        line.proxy ||
        (assignProxy ? pickLeastUsedProxy() : null);

      createAutoregAccount(nanoid(10), line.email, zaiPassword, {
        mail_password: line.mail_password,
        api_key: line.api_key,
        proxy: proxy || undefined,
      });
      added++;
    } catch {
      skipped++;
    }
  }

  return { added, skipped };
}

// --- Autoreg jobs ---

export function listAutoregJobs(): AutoregJob[] {
  return [...store.autoreg_jobs].sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
}

export function getAutoregJob(id: string): AutoregJob | undefined {
  return store.autoreg_jobs.find((j) => j.id === id);
}

export function saveAutoregJob(job: AutoregJob): void {
  const idx = store.autoreg_jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) store.autoreg_jobs[idx] = job;
  else store.autoreg_jobs.push(job);
  if (store.autoreg_jobs.length > 50) {
    store.autoreg_jobs = store.autoreg_jobs.slice(-50);
  }
  save();
}

export function deleteAutoregJob(id: string): boolean {
  const before = store.autoreg_jobs.length;
  store.autoreg_jobs = store.autoreg_jobs.filter((j) => j.id !== id);
  if (store.autoreg_jobs.length < before) {
    save();
    return true;
  }
  return false;
}
