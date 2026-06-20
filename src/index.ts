import "dotenv/config";
import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import {
  addAccount,
  addProxies,
  clearProxies,
  clearRateLimits,
  deleteAccount,
  deleteAllAccounts,
  deleteAllAutoregAccounts,
  deleteAutoregAccount,
  deleteAutoregJob,
  deleteProxyByIndex,
  exportAutoregAccounts,
  getAccount,
  getAutoregAccount,
  getAutoregJob,
  getSettings,
  getStats,
  importAutoregBulk,
  initDb,
  listAccounts,
  listAutoregAccounts,
  listAutoregJobs,
  listEnabledProxies,
  listProxies,
  listProxiesDetailed,
  pickLeastUsedProxy,
  pickLeastUsedProxyExcluding,
  resetStats,
  setAccountStatus,
  markAccountError,
  syncAutoregToPool,
  updateAccountZcodeFields,
  updateAccountZcodeQuota,
  updateAutoregAccount,
  updateAutoregSettings,
  updateSettings,
  toggleProxyByIndex,
} from "./db.js";
import { parseAutoregBulk, maskProxy } from "./autoreg.js";
import { importKeys, parseBulkKeys } from "./accounts.js";
import { isOpenAiPath, proxyToZai } from "./proxy.js";
import { isAnthropicEndpoint, proxyAnthropic } from "./proxy-anthropic.js";
import { zcodeConfigSummary, readZcodeJwt } from "./endpoints.js";
import { verifyApiKey, verifyApiKeyBothEndpoints, verifyProxy } from "./proxy-util.js";
import { probeProxySignupAccess } from "./autoreg/signup-waf.js";
import { parseHar } from "./har.js";
import {
  createJob,
  completeBrowserSignup,
  completeFinishSignup,
  cancelAllAutoregJobs,
  cancelAutoregJob,
  getFinishForm,
  getJobEgressInfo,
  getJobPublic,
  getSignupForm,
  importReadyZcodeJob,
  markCaptchaSolved,
  pollZcodeOAuthJob,
  retryEmailWait,
  runProxiedSignup,
  runAutoCaptchaSignup,
  runFullAutoreg,
  runPollMail,
  runZcodeAutoreg,
  startZcodeAutoregAsync,
  wrapAutoregAccountInZcode,
  runServerFinishSignup,
  runSignup,
  runVerifyEmail,
  startZcodeOAuth,
  submitJobZcodeCaptcha,
} from "./autoreg/pipeline.js";
import {
  CAPTCHA_PREFIX,
  CAPTCHA_REGION,
  CAPTCHA_SCENE_ID,
} from "./autoreg/types.js";
import { fetchZcodeCaptchaConfig } from "./zcode/captcha-config.js";
import {
  probeZcodeElectronProxy,
  shouldUseZcodeElectronProxy,
} from "./zcode/zcode-fetch.js";
import {
  ZCODE_CAPTCHA_PREFIX,
  ZCODE_CAPTCHA_SCENE_ID,
} from "./zcode/constants.js";
import { bundleFromAccount, bundleFromJob } from "./zcode/credentials.js";
import { importZcodeAccount } from "./zcode/pool.js";
import {
  fetchZcodeQuota,
  fetchZcodeQuotaForAccount,
} from "./zcode/billing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3847", 10);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");

initDb(DATA_DIR);

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

// --- Admin API ---

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, port: PORT });
});

app.get("/api/stats", (_req, res) => {
  res.json({ stats: getStats(), settings: getSettings() });
});

app.get("/api/accounts", (_req, res) => {
  const accounts = listAccounts().map((a) => ({
    ...a,
    api_key: maskKey(a.api_key),
    api_key_full: undefined,
  }));
  res.json({ accounts });
});

app.post("/api/accounts", (req, res) => {
  const { label, api_key, keys } = req.body as {
    label?: string;
    api_key?: string;
    keys?: string;
  };

  if (keys) {
    const result = importKeys(keys);
    return res.json(result);
  }

  if (!api_key?.trim()) {
    return res.status(400).json({ error: "api_key or keys required" });
  }

  const id = nanoid(10);
  const account = addAccount(label || `Account`, api_key, id);
  res.json({
    account: { ...account, api_key: maskKey(account.api_key) },
  });
});

app.delete("/api/accounts/:id", (req, res) => {
  const ok = deleteAccount(req.params.id);
  res.json({ ok });
});

app.delete("/api/accounts", (_req, res) => {
  const count = deleteAllAccounts();
  res.json({ deleted: count });
});

app.patch("/api/accounts/:id", (req, res) => {
  const { status } = req.body as { status?: string };
  if (!status || !["active", "disabled"].includes(status)) {
    return res.status(400).json({ error: "status must be active or disabled" });
  }
  setAccountStatus(req.params.id, status as "active" | "disabled");
  res.json({ ok: true });
});

app.post("/api/accounts/:id/verify", async (req, res) => {
  const account = listAccounts().find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: "not found" });
  const result = await verifyApiKeyBothEndpoints(account.api_key);
  res.json(result);
});

app.post("/api/accounts/verify-key", async (req, res) => {
  const { api_key } = req.body as { api_key?: string };
  if (!api_key?.trim()) {
    return res.status(400).json({ error: "api_key required" });
  }
  const result = await verifyApiKeyBothEndpoints(api_key.trim());
  res.json(result);
});

app.post("/api/accounts/reset-rate-limits", (_req, res) => {
  clearRateLimits();
  res.json({ ok: true });
});

app.post("/api/stats/reset", (_req, res) => {
  resetStats();
  res.json({ ok: true });
});

app.get("/api/settings", (_req, res) => {
  res.json(getSettings());
});

app.put("/api/settings", (req, res) => {
  const { endpoint, proxy_api_key, rotation, default_model, zcode_config_path } =
    req.body;
  const settings = updateSettings({
    endpoint,
    proxy_api_key,
    rotation,
    default_model,
    zcode_config_path,
  });
  res.json(settings);
});

app.get("/api/zcode/status", (_req, res) => {
  const settings = getSettings();
  const summary = zcodeConfigSummary(settings.zcode_config_path || undefined);
  res.json(summary);
});

app.post("/api/zcode/import-jwt", (req, res) => {
  const summary = zcodeConfigSummary(getSettings().zcode_config_path || undefined);
  const jwt = readZcodeJwt(summary.configPath);
  if (!jwt) {
    return res.status(400).json({ error: "JWT не найден в ZCode config. Войди в ZCode." });
  }
  try {
    const account = importZcodeAccount({ jwt, label: "ZCode JWT" });
    res.json({
      ok: true,
      account: { ...account, api_key: maskKey(account.api_key) },
      ...summary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

app.get("/api/zcode/captcha-config", async (_req, res) => {
  try {
    const config = await fetchZcodeCaptchaConfig();
    res.json({
      ...config,
      sceneId: config.sceneId || ZCODE_CAPTCHA_SCENE_ID,
      prefix: config.prefix || ZCODE_CAPTCHA_PREFIX,
    });
  } catch (err) {
    res.json({
      sceneId: ZCODE_CAPTCHA_SCENE_ID,
      prefix: ZCODE_CAPTCHA_PREFIX,
      region: "sgp",
      enabled: true,
      scriptUrl:
        "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js",
    });
  }
});

app.get("/api/zcode/upstream", async (_req, res) => {
  const probe = await probeZcodeElectronProxy();
  let useElectron = false;
  try {
    useElectron = await shouldUseZcodeElectronProxy();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.json({ probe, use_electron: false, error: message });
  }
  res.json({
    probe,
    use_electron: useElectron,
    mode: process.env.ZCODE_UPSTREAM || process.env.ZCODE_LOCAL_PROXY || "auto",
    note: "Chat API needs ZCode Electron :9999/proxy when direct fetch returns 3012",
  });
});

app.post("/api/zcode/import", (req, res) => {
  const {
    email,
    jwt,
    zcode_jwt,
    oauth_access_token,
    captcha_verify_param,
    captcha_expires_at,
    platform_api_key,
    api_key,
    chat_token,
    user_id,
    label,
  } = req.body as Record<string, string | undefined>;

  const token = (jwt || zcode_jwt || "").trim();
  if (!token.startsWith("eyJ")) {
    return res.status(400).json({ error: "jwt / zcode_jwt (eyJ...) required" });
  }

  try {
    const account = importZcodeAccount({
      label: label || email || "ZCode",
      email: email || null,
      jwt: token,
      oauth_access_token,
      captcha_verify_param,
      captcha_expires_at,
      platform_api_key: platform_api_key || api_key,
      chat_token,
      user_id,
    });
    res.json({
      ok: true,
      account: { ...account, api_key: maskKey(account.api_key) },
      bundle: bundleFromAccount(account),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

app.post("/api/zcode/captcha", (req, res) => {
  const { account_id, job_id, captcha_verify_param, captcha_expires_at } =
    req.body as {
      account_id?: string;
      job_id?: string;
      captcha_verify_param?: string;
      captcha_expires_at?: string;
    };

  if (!captcha_verify_param?.trim()) {
    return res.status(400).json({ error: "captcha_verify_param required" });
  }

  if (job_id) {
    try {
      const job = submitJobZcodeCaptcha(
        job_id,
        captcha_verify_param,
        captcha_expires_at
      );
      return res.json(getJobPublic(job));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: message });
    }
  }

  if (!account_id) {
    return res.status(400).json({ error: "account_id or job_id required" });
  }

  const account = updateAccountZcodeFields(account_id, {
    zcode_captcha_param: captcha_verify_param.trim(),
    zcode_captcha_expires_at: captcha_expires_at || null,
  });
  if (!account) return res.status(404).json({ error: "account not found" });
  res.json({ ok: true, account: { ...account, api_key: maskKey(account.api_key) } });
});

app.get("/api/zcode/accounts/:id/bundle", (req, res) => {
  const account = getAccount(req.params.id);
  if (!account) return res.status(404).json({ error: "not found" });
  const bundle = bundleFromAccount(account);
  if (!bundle) {
    return res.status(400).json({ error: "not a zcode_jwt account" });
  }
  res.json({ bundle });
});

app.get("/api/zcode/accounts/:id/quota", async (req, res) => {
  const account = getAccount(req.params.id);
  if (!account) return res.status(404).json({ error: "not found" });
  if (account.kind !== "zcode_jwt") {
    return res.status(400).json({ error: "not a zcode_jwt account" });
  }
  try {
    const quota = await fetchZcodeQuotaForAccount(account);
    updateAccountZcodeQuota(account.id, quota);
    res.json({ ok: true, quota });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: message });
  }
});

app.post("/api/zcode/probe-health", async (_req, res) => {
  const { probeZcodeAccountHealth } = await import("./zcode/billing.js");
  const accounts = listAccounts().filter((a) => a.kind === "zcode_jwt");
  const results: Array<{
    id: string;
    label: string;
    ok: boolean;
    code?: number;
    msg?: string;
  }> = [];

  for (const account of accounts) {
    const health = await probeZcodeAccountHealth(account);
    results.push({
      id: account.id,
      label: account.label,
      ok: health.ok,
      code: health.code,
      msg: health.msg,
    });
    if (!health.ok && (health.code === 3012 || health.httpStatus === 405)) {
      setAccountStatus(account.id, "disabled");
      markAccountError(
        account.id,
        `3012 banned — аккаунт мёртв для zcode-plan API`
      );
    }
  }

  const alive = results.filter((r) => r.ok).length;
  res.json({
    ok: alive > 0,
    alive,
    dead: results.length - alive,
    results,
    hint:
      alive === 0
        ? "Все JWT получили 3012. Нужен НОВЫЙ аккаунт (ручная регистрация, без спама тестами)."
        : undefined,
  });
});

app.post("/api/zcode/quota/refresh", async (_req, res) => {
  const accounts = listAccounts().filter((a) => a.kind === "zcode_jwt");
  const results: Array<{
    id: string;
    label: string;
    ok: boolean;
    quota?: import("./zcode/billing.js").ZcodeQuotaSnapshot;
    error?: string;
  }> = [];

  for (const account of accounts) {
    try {
      const quota = await fetchZcodeQuotaForAccount(account);
      updateAccountZcodeQuota(account.id, quota);
      results.push({ id: account.id, label: account.label, ok: true, quota });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ id: account.id, label: account.label, ok: false, error: message });
    }
  }

  res.json({ ok: true, refreshed: results.filter((r) => r.ok).length, results });
});

app.get("/api/autoreg/jobs/:id/zcode-bundle", (req, res) => {
  const job = getAutoregJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  const bundle = bundleFromJob(job);
  if (!bundle) {
    return res.status(400).json({ error: "zcode_jwt not ready" });
  }
  res.json({ bundle, step: job.step });
});

app.post("/api/autoreg/jobs/import-zcode", async (req, res) => {
  const body = req.body as {
    email?: string;
    password?: string;
    mail_password?: string;
    zcode_jwt?: string;
    jwt?: string;
    zcode_oauth_access_token?: string;
    oauth_access_token?: string;
    captcha_verify_param?: string;
    api_key?: string;
    chat_token?: string;
    platform_token?: string;
    zcode_user_id?: string;
  };

  if (!body.email?.includes("@")) {
    return res.status(400).json({ error: "email required" });
  }
  const jwt = (body.zcode_jwt || body.jwt || "").trim();
  if (!jwt.startsWith("eyJ")) {
    return res.status(400).json({ error: "zcode_jwt (eyJ...) required" });
  }

  try {
    const job = await importReadyZcodeJob({
      email: body.email,
      password: body.password,
      mail_password: body.mail_password,
      zcode_jwt: jwt,
      zcode_oauth_access_token: body.zcode_oauth_access_token || body.oauth_access_token,
      zcode_captcha_param: body.captcha_verify_param,
      api_key: body.api_key,
      chat_token: body.chat_token,
      platform_token: body.platform_token,
      zcode_user_id: body.zcode_user_id,
    });
    res.json(getJobPublic(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

app.post("/api/parse-keys", (req, res) => {
  const { text } = req.body as { text?: string };
  const keys = parseBulkKeys(text || "");
  res.json({ count: keys.length, preview: keys.map((k) => maskKey(k.key)) });
});

// --- Autoreg API ---

app.get("/api/autoreg", (_req, res) => {
  const accounts = listAutoregAccounts().map((a) => ({
    ...a,
    password: a.password.slice(0, 2) + "***",
    api_key: a.api_key ? maskKey(a.api_key) : null,
    proxy: maskProxy(a.proxy),
  }));
  res.json({
    accounts,
    proxies: listProxies().map(maskProxy),
    settings: getSettings().autoreg,
  });
});

app.post("/api/autoreg", (req, res) => {
  const { text, emails, assign_proxy, generate_password } = req.body as {
    text?: string;
    emails?: string;
    assign_proxy?: boolean;
    generate_password?: boolean;
  };

  const bulk = text || emails || "";
  if (!bulk.trim()) {
    return res.status(400).json({ error: "text or emails required" });
  }

  const lines = parseAutoregBulk(bulk);
  const result = importAutoregBulk(lines, {
    assign_proxy: assign_proxy ?? true,
    generate_password: generate_password ?? true,
  });
  res.json(result);
});

app.patch("/api/autoreg/:id", (req, res) => {
  const { api_key, password, proxy, note, status } = req.body as {
    api_key?: string;
    password?: string;
    proxy?: string;
    note?: string;
    status?: string;
  };
  const account = updateAutoregAccount(req.params.id, {
    api_key,
    password,
    proxy,
    note,
    status: status as import("./db.js").AutoregStatus | undefined,
  });
  if (!account) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

app.delete("/api/autoreg/:id", (req, res) => {
  res.json({ ok: deleteAutoregAccount(req.params.id) });
});

app.delete("/api/autoreg", (_req, res) => {
  res.json({ deleted: deleteAllAutoregAccounts() });
});

app.post("/api/autoreg/export", (req, res) => {
  const { format, only_ready, write_file } = req.body as {
    format?: string;
    only_ready?: boolean;
    write_file?: boolean;
  };
  const result = exportAutoregAccounts({
    format: format as import("./autoreg.js").ExportFormat | undefined,
    only_ready: only_ready ?? true,
    write_file: write_file ?? true,
  });
  res.json(result);
});

app.post("/api/autoreg/sync", async (_req, res) => {
  const result = syncAutoregToPool();
  const { probeZcodeAccountHealth } = await import("./zcode/billing.js");
  const probed: Array<{ id: string; email: string | null; ok: boolean; code?: number }> = [];

  for (const account of listAccounts().filter((a) => a.kind === "zcode_jwt")) {
    const health = await probeZcodeAccountHealth(account);
    probed.push({
      id: account.id,
      email: account.email,
      ok: health.ok,
      code: health.code,
    });
    if (!health.ok && (health.code === 3012 || health.httpStatus === 405)) {
      setAccountStatus(account.id, "disabled");
      markAccountError(account.id, "3012 — аккаунт заблокирован на zcode-plan API");
    }
  }

  const alive = probed.filter((p) => p.ok).length;
  res.json({
    ...result,
    probe: { alive, dead: probed.length - alive, accounts: probed },
  });
});

app.post("/api/autoreg/:id/verify", async (req, res) => {
  const account = getAutoregAccount(req.params.id);
  if (!account?.api_key) {
    return res.status(400).json({ error: "no api key" });
  }
  const result = await verifyApiKey(account.api_key, account.proxy);
  if (!result.ok) {
    updateAutoregAccount(account.id, { status: "error", note: result.message });
  }
  res.json(result);
});

app.get("/api/proxies", (_req, res) => {
  const detailed = listProxiesDetailed();
  res.json({
    proxies: detailed.map((p) => ({
      index: p.index,
      masked: maskProxy(p.url),
      enabled: p.enabled,
      signup_blocked: p.signup_blocked,
      jobs_total: p.jobs_total,
      jobs_active: p.jobs_active,
      errors: p.errors,
      last_used_at: p.last_used_at,
    })),
    count: detailed.length,
    enabled_count: listEnabledProxies().length,
  });
});

app.post("/api/proxies", (req, res) => {
  const { text } = req.body as { text?: string };
  if (!text?.trim()) return res.status(400).json({ error: "text required" });
  res.json(addProxies(text));
});

app.patch("/api/proxies/:index/toggle", (req, res) => {
  const index = parseInt(req.params.index, 10);
  const { enabled } = req.body as { enabled?: boolean };
  if (Number.isNaN(index) || !toggleProxyByIndex(index, enabled ?? true)) {
    return res.status(404).json({ error: "proxy not found" });
  }
  res.json({ ok: true });
});

app.delete("/api/proxies/:index", (req, res) => {
  const index = parseInt(req.params.index, 10);
  if (Number.isNaN(index) || !deleteProxyByIndex(index)) {
    return res.status(404).json({ error: "proxy not found" });
  }
  res.json({ ok: true });
});

app.delete("/api/proxies", (_req, res) => {
  clearProxies();
  res.json({ ok: true });
});

app.post("/api/proxies/verify", async (req, res) => {
  const { proxy, check_signup } = req.body as {
    proxy?: string;
    check_signup?: boolean;
  };
  if (!proxy) return res.status(400).json({ error: "proxy required" });
  const basic = await verifyProxy(proxy);
  if (!check_signup) return res.json(basic);
  const signup = await probeProxySignupAccess(proxy);
  res.json({ ...basic, signup });
});

app.put("/api/autoreg/settings", (req, res) => {
  const { password_length, export_format, auto_save_file } = req.body;
  const settings = updateAutoregSettings({
    password_length,
    export_format,
    auto_save_file,
  });
  res.json(settings.autoreg);
});

app.post("/api/autoreg/parse-har", (req, res) => {
  try {
    const requests = parseHar(req.body);
    res.json({ count: requests.length, requests });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid HAR";
    res.status(400).json({ error: message });
  }
});

// --- Autoreg jobs (pipeline + debug) ---

app.get("/api/autoreg/captcha-config", (_req, res) => {
  res.json({
    sceneId: CAPTCHA_SCENE_ID,
    prefix: CAPTCHA_PREFIX,
    region: CAPTCHA_REGION,
    scriptUrl:
      "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js",
  });
});

app.get("/api/autoreg/jobs", (_req, res) => {
  res.json({
    jobs: listAutoregJobs().map((j) => getJobPublic(j)),
  });
});

app.get("/api/autoreg/jobs/:id", (req, res) => {
  const job = getAutoregJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  res.json(getJobPublic(job));
});

app.get("/api/autoreg/jobs/:id/egress", async (req, res) => {
  try {
    res.json(await getJobEgressInfo(req.params.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

app.post("/api/autoreg/jobs", async (req, res) => {
  const { email, username, password, mail_password, proxy } = req.body as {
    email?: string;
    username?: string;
    password?: string;
    mail_password?: string;
    proxy?: string;
  };
  if (!email?.includes("@")) {
    return res.status(400).json({ error: "email required" });
  }
  try {
    const job = await createJob({
      email,
      username: username || email.split("@")[0] || "user",
      password,
      mail_password: mail_password || undefined,
      proxy: proxy || null,
    });
    res.json(getJobPublic(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

app.post("/api/autoreg/jobs/bulk", async (req, res) => {
  const { text, lines } = req.body as { text?: string; lines?: string[] };
  const bulk = text || (lines || []).join("\n");
  const parsed = parseAutoregBulk(bulk);
  if (!parsed.length) {
    return res.status(400).json({ error: "no valid lines (email:mail_password)" });
  }
  try {
    const jobs = [];
    const assignedProxies = new Set<string>();
    for (const line of parsed) {
      const proxy =
        line.proxy ||
        pickLeastUsedProxyExcluding(assignedProxies, { forSignup: true }) ||
        null;
      if (proxy && !line.proxy) {
        assignedProxies.add(proxy);
      }
      jobs.push(
        await createJob({
          email: line.email,
          username: line.email.split("@")[0] || "user",
          mail_password: line.mail_password,
          password: line.password,
          proxy,
        })
      );
    }
    res.json({
      count: jobs.length,
      first_id: jobs[0]?.id,
      jobs: jobs.map((j) => getJobPublic(j)),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

app.post("/api/autoreg/jobs/:id/signup", async (req, res) => {
  const { captcha_verify_param } = req.body as {
    captcha_verify_param?: string;
  };
  if (!captcha_verify_param?.trim()) {
    return res.status(400).json({ error: "captcha_verify_param required" });
  }
  try {
    const job = await runSignup(req.params.id, captcha_verify_param);
    res.json(getJobPublic(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.get("/api/autoreg/jobs/:id/signup-form", (req, res) => {
  res.json(getSignupForm(req.params.id));
});

app.post("/api/autoreg/jobs/:id/captcha-solved", (req, res) => {
  try {
    const job = markCaptchaSolved(req.params.id);
    res.json(getJobPublic(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

app.post("/api/autoreg/jobs/:id/signup-proxy", async (req, res) => {
  const { captcha_verify_param } = req.body as { captcha_verify_param?: unknown };
  if (!captcha_verify_param) {
    return res.status(400).json({ error: "captcha_verify_param required" });
  }
  try {
    const job = await runProxiedSignup(req.params.id, captcha_verify_param);
    res.json(getJobPublic(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post("/api/autoreg/jobs/:id/signup-browser", (req, res) => {
  const { status, ok, body } = req.body as {
    status?: number;
    ok?: boolean;
    body?: string;
  };
  if (typeof status !== "number" || typeof body !== "string") {
    return res.status(400).json({ error: "status and body required" });
  }
  try {
    const job = completeBrowserSignup(req.params.id, {
      status,
      ok: Boolean(ok),
      body,
    });
    res.json(getJobPublic(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.get("/api/autoreg/jobs/:id/finish-form", (req, res) => {
  res.json(getFinishForm(req.params.id));
});

app.post("/api/autoreg/jobs/:id/finish-signup", async (req, res) => {
  try {
    const job = await runServerFinishSignup(req.params.id);
    res.json(getJobPublic(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post("/api/autoreg/jobs/:id/finish-browser", async (req, res) => {
  const { status, ok, body } = req.body as {
    status?: number;
    ok?: boolean;
    body?: string;
  };
  if (typeof status !== "number" || typeof body !== "string") {
    return res.status(400).json({ error: "status and body required" });
  }
  try {
    const job = await completeFinishSignup(req.params.id, {
      status,
      ok: Boolean(ok),
      body,
    });
    res.json(getJobPublic(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post("/api/autoreg/jobs/:id/retry-email", (req, res) => {
  try {
    const job = retryEmailWait(req.params.id);
    res.json(getJobPublic(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

app.post("/api/autoreg/jobs/:id/verify-email", async (req, res) => {
  const { text, verify_url } = req.body as { text?: string; verify_url?: string };
  const blob = text || verify_url || "";
  if (!blob.trim()) {
    return res.status(400).json({ error: "text or verify_url required" });
  }
  try {
    const job = await runVerifyEmail(req.params.id, blob);
    res.json(getJobPublic(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post("/api/autoreg/jobs/:id/zcode-run", (req, res) => {
  try {
    const job = startZcodeAutoregAsync(req.params.id);
    res.json(getJobPublic(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

app.post("/api/autoreg/accounts/:id/zcode-wrap", (req, res) => {
  try {
    const job = wrapAutoregAccountInZcode(req.params.id);
    res.json({ ok: true, job: getJobPublic(job) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

app.post("/api/autoreg/jobs/:id/auto-run", async (req, res) => {
  try {
    const job = await runFullAutoreg(req.params.id);
    res.json(getJobPublic(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post("/api/autoreg/jobs/:id/auto-captcha", async (req, res) => {
  try {
    const job = await runAutoCaptchaSignup(req.params.id);
    res.json(getJobPublic(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post("/api/autoreg/jobs/:id/poll-mail", async (req, res) => {
  try {
    const job = await runPollMail(req.params.id);
    res.json(getJobPublic(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post("/api/autoreg/jobs/:id/zcode-oauth/init", async (req, res) => {
  try {
    const job = await startZcodeOAuth(req.params.id);
    res.json(getJobPublic(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post("/api/autoreg/jobs/:id/zcode-oauth/poll", async (req, res) => {
  try {
    const job = await pollZcodeOAuthJob(req.params.id);
    res.json(getJobPublic(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post("/api/autoreg/jobs/:id/zcode-captcha", (req, res) => {
  const { captcha_verify_param, captcha_expires_at } = req.body as {
    captcha_verify_param?: string;
    captcha_expires_at?: string;
  };
  if (!captcha_verify_param?.trim()) {
    return res.status(400).json({ error: "captcha_verify_param required" });
  }
  try {
    const job = submitJobZcodeCaptcha(
      req.params.id,
      captcha_verify_param,
      captcha_expires_at
    );
    res.json(getJobPublic(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post("/api/autoreg/jobs/:id/cancel", async (req, res) => {
  try {
    const job = await cancelAutoregJob(req.params.id);
    res.json(getJobPublic(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

app.post("/api/autoreg/jobs/cancel-all", async (_req, res) => {
  try {
    const result = await cancelAllAutoregJobs();
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.delete("/api/autoreg/jobs/:id", (req, res) => {
  res.json({ ok: deleteAutoregJob(req.params.id) });
});

// --- OpenAI-compatible proxy ---

app.all("/v1/*", (req, res) => {
  const settings = getSettings();
  const anthropicPath =
    req.path === "/v1/messages" || req.path.startsWith("/v1/messages/");
  if (isAnthropicEndpoint(settings.endpoint) || anthropicPath) {
    if (
      !anthropicPath &&
      !isOpenAiPath(req.path) &&
      req.path !== "/v1/models"
    ) {
      return res.status(404).json({ error: { message: "Not found" } });
    }
    return proxyAnthropic(req, res);
  }
  if (!isOpenAiPath(req.path)) {
    return res.status(404).json({ error: { message: "Not found" } });
  }
  return proxyToZai(req, res);
});

// --- Dashboard ---

const publicDir = path.join(__dirname, "..", "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get("/", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

app.listen(PORT, () => {
  const settings = getSettings();
  const stats = getStats();
  console.log(`
╔══════════════════════════════════════════════════╗
║           Z.AI Gateway — Multi-Account           ║
╠══════════════════════════════════════════════════╣
║  Dashboard:  http://127.0.0.1:${PORT}               ║
║  API:        http://127.0.0.1:${PORT}/v1            ║
║  Endpoint:   ${settings.endpoint.padEnd(34)}║
║  Accounts:   ${String(stats.total ?? 0).padEnd(34)}║
╚══════════════════════════════════════════════════╝

OpenAI client config:
  base_url = "http://127.0.0.1:${PORT}/v1"
  api_key  = "${settings.proxy_api_key || "any-key (proxy auth disabled)"}"
`);
});
