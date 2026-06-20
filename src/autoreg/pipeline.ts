import { nanoid } from "nanoid";
import {
  generatePassword,
  maskProxy,
  parseRetryAfterSeconds,
  parseVerifyFromText,
} from "../autoreg.js";
import {
  createAutoregAccount,
  getAutoregAccount,
  getAutoregJob,
  listAutoregJobs,
  listSignupProxies,
  markProxyJobEnd,
  markProxyJobStart,
  markProxySignupBlocked,
  pickLeastUsedProxy,
  saveAutoregJob,
} from "../db.js";
import { syncJobToZcodePool } from "../zcode/pool.js";
import { initZcodeCliOAuth, pollZcodeCliOAuth } from "../zcode/oauth-cli.js";
import { newZcodeSessionId } from "../zcode/headers.js";
import { pollFirstmailForVerify } from "./mail.js";
import type { AutoregJob } from "./types.js";
import { DEFAULT_AVATAR } from "./types.js";
import {
  DIRECT_MARKER,
  closeJobBrowserProxy,
  ensureJobBrowserProxy,
  getJobBrowserProxy,
  isDirectProxy,
} from "./job-proxy.js";
import { clearBrowserSession } from "./browser-session.js";
import {
  describeSignupHttpResult,
  formatCaptchaParamSummary,
  formatSignupFailureSummary,
  isCaptchaRelatedSignupError,
} from "./debug-log.js";
import {
  chatFinishSignup,
  chatSignup,
  copyApiKeySecret,
  createApiKey,
  getCustomerInfo,
  platformLogin,
} from "./zai-client.js";
import { jobLog } from "./logger.js";
import { fetchEgressIp } from "../proxy-util.js";
import {
  JobCancelledError,
  abortJobRun,
  beginJobRun,
  endJobRun,
  isJobRunning,
  registerJobBrowser,
  throwIfCancelled,
} from "./job-runner.js";
import { isSignupWafBlocked } from "./signup-waf.js";

function resolveJobProxy(jobId: string, upstream: string): string {
  const bp = getJobBrowserProxy(jobId);
  return bp?.url ?? upstream;
}

async function ensureJobProxyTunnel(jobId: string, upstream: string): Promise<string> {
  const bp = await ensureJobBrowserProxy(jobId, upstream);
  return bp.url;
}

function fail(job: AutoregJob, step: string, message: string, data?: unknown): AutoregJob {
  job.step = "error";
  job.error = message;
  jobLog(job, "error", step, message, data);
  saveAutoregJob(job);
  return job;
}

/** Локальный прокси для браузера (капча с того же IP, что signup на сервере). */
export async function prepareJobBrowserProxy(jobId: string): Promise<{
  host: string;
  port: number;
  display: string;
}> {
  const job = getAutoregJob(jobId);
  if (!job) throw new Error("job not found");
  if (!job.proxy) throw new Error("no proxy on job");

  const bp = await ensureJobBrowserProxy(jobId, job.proxy);
  job.step = "captcha";
  job.error = null;
  jobLog(
    job,
    "info",
    "captcha",
    `Ручная капча — включи прокси браузера ${bp.display}, затем сдвинь слайдер`,
    { browser_proxy: bp.display }
  );
  saveAutoregJob(job);
  return { host: bp.host, port: bp.port, display: bp.display };
}

/** IMAP → finish → API key (после ручной капчи + signup). */
export async function runAutoregContinue(jobId: string): Promise<AutoregJob> {
  const initial = getAutoregJob(jobId);
  if (!initial) throw new Error("job not found");
  if (initial.step === "cancelled") return initial;
  if (initial.step !== "email_wait" && initial.step !== "finish_signup") {
    throw new Error(`job step is ${initial.step}, expected email_wait`);
  }

  const signal = beginJobRun(jobId);
  const proxyUrl = initial.proxy ?? null;
  let proxyStarted = false;
  if (proxyUrl) {
    markProxyJobStart(proxyUrl);
    proxyStarted = true;
  }

  try {
    throwIfCancelled(jobId, signal);

    let job = getAutoregJob(jobId)!;
    if (!job.mail_password) {
      job.error = "Нет mail_password — укажи пароль Firstmail";
      saveAutoregJob(job);
      return job;
    }

    jobLog(job, "info", "email_wait", "Авто-IMAP — ждём verify письмо…");
    saveAutoregJob(job);

    for (let i = 0; i < 30; i++) {
      throwIfCancelled(jobId, signal);
      await sleepInterruptible(i === 0 ? 15000 : 6000, jobId, signal);
      job = await runPollMail(jobId);
      if (job.step === "cancelled") return job;
      if (job.step === "done") return job;
      if (
        job.step === "zcode_oauth" ||
        job.step === "zcode_captcha" ||
        job.step === "api_key"
      ) {
        return job;
      }
      if (job.step === "error" || job.step === "captcha") return job;
    }

    const last = getAutoregJob(jobId);
    if (last) {
      last.error = last.error || "Таймаут ожидания письма (3 мин)";
      saveAutoregJob(last);
      return last;
    }
    throw new Error("job lost");
  } catch (err) {
    if (err instanceof JobCancelledError) {
      const j = getAutoregJob(jobId);
      if (j && j.step !== "cancelled") return markJobCancelled(j);
      return j!;
    }
    throw err;
  } finally {
    endJobRun(jobId);
    if (proxyStarted && proxyUrl) {
      const final = getAutoregJob(jobId);
      markProxyJobEnd(proxyUrl, final?.step === "error");
    }
    await closeJobBrowserProxy(jobId).catch(() => {});
    clearBrowserSession(jobId);
  }
}

export async function createJob(input: {
  email: string;
  username: string;
  password?: string;
  mail_password?: string | null;
  proxy?: string | null;
}): Promise<AutoregJob> {
  const proxy =
    input.proxy ??
    pickLeastUsedProxy(undefined, { forSignup: true }) ??
    DIRECT_MARKER; // direct = идти напрямую с локального IP (без прокси)

  const job: AutoregJob = {
    id: nanoid(12),
    email: input.email.trim().toLowerCase(),
    username: input.username.trim(),
    password: input.password || generatePassword(14),
    mail_password: input.mail_password?.trim() || null,
    proxy,
    step: "captcha",
    logs: [],
    chat_token: null,
    platform_token: null,
    org_id: null,
    project_id: null,
    api_key: null,
    autoreg_account_id: null,
    zcode_jwt: null,
    zcode_oauth_access_token: null,
    zcode_user_id: null,
    zcode_session_id: null,
    zcode_oauth_flow_id: null,
    zcode_oauth_poll_token: null,
    zcode_authorize_url: null,
    zcode_captcha_param: null,
    zcode_captcha_expires_at: null,
    captcha_solved_at: null,
    signup_at: null,
    last_verify_mail_at: null,
    last_verify_token: null,
    pending_verify_token: null,
    pending_verify_mail_at: null,
    pending_verify_username: null,
    signup_via_proxy: true,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  jobLog(job, "info", "created", "Задача создана — весь autorег через одно прокси", {
    email: job.email,
    username: job.username,
    proxy: maskProxy(job.proxy),
    has_mail_password: Boolean(job.mail_password),
  });
  saveAutoregJob(job);
  return job;
}

export function normalizeCaptchaParam(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (typeof o.captchaVerifyParam === "string") {
      return o.captchaVerifyParam.trim();
    }
    if (typeof o.captcha_verify_param === "string") {
      return o.captcha_verify_param.trim();
    }
  }
  return String(raw ?? "").trim();
}

/** Called when user solved captcha — mail filter starts from this instant */
export function markCaptchaSolved(jobId: string): AutoregJob {
  const job = getAutoregJob(jobId);
  if (!job) throw new Error("job not found");

  const now = new Date().toISOString();
  job.captcha_solved_at = now;
  job.last_verify_mail_at = null;
  job.last_verify_token = null;
  job.pending_verify_token = null;
  job.pending_verify_mail_at = null;
  job.pending_verify_username = null;
  job.signup_via_proxy = true;
  job.error = null;
  jobLog(job, "info", "captcha", "Капча решена — signup/finish через прокси задачи", {
    captcha_solved_at: now,
    proxy: maskProxy(job.proxy),
  });
  saveAutoregJob(job);
  return job;
}

/** Credentials for browser-side signup (captcha must match browser IP) */
export function getSignupForm(jobId: string): {
  ok: true;
  username: string;
  email: string;
  password: string;
  profile_image_url: string;
  signup_url: string;
} | { ok: false; error: string } {
  const job = getAutoregJob(jobId);
  if (!job) return { ok: false, error: "job not found" };
  if (job.step !== "captcha" && job.step !== "error") {
    return { ok: false, error: `job step is ${job.step}, expected captcha` };
  }
  return {
    ok: true,
    username: job.username,
    email: job.email,
    password: job.password,
    profile_image_url: DEFAULT_AVATAR,
    signup_url: "https://chat.z.ai/api/v1/auths/signup",
  };
}

export function completeBrowserSignup(
  jobId: string,
  result: { status: number; ok: boolean; body: string }
): AutoregJob {
  const job = getAutoregJob(jobId);
  if (!job) throw new Error("job not found");

  job.signup_via_proxy = true;
  job.step = "signup";
  job.error = null;
  jobLog(job, "info", "signup", "Signup через прокси (legacy browser endpoint)", {
    http_status: result.status,
    proxy: maskProxy(job.proxy),
  });
  jobLog(job, "debug", "signup", `HTTP ${result.status}`, {
    response: result.body.slice(0, 500),
  });

  return applySignupHttpResult(job, result);
}

function applySignupHttpResult(
  job: AutoregJob,
  result: { status: number; ok: boolean; body: string }
): AutoregJob {
  let data: { success?: boolean; detail?: string } | null = null;
  try {
    data = JSON.parse(result.body) as { success?: boolean; detail?: string };
  } catch {
    /* raw */
  }

  if (!result.ok || !data?.success) {
    const msg = data
      ? JSON.stringify(data).slice(0, 300)
      : result.body.slice(0, 300);
    if (result.status === 429) {
      const waitSec = parseRetryAfterSeconds(result.body, 60);
      job.step = "captcha";
      job.error = `Rate limit на signup (429) — подождите ~${waitSec} сек и запустите снова (не параллельно много аккаунтов)`;
      jobLog(job, "warn", "signup", job.error, {
        status: result.status,
        response: result.body.slice(0, 300),
      });
      saveAutoregJob(job);
      return job;
    }
    if (isSignupWafBlocked(result.status, result.body)) {
      if (job.proxy) markProxySignupBlocked(job.proxy);
      job.step = "error";
      job.error =
        "Прокси заблокирован WAF для signup (HTTP 405). Нужен residential-прокси или другой IP — datacenter часто режут.";
      jobLog(job, "error", "signup", job.error, {
        status: result.status,
        proxy: maskProxy(job.proxy),
        response: result.body.slice(0, 200),
      });
      saveAutoregJob(job);
      return job;
    }
    if (
      isCaptchaRelatedSignupError(result.status, result.body)
    ) {
      const signupDbg = describeSignupHttpResult(result);
      const apiDetail =
        signupDbg.detail ||
        signupDbg.bodyPreview.slice(0, 200) ||
        "unknown error";
      job.step = "captcha";
      job.error = job.proxy
        ? `Signup HTTP ${result.status}: ${apiDetail} (proxy ${maskProxy(job.proxy)})`
        : `Signup HTTP ${result.status}: ${apiDetail}`;
      jobLog(job, "error", "signup", job.error, {
        status: result.status,
        detail: signupDbg.detail,
        response: signupDbg.bodyPreview,
        captcha_related: true,
        proxy: maskProxy(job.proxy),
      });
      saveAutoregJob(job);
      return job;
    }
    return fail(
      job,
      "signup",
      `Signup failed HTTP ${result.status}: ${msg}`
    );
  }

  job.step = "email_wait";
  job.signup_at = new Date().toISOString();
  job.last_verify_mail_at = null;
  job.last_verify_token = null;
  job.pending_verify_token = null;
  job.pending_verify_mail_at = null;
  job.pending_verify_username = null;
  jobLog(
    job,
    "success",
    "signup",
    job.mail_password
      ? "Signup OK — ждём письмо (IMAP Firstmail или вставь .eml вручную)"
      : "Signup OK — проверь почту и вставь ссылку / .eml ниже"
  );
  saveAutoregJob(job);
  return job;
}

/** Signup через прокси задачи (капча должна быть решена с exit-IP этого прокси) */
export async function runProxiedSignup(
  jobId: string,
  captchaVerifyParam: unknown
): Promise<AutoregJob> {
  const param = normalizeCaptchaParam(captchaVerifyParam);
  if (!param) throw new Error("empty captcha_verify_param");

  markCaptchaSolved(jobId);
  const job = getAutoregJob(jobId);
  if (!job) throw new Error("job not found");
  if (!job.proxy) {
    return fail(job, "signup", "Нет прокси у задачи — создай задачу заново");
  }

  job.signup_via_proxy = true;
  job.step = "signup";
  job.error = null;
  const proxyUrl = await ensureJobProxyTunnel(jobId, job.proxy);
  jobLog(job, "info", "signup", "POST /api/v1/auths/signup через прокси задачи", {
    proxy: maskProxy(job.proxy),
    browser_proxy: maskProxy(proxyUrl),
  });
  saveAutoregJob(job);

  const res = await chatSignup(
    {
      name: job.username,
      email: job.email,
      password: job.password,
      captcha_verify_param: param,
    },
    proxyUrl
  );

  jobLog(job, "debug", "signup", `HTTP ${res.status}`, {
    response: res.text.slice(0, 500),
    proxy: maskProxy(job.proxy),
  });

  return applySignupHttpResult(job, {
    status: res.status,
    ok: res.ok,
    body: res.text,
  });
}

export async function runSignup(
  jobId: string,
  captchaVerifyParam: unknown
): Promise<AutoregJob> {
  return runProxiedSignup(jobId, captchaVerifyParam);
}

export async function runPollMail(jobId: string): Promise<AutoregJob> {
  const job = getAutoregJob(jobId);
  if (!job) throw new Error("job not found");
  if (!job.mail_password) {
    return fail(job, "email_wait", "Нет пароля почты — укажи mail_password (Firstmail)");
  }

  const notBefore = job.signup_at
    ? new Date(job.signup_at)
    : job.captcha_solved_at
      ? new Date(job.captcha_solved_at)
      : null;

  if (!notBefore) {
    job.step = "email_wait";
    job.error = "Сначала пройди капчу и signup";
    jobLog(job, "warn", "email_wait", job.error);
    saveAutoregJob(job);
    return job;
  }

  jobLog(job, "info", "email_wait", "IMAP — письмо после signup…", {
    signup_at: job.signup_at,
    captcha_solved_at: job.captcha_solved_at,
    last_verify_mail_at: job.last_verify_mail_at,
  });
  saveAutoregJob(job);

  const result = await pollFirstmailForVerify(job.email, job.mail_password, {
    notBefore,
    skipIfMessageBeforeOrEqual: job.last_verify_mail_at
      ? new Date(job.last_verify_mail_at)
      : undefined,
    skipToken: job.last_verify_token ?? undefined,
  });

  jobLog(job, result.ok ? "success" : "warn", "email_wait", result.message, {
    subject: result.subject,
    from: result.from,
    messageDate: result.messageDate,
    signup_at: job.signup_at,
    captcha_solved_at: job.captcha_solved_at,
  });

  if (!result.ok || !result.verifyText || !result.token) {
    job.step = "email_wait";
    job.error = result.ok ? null : result.message;
    saveAutoregJob(job);
    return job;
  }

  return queueBrowserFinishSignup(jobId, result.verifyText, {
    messageDate: result.messageDate,
    token: result.token,
  });
}

async function queueBrowserFinishSignup(
  jobId: string,
  verifyText: string,
  meta: { messageDate?: string; token: string }
): Promise<AutoregJob> {
  const job = getAutoregJob(jobId);
  if (!job) throw new Error("job not found");

  const parsed = parseVerifyFromText(verifyText, job.email);
  if (!parsed) {
    return fail(
      job,
      "email_wait",
      "Не нашёл verify_email ссылку в тексте. Вставь .eml или URL."
    );
  }

  if (parsed.email.toLowerCase() !== job.email.toLowerCase()) {
    return fail(
      job,
      "email_wait",
      `Email в ссылке (${parsed.email}) не совпадает с задачей (${job.email})`
    );
  }

  // Проверка даты письма vs signup — отключаемой (рассинхрон часов у почтовых
  // провайдеров). Идемпотентность finish уже обеспечивается skipToken/skipBefore
  // в mail.ts, поэтому при STRICT_TIME!=1 дату не сверяем.
  const STRICT_TIME_MAIL = process.env.FIRSTMAIL_STRICT_TIME === "1"
    || process.env.FIRSTMAIL_STRICT_TIME === "true";

  if (STRICT_TIME_MAIL && job.signup_at && meta.messageDate) {
    const mailTs = new Date(meta.messageDate).getTime();
    const signupTs = new Date(job.signup_at).getTime();
    if (mailTs < signupTs + 3000) {
      job.step = "email_wait";
      job.error = "Письмо пришло до signup — жди новое";
      jobLog(job, "warn", "email_wait", job.error, {
        messageDate: meta.messageDate,
        signup_at: job.signup_at,
      });
      saveAutoregJob(job);
      return job;
    }
  } else if (job.captcha_solved_at && meta.messageDate) {
    const mailTs = new Date(meta.messageDate).getTime();
    const capTs = new Date(job.captcha_solved_at).getTime();
    if (mailTs <= capTs) {
      job.step = "email_wait";
      job.error = "Письмо старше капчи — дождись нового письма";
      jobLog(job, "warn", "email_wait", job.error, {
        messageDate: meta.messageDate,
        captcha_solved_at: job.captcha_solved_at,
      });
      saveAutoregJob(job);
      return job;
    }
  }

  if (job.last_verify_token && parsed.token === job.last_verify_token) {
    job.step = "email_wait";
    job.error = "Этот токен уже не подошёл — жди новое письмо";
    saveAutoregJob(job);
    return job;
  }

  job.pending_verify_token = parsed.token;
  job.pending_verify_username = parsed.username;
  job.pending_verify_mail_at = meta.messageDate ?? null;
  job.step = "email_wait";
  job.error = null;
  jobLog(job, "info", "finish_signup", "Письмо OK — finish_signup из браузера", {
    messageDate: meta.messageDate,
    token: `${parsed.token.slice(0, 12)}...`,
  });
  saveAutoregJob(job);
  return runServerFinishSignup(jobId);
}

export async function runAutoCaptchaSignup(
  jobId: string,
  depth = 0,
  signal?: AbortSignal
): Promise<AutoregJob> {
  const job = getAutoregJob(jobId);
  if (!job) throw new Error("job not found");
  if (job.step === "cancelled") return job;
  if (!job.proxy) {
    const picked = pickLeastUsedProxy(undefined, { forSignup: true });
    if (picked) {
      job.proxy = picked;
      saveAutoregJob(job);
    }
  }
  if (!job.proxy) {
    return fail(job, "captcha", "Нет прокси — добавь и включи хотя бы один в пуле");
  }
  if (job.step !== "captcha" && job.step !== "error") {
    throw new Error(`job step is ${job.step}, expected captcha`);
  }

  throwIfCancelled(jobId, signal);

  job.step = "captcha";
  job.error = null;
  const proxyUrl = await ensureJobProxyTunnel(jobId, job.proxy!);
  jobLog(job, "info", "captcha", "Автокапча (Playwright + job.proxy, один IP)…", {
    proxy: maskProxy(job.proxy),
    browser_proxy: maskProxy(proxyUrl),
  });
  saveAutoregJob(job);

  try {
    const { solveCaptchaAndSignupWithPlaywright } = await import(
      "./captcha-playwright.js"
    );

    const report = (message: string, step: "captcha" | "signup" = "captcha") => {
      const j = getAutoregJob(jobId);
      if (!j) return;
      j.step = step;
      j.error = null;
      jobLog(j, "info", step, message);
      saveAutoregJob(j);
    };

    const started = Date.now();
    const heartbeat = setInterval(() => {
      const j = getAutoregJob(jobId);
      if (!j || j.step === "email_wait" || j.step === "done" || j.step === "error") {
        return;
      }
      const sec = Math.round((Date.now() - started) / 1000);
      j.error = null;
      jobLog(j, "debug", j.step, `В процессе… ${sec} сек`);
      saveAutoregJob(j);
    }, 5000);

    let captchaParam: string;
    let signup: { status: number; ok: boolean; body: string };

    try {
      const result = await solveCaptchaAndSignupWithPlaywright({
        proxy: proxyUrl,
        jobId,
        signup: {
          name: job.username,
          email: job.email,
          password: job.password,
          profile_image_url: DEFAULT_AVATAR,
        },
        onProgress: (msg, step) => report(msg, step ?? "captcha"),
        signal,
        onBrowser: (close) => registerJobBrowser(jobId, close),
      });
      captchaParam = result.captchaParam;
      signup = result.signup;
    } finally {
      clearInterval(heartbeat);
    }

    markCaptchaSolved(jobId);
    const afterCaptcha = getAutoregJob(jobId);
    if (!afterCaptcha) throw new Error("job not found");

    afterCaptcha.signup_via_proxy = true;
    afterCaptcha.step = "signup";
    afterCaptcha.error = null;
    jobLog(afterCaptcha, "success", "captcha", "Капча решена автоматически", {
      param_summary: formatCaptchaParamSummary(captchaParam),
    });
    if (!signup.ok || !signup.body.includes('"success":true')) {
      jobLog(afterCaptcha, "warn", "signup", formatSignupFailureSummary(signup), {
        ...describeSignupHttpResult(signup),
        param_summary: formatCaptchaParamSummary(captchaParam),
        proxy: maskProxy(afterCaptcha.proxy),
      });
    } else {
      jobLog(afterCaptcha, "info", "signup", `Signup OK HTTP ${signup.status}`, {
        proxy: maskProxy(afterCaptcha.proxy),
      });
    }
    saveAutoregJob(afterCaptcha);

    const result = applySignupHttpResult(afterCaptcha, signup);
    if (
      isSignupWafBlocked(signup.status, signup.body) &&
      depth < 3
    ) {
      const blockedProxy = afterCaptcha.proxy;
      if (blockedProxy) markProxySignupBlocked(blockedProxy);
      const nextProxy = pickLeastUsedProxy(undefined, { forSignup: true });
      if (nextProxy && nextProxy !== blockedProxy) {
        afterCaptcha.proxy = nextProxy;
        afterCaptcha.step = "captcha";
        afterCaptcha.error = null;
        jobLog(
          afterCaptcha,
          "warn",
          "signup",
          "Прокси заблокирован WAF для signup — пробуем другой…",
          { proxy: maskProxy(nextProxy) }
        );
        saveAutoregJob(afterCaptcha);
        return runAutoCaptchaSignup(jobId, depth + 1, signal);
      }
    }
    if (result.step === "captcha" && signup.status === 429 && depth < 2) {
      const waitSec = parseRetryAfterSeconds(signup.body);
      jobLog(result, "info", "signup", `Rate limit — ждём ${waitSec} сек, повтор…`);
      saveAutoregJob(result);
      await sleepInterruptible(waitSec * 1000, jobId, signal);
      const again = getAutoregJob(jobId);
      if (again) {
        again.step = "captcha";
        again.error = null;
        saveAutoregJob(again);
      }
      return runAutoCaptchaSignup(jobId, depth + 1, signal);
    }
    // 400 "captcha verification failed" — Aliyun отклонил решение (вероятностно,
    // ~30-40% случаев). Просто перепостановим капчу (до 4 попыток).
    if (
      result.step === "captcha" &&
      signup.status === 400 &&
      /captcha/i.test(signup.body) &&
      depth < 4
    ) {
      jobLog(
        result,
        "warn",
        "signup",
        "Капча отклонена Aliyun (400) — перепостановляю и повторяю…",
        { depth: depth + 1 }
      );
      result.step = "captcha";
      result.error = null;
      saveAutoregJob(result);
      return runAutoCaptchaSignup(jobId, depth + 1, signal);
    }
    return result;
  } catch (err) {
    if (err instanceof JobCancelledError) {
      const j = getAutoregJob(jobId);
      if (j && j.step !== "cancelled") return markJobCancelled(j);
      return j!;
    }
    const msg = err instanceof Error ? err.message : String(err);
    job.step = "captcha";
    job.error = `Автокапча: ${msg}`;
    jobLog(job, "error", "captcha", job.error);
    saveAutoregJob(job);
    return job;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sleepInterruptible(
  ms: number,
  jobId: string,
  signal?: AbortSignal
): Promise<void> {
  const chunk = 400;
  let left = ms;
  while (left > 0) {
    throwIfCancelled(jobId, signal);
    await sleep(Math.min(chunk, left));
    left -= chunk;
  }
}

function markJobCancelled(job: AutoregJob): AutoregJob {
  job.step = "cancelled";
  job.error = "Отменено пользователем";
  jobLog(job, "warn", "cancelled", job.error);
  saveAutoregJob(job);
  return job;
}

export async function cancelAutoregJob(jobId: string): Promise<AutoregJob> {
  const job = getAutoregJob(jobId);
  if (!job) throw new Error("job not found");
  if (job.step === "done" || job.step === "cancelled") return job;

  await abortJobRun(jobId);
  return markJobCancelled(job);
}

export async function cancelAllAutoregJobs(): Promise<{ cancelled: number }> {
  let cancelled = 0;
  for (const job of listAutoregJobs()) {
    if (job.step === "done" || job.step === "cancelled") continue;
    await cancelAutoregJob(job.id);
    cancelled++;
  }
  return { cancelled };
}

/** Капча → signup → IMAP → finish → platform (до zcode_oauth). */
export async function runFullAutoreg(jobId: string): Promise<AutoregJob> {
  const initial = getAutoregJob(jobId);
  if (!initial) throw new Error("job not found");
  if (initial.step === "cancelled") return initial;

  const signal = beginJobRun(jobId);
  const proxyUrl = initial.proxy ?? null;
  let proxyStarted = false;
  if (proxyUrl) {
    markProxyJobStart(proxyUrl);
    proxyStarted = true;
  }

  try {
    throwIfCancelled(jobId, signal);

    let job = await runAutoCaptchaSignup(jobId, 0, signal);
    if (job.step === "cancelled") return job;
    if (job.step !== "email_wait") return job;
    if (!job.mail_password) {
      job.error = "Нет mail_password — укажи пароль Firstmail для авто-IMAP";
      saveAutoregJob(job);
      return job;
    }

    jobLog(job, "info", "email_wait", "Авто-IMAP — ждём verify письмо…");
    saveAutoregJob(job);

    for (let i = 0; i < 30; i++) {
      throwIfCancelled(jobId, signal);
      await sleepInterruptible(i === 0 ? 15000 : 6000, jobId, signal);
      job = await runPollMail(jobId);
      if (job.step === "cancelled") return job;
      if (job.step === "done") return job;
      if (
        job.step === "platform_login" ||
        job.step === "api_key" ||
        job.step === "zcode_oauth" ||
        job.step === "zcode_captcha"
      ) {
        if (job.step === "zcode_oauth" || job.step === "zcode_captcha") {
          return startZcodeAutoregAsync(jobId);
        }
        return job;
      }
      if (job.step === "error" || job.step === "captcha") return job;
    }

    const last = getAutoregJob(jobId);
    if (last) {
      last.error = last.error || "Таймаут ожидания письма (3 мин)";
      saveAutoregJob(last);
      return last;
    }
    throw new Error("job lost");
  } catch (err) {
    if (err instanceof JobCancelledError) {
      const j = getAutoregJob(jobId);
      if (j && j.step !== "cancelled") return markJobCancelled(j);
      return j!;
    }
    throw err;
  } finally {
    endJobRun(jobId);
    if (proxyStarted && proxyUrl) {
      const final = getAutoregJob(jobId);
      markProxyJobEnd(proxyUrl, final?.step === "error");
    }
    await closeJobBrowserProxy(jobId).catch(() => {});
    clearBrowserSession(jobId);
  }
}

export function getFinishForm(jobId: string): {
  ok: true;
  username: string;
  email: string;
  password: string;
  token: string;
  profile_image_url: string;
  finish_url: string;
  verify_url: string;
  console_finish_script: string;
} | { ok: false; error: string } {
  const job = getAutoregJob(jobId);
  if (!job) return { ok: false, error: "job not found" };
  if (!job.pending_verify_token) {
    return { ok: false, error: "no pending verify token — poll mail first" };
  }
  const username = job.pending_verify_username || job.username;
  const token = job.pending_verify_token;
  const verifyUrl =
    `https://chat.z.ai/auth/verify_email?token=${encodeURIComponent(token)}` +
    `&email=${encodeURIComponent(job.email)}` +
    `&username=${encodeURIComponent(username)}&language=en`;
  const finishPayload = {
    username,
    email: job.email,
    password: job.password,
    token,
    profile_image_url: DEFAULT_AVATAR,
    sso_redirect: null,
  };
  const finishBody = JSON.stringify(finishPayload);
  const consoleFinishScript =
    `(async()=>{const r=await fetch("https://chat.z.ai/api/v1/auths/finish_signup",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json","x-region":"overseas"},body:${JSON.stringify(finishBody)}});const body=await r.text();const msg={type:"zai_finish",status:r.status,ok:r.ok,body};if(window.opener){window.opener.postMessage(msg,"*");alert("finish → dashboard ("+r.status+")");}else{console.log(msg);alert(r.status+" "+body.slice(0,120));}})()`;
  return {
    ok: true,
    username,
    email: job.email,
    password: job.password,
    token,
    profile_image_url: DEFAULT_AVATAR,
    finish_url: "https://chat.z.ai/api/v1/auths/finish_signup",
    verify_url: verifyUrl,
    console_finish_script: consoleFinishScript,
  };
}

export async function runServerFinishSignup(jobId: string): Promise<AutoregJob> {
  const job = getAutoregJob(jobId);
  if (!job) throw new Error("job not found");

  if (!job.pending_verify_token && job.last_verify_token) {
    job.pending_verify_token = job.last_verify_token;
    job.pending_verify_mail_at = job.last_verify_mail_at;
    job.pending_verify_username ??= job.username;
    jobLog(job, "info", "finish_signup", "Повтор finish с тем же токеном");
    saveAutoregJob(job);
  }

  if (!job.pending_verify_token) {
    throw new Error("no verify token — poll mail first");
  }
  if (!job.proxy) {
    throw new Error("нет прокси у задачи — весь finish идёт через job.proxy");
  }

  const username = job.pending_verify_username || job.username;
  const token = job.pending_verify_token;

  const verifyUrl =
    `https://chat.z.ai/auth/verify_email?token=${encodeURIComponent(token)}` +
    `&email=${encodeURIComponent(job.email)}` +
    `&username=${encodeURIComponent(username)}&language=en`;

  const payload = {
    username,
    email: job.email,
    password: job.password,
    token,
  };

  job.step = "finish_signup";
  job.error = null;
  const proxyUrl = getJobBrowserProxy(jobId)
    ? resolveJobProxy(jobId, job.proxy)
    : await ensureJobProxyTunnel(jobId, job.proxy);
  jobLog(job, "info", "finish_signup", "finish_signup через Playwright (verify + cookies)", {
    token: `${token.slice(0, 12)}...`,
    messageDate: job.pending_verify_mail_at,
    finish_proxy: maskProxy(proxyUrl),
  });
  saveAutoregJob(job);

  let fin: { status: number; ok: boolean; text: string };
  try {
    const { finishSignupWithPlaywright } = await import("./captcha-playwright.js");
    const pw = await finishSignupWithPlaywright({
      proxy: proxyUrl,
      jobId,
      username,
      email: job.email,
      password: job.password,
      token,
      profile_image_url: DEFAULT_AVATAR,
      onProgress: (msg) => {
        const j = getAutoregJob(jobId);
        if (j) jobLog(j, "info", "finish_signup", msg);
      },
    });
    fin = { status: pw.status, ok: pw.ok, text: pw.body };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    jobLog(job, "warn", "finish_signup", `Playwright finish: ${msg}, fallback HTTP…`);
    saveAutoregJob(job);
    const http = await chatFinishSignup(payload, {
      proxy: proxyUrl,
      referer: verifyUrl,
    });
    fin = { status: http.status, ok: http.ok, text: http.text };
  }

  return completeFinishSignup(jobId, {
    status: fin.status,
    ok: fin.ok,
    body: fin.text,
  });
}

export async function completeFinishSignup(
  jobId: string,
  result: { status: number; ok: boolean; body: string }
): Promise<AutoregJob> {
  const job = getAutoregJob(jobId);
  if (!job) throw new Error("job not found");
  const token = job.pending_verify_token;
  const mailAt = job.pending_verify_mail_at;

  job.step = "finish_signup";
  job.error = null;
  jobLog(job, "info", "finish_signup", "finish_signup → chat.z.ai", {
    http_status: result.status,
    messageDate: mailAt,
  });
  jobLog(
    job,
    result.ok ? "debug" : "warn",
    "finish_signup",
    `HTTP ${result.status}: ${result.body.slice(0, 200)}`,
    { response: result.body.slice(0, 400) }
  );

  type FinishSignupResponse = {
    success?: boolean;
    user?: { token?: string };
    detail?: string;
  };

  let data: FinishSignupResponse | null = null;
  try {
    data = JSON.parse(result.body) as FinishSignupResponse;
  } catch {
    /* raw */
  }

  if (!result.ok || !data?.success || !data.user?.token) {
    const detail = result.body.slice(0, 300);
    if (
      result.status === 400 &&
      detail.toLowerCase().includes("invalid verification token")
    ) {
      job.pending_verify_token = null;
      job.pending_verify_mail_at = null;
      job.pending_verify_username = null;
      job.last_verify_mail_at = mailAt;
      job.last_verify_token = token;
      job.step = "email_wait";
      job.error =
        "Токен не подошёл — возможно другой IP прокси или письмо устарело. Повтори finish или создай задачу заново.";
      jobLog(job, "warn", "email_wait", job.error, {
        response: detail,
      });
      saveAutoregJob(job);
      return job;
    }
    if (result.status === 429) {
      job.step = "email_wait";
      job.error = detail.includes("Too many requests")
        ? detail
        : "Слишком много запросов — подожди минуту и нажми «Повторить finish»";
      jobLog(job, "warn", "email_wait", job.error, { response: detail });
      saveAutoregJob(job);
      return job;
    }
    job.pending_verify_token = null;
    job.pending_verify_mail_at = null;
    job.pending_verify_username = null;
    return fail(job, "finish_signup", `finish_signup failed: ${detail}`);
  }

  job.pending_verify_token = null;
  job.pending_verify_mail_at = null;
  job.pending_verify_username = null;
  job.last_verify_mail_at = null;
  job.last_verify_token = null;

  job.chat_token = data.user.token;
  jobLog(job, "success", "finish_signup", "Email подтверждён, chat token получен");
  saveAutoregJob(job);

  return runPlatformAndApiKey(job);
}

export async function runVerifyEmail(
  jobId: string,
  verifyText: string,
  meta?: { messageDate?: string; token?: string }
): Promise<AutoregJob> {
  const { parseVerifyFromText } = await import("../autoreg.js");
  const job = getAutoregJob(jobId);
  if (!job) throw new Error("job not found");

  const parsed = parseVerifyFromText(verifyText, job.email);
  if (!parsed) {
    return fail(
      job,
      "email_wait",
      "Не нашёл verify_email ссылку в тексте. Вставь .eml или URL."
    );
  }

  return queueBrowserFinishSignup(jobId, verifyText, {
    messageDate: meta?.messageDate,
    token: meta?.token ?? parsed.token,
  });
}

async function runPlatformAndApiKey(job: AutoregJob): Promise<AutoregJob> {
  job.step = "platform_login";
  jobLog(job, "info", "platform_login", "POST api.z.ai/api/auth/z/login");

  const login = await platformLogin(job.chat_token!, job.proxy);
  jobLog(job, "debug", "platform_login", `HTTP ${login.status}`, {
    code: (login.data as { code?: number })?.code,
  });

  if (!login.ok || !login.data?.data?.access_token) {
    return fail(
      job,
      "platform_login",
      `Platform login failed: ${login.text.slice(0, 300)}`
    );
  }

  job.platform_token = login.data.data.access_token;
  jobLog(job, "success", "platform_login", "Platform token OK");

  job.step = "api_key";
  const info = await getCustomerInfo(job.platform_token, job.proxy);
  jobLog(job, "debug", "api_key", `getCustomerInfo HTTP ${info.status}`);

  const orgs = info.data?.data?.organizations || [];
  if (!orgs.length) {
    return fail(job, "api_key", "Нет organization в getCustomerInfo");
  }

  const org = orgs[0]!;
  const project = org.projects?.[0];
  if (!project?.projectId) {
    return fail(job, "api_key", "Нет project в organization");
  }

  job.org_id = org.organizationId;
  job.project_id = project.projectId;
  jobLog(job, "info", "api_key", "Создание API key", {
    org_id: job.org_id,
    project_id: job.project_id,
  });

  const keyName = `key_${job.username.slice(0, 8)}_${Date.now().toString(36)}`;
  const created = await createApiKey(
    job.platform_token,
    job.org_id,
    job.project_id,
    keyName,
    job.proxy
  );

  jobLog(job, "debug", "api_key", `createApiKey HTTP ${created.status}`, {
    apiKey: created.data?.data?.apiKey,
  });

  const apiKeyId = created.data?.data?.apiKey;
  if (!created.ok || !apiKeyId) {
    return fail(job, "api_key", `createApiKey failed: ${created.text.slice(0, 300)}`);
  }

  const copied = await copyApiKeySecret(
    job.platform_token,
    job.org_id,
    job.project_id,
    apiKeyId,
    job.proxy
  );

  const secret = copied.data?.data?.secretKey;
  if (!copied.ok || !secret || secret.includes("***")) {
    return fail(job, "api_key", `copy secret failed: ${copied.text.slice(0, 300)}`);
  }

  job.api_key = `${apiKeyId}.${secret}`;
  jobLog(job, "success", "api_key", "Open Platform API Key создан", {
    api_key: `${apiKeyId.slice(0, 8)}...`,
  });

  try {
    const account = createAutoregAccount(nanoid(10), job.email, job.password, {
      mail_password: job.mail_password,
      api_key: job.api_key,
      proxy: job.proxy,
      note: `job:${job.id}`,
    });
    job.autoreg_account_id = account.id;
    jobLog(job, "success", "api_key", "Сохранено в автореги", { id: account.id });
  } catch (err) {
    jobLog(job, "warn", "api_key", "Ключ создан, но дубликат в авторегах", {
      error: String(err),
    });
  }

  saveAutoregJob(job);
  return startZcodeOAuth(job.id);
}

/** OAuth в браузере + ZCode captcha + пул ротации (zcode-plan). */
export async function runZcodeAutoreg(
  jobId: string,
  signal?: AbortSignal
): Promise<AutoregJob> {
  let job = getAutoregJob(jobId);
  if (!job) throw new Error("job not found");
  if (job.step === "cancelled") return job;
  if (!job.proxy) {
    return fail(job, "zcode_oauth", "Нет прокси у задачи");
  }
  if (
    job.step !== "zcode_oauth" &&
    job.step !== "zcode_captcha" &&
    job.step !== "api_key"
  ) {
    throw new Error(`job step is ${job.step}, expected zcode_oauth`);
  }

  throwIfCancelled(jobId, signal);

  const started = Date.now();
  const heartbeat = setInterval(() => {
    const j = getAutoregJob(jobId);
    if (!j || j.step === "done" || j.step === "error") return;
    const sec = Math.round((Date.now() - started) / 1000);
    jobLog(j, "debug", j.step, `ZCode… ${sec} сек`);
    saveAutoregJob(j);
  }, 5000);

  try {
    if (!job.zcode_oauth_flow_id || !job.zcode_authorize_url) {
      job = await startZcodeOAuth(jobId);
    }

    if (!job.zcode_jwt) {
      job.step = "zcode_oauth";
      job.error = null;
      saveAutoregJob(job);
      jobLog(job, "info", "zcode_oauth", "Playwright: authorize + login…");

      try {
        const { completeZcodeOAuthAuthorize } = await import(
          "./zcode-oauth-playwright.js"
        );
        let pollTicks = 0;
        const oauth = await completeZcodeOAuthAuthorize({
          proxy: job.proxy,
          authorizeUrl: job.zcode_authorize_url!,
          email: job.email,
          password: job.password,
          flowId: job.zcode_oauth_flow_id!,
          pollToken: job.zcode_oauth_poll_token!,
          onProgress: (m) => {
            const j = getAutoregJob(jobId);
            if (j) jobLog(j, "info", "zcode_oauth", m);
          },
          onPollTick: () => {
            pollTicks++;
            if (pollTicks % 3 !== 0) return;
            const j = getAutoregJob(jobId);
            if (j) {
              jobLog(j, "debug", "zcode_oauth", "OAuth poll…");
              saveAutoregJob(j);
            }
          },
        });
        throwIfCancelled(jobId, signal);
        job = getAutoregJob(jobId)!;
        job.zcode_jwt = oauth.jwt;
        job.zcode_oauth_access_token = oauth.oauth_access_token;
        job.zcode_user_id = oauth.user_id;
        job.zcode_session_id = job.zcode_session_id || newZcodeSessionId();
        job.error = null;
        jobLog(job, "success", "zcode_oauth", "ZCode JWT OK", {
          user_id: oauth.user_id,
          jwt: `${oauth.jwt.slice(0, 16)}...`,
        });
        saveAutoregJob(job);
        return finishZcodeOAuthWrap(jobId);
      } catch (err) {
        return fail(job, "zcode_oauth", String(err));
      }
    }

    if (job.step !== "done") {
      job.step = "done";
      saveAutoregJob(job);
    }
    return job;
  } finally {
    clearInterval(heartbeat);
  }
}

/** Фоновый ZCode — не блокирует HTTP (Playwright минуты). */
export function startZcodeAutoregAsync(jobId: string): AutoregJob {
  const job = getAutoregJob(jobId);
  if (!job) throw new Error("job not found");
  // НЕ выходим молча при isJobRunning: родительский runFullAutoreg ещё держит
  // job в running, когда доходит до return startZcodeAutoregAsync(...) — из-за
  // раннего return фоновый Playwright (OAuth браузер) никогда не запускался,
  // pipeline «зависал» на шаге zcode_oauth с последней строкой про authorize_url.
  // beginJobRun сам корректно abort'ит/заменяет предыдущий run (см. job-runner.ts).

  const signal = beginJobRun(jobId);
  void (async () => {
    try {
      await runZcodeAutoreg(jobId, signal);
    } catch (err) {
      const j = getAutoregJob(jobId);
      if (j && j.step !== "cancelled" && j.step !== "done") {
        fail(j, j.step, err instanceof Error ? err.message : String(err));
      }
    } finally {
      endJobRun(jobId);
    }
  })();

  return getAutoregJob(jobId)!;
}

/** Зарегистрированный аккаунт (есть api_key) → job ZCode → пул JWT. */
export function wrapAutoregAccountInZcode(accountId: string): AutoregJob {
  const ar = getAutoregAccount(accountId);
  if (!ar) throw new Error("account not found");
  if (!ar.api_key?.trim()) {
    throw new Error("нет api_key — сначала дождись регистрации");
  }
  if (!ar.proxy) {
    throw new Error("нет proxy на аккаунте — укажи прокси");
  }

  const existing = listAutoregJobs().find(
    (j) =>
      j.autoreg_account_id === accountId &&
      j.step !== "done" &&
      j.step !== "cancelled" &&
      j.step !== "error"
  );
  if (existing) {
    return startZcodeAutoregAsync(existing.id);
  }

  const job: AutoregJob = {
    id: nanoid(12),
    email: ar.email,
    username: ar.email.split("@")[0] || "user",
    password: ar.password,
    mail_password: ar.mail_password,
    proxy: ar.proxy,
    step: "zcode_oauth",
    logs: [],
    chat_token: null,
    platform_token: null,
    org_id: null,
    project_id: null,
    api_key: ar.api_key,
    autoreg_account_id: ar.id,
    zcode_jwt: null,
    zcode_oauth_access_token: null,
    zcode_user_id: null,
    zcode_session_id: newZcodeSessionId(),
    zcode_oauth_flow_id: null,
    zcode_oauth_poll_token: null,
    zcode_authorize_url: null,
    zcode_captcha_param: null,
    zcode_captcha_expires_at: null,
    captcha_solved_at: null,
    signup_at: new Date().toISOString(),
    last_verify_mail_at: null,
    last_verify_token: null,
    pending_verify_token: null,
    pending_verify_mail_at: null,
    pending_verify_username: null,
    signup_via_proxy: true,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  jobLog(job, "info", "zcode_oauth", "Обёртка в ZCode из зарегистрированного аккаунта", {
    email: job.email,
    api_key: `${ar.api_key.split(".")[0]?.slice(0, 8)}...`,
  });
  saveAutoregJob(job);
  return startZcodeAutoregAsync(job.id);
}

export async function startZcodeOAuth(jobId: string): Promise<AutoregJob> {
  const job = getAutoregJob(jobId);
  if (!job) throw new Error("job not found");

  job.step = "zcode_oauth";
  job.error = null;
  jobLog(job, "info", "zcode_oauth", "POST zcode.z.ai/api/v1/oauth/cli/init");

  try {
    const init = await initZcodeCliOAuth();
    job.zcode_oauth_flow_id = init.flow_id;
    job.zcode_oauth_poll_token = init.poll_token;
    job.zcode_authorize_url = init.authorize_url;
    job.zcode_session_id = job.zcode_session_id || newZcodeSessionId();
    jobLog(job, "success", "zcode_oauth", "Открой authorize_url и войди тем же email/password", {
      authorize_url: init.authorize_url,
      expires_at: init.expires_at,
      poll_interval_sec: init.poll_interval_sec,
    });
  } catch (err) {
    return fail(job, "zcode_oauth", String(err));
  }

  saveAutoregJob(job);
  return job;
}

export async function pollZcodeOAuthJob(jobId: string): Promise<AutoregJob> {
  const job = getAutoregJob(jobId);
  if (!job) throw new Error("job not found");
  if (!job.zcode_oauth_flow_id || !job.zcode_oauth_poll_token) {
    return fail(job, "zcode_oauth", "Сначала вызови zcode-oauth/init");
  }

  try {
    const result = await pollZcodeCliOAuth(
      job.zcode_oauth_flow_id,
      job.zcode_oauth_poll_token
    );

    if (result.status === "pending") {
      jobLog(job, "info", "zcode_oauth", "Ожидание авторизации в браузере…");
      saveAutoregJob(job);
      return job;
    }

    if (result.status === "failed") {
      return fail(job, "zcode_oauth", "OAuth отклонён — повтори init");
    }

    job.zcode_jwt = result.jwt;
    job.zcode_oauth_access_token = result.oauth_access_token;
    job.zcode_user_id = result.user_id;
    job.zcode_session_id = job.zcode_session_id || newZcodeSessionId();
    jobLog(job, "success", "zcode_oauth", "ZCode JWT получен", {
      user_id: result.user_id,
      jwt: `${result.jwt.slice(0, 16)}...`,
    });
    saveAutoregJob(job);
    return finishZcodeOAuthWrap(jobId);
  } catch (err) {
    return fail(job, "zcode_oauth", String(err));
  }
}

/** JWT после OAuth → пул zcode-plan (капча 11xygtvd — при запросе к API, не при обёртке). */
export function finishZcodeOAuthWrap(jobId: string): AutoregJob {
  const job = getAutoregJob(jobId);
  if (!job) throw new Error("job not found");
  if (!job.zcode_jwt?.trim()) {
    return fail(job, "zcode_oauth", "Нет ZCode JWT");
  }

  job.step = "done";
  job.error = null;
  void closeJobBrowserProxy(job.id);
  jobLog(job, "success", "done", "Обёртка ZCode готова — JWT в пуле", {
    platform_api_key: job.api_key ? `${job.api_key.slice(0, 12)}...` : null,
    captcha: "при запросе к zcode-plan",
  });

  try {
    syncJobToZcodePool(job);
    jobLog(job, "success", "done", "Аккаунт в ротации zcode-plan");
  } catch (err) {
    jobLog(job, "warn", "done", "Не удалось добавить в пул", { error: String(err) });
  }

  saveAutoregJob(job);
  return job;
}

export function submitJobZcodeCaptcha(
  jobId: string,
  captchaVerifyParam: string,
  expiresAt?: string | null
): AutoregJob {
  const job = getAutoregJob(jobId);
  if (!job) throw new Error("job not found");
  if (!job.zcode_jwt) {
    return fail(job, "zcode_captcha", "Нет ZCode JWT — сначала заверши OAuth");
  }

  job.zcode_captcha_param = captchaVerifyParam.trim();
  job.zcode_captcha_expires_at = expiresAt || null;
  job.step = "done";
  job.error = null;
  void closeJobBrowserProxy(job.id);
  jobLog(job, "success", "done", "ZCode credentials готовы", {
    has_captcha: Boolean(job.zcode_captcha_param),
  });

  try {
    syncJobToZcodePool(job);
    jobLog(job, "success", "done", "Аккаунт добавлен в пул zcode-plan");
  } catch (err) {
    jobLog(job, "warn", "done", "Не удалось добавить в пул", { error: String(err) });
  }

  saveAutoregJob(job);
  return job;
}

/** Import fully-ready ZCode account (manual registration) */
export async function importReadyZcodeJob(input: {
  email: string;
  password?: string;
  mail_password?: string | null;
  chat_token?: string | null;
  platform_token?: string | null;
  api_key?: string | null;
  zcode_jwt: string;
  zcode_oauth_access_token?: string | null;
  zcode_captcha_param?: string | null;
  zcode_user_id?: string | null;
}): Promise<AutoregJob> {
  const job = await createJob({
    email: input.email,
    username: input.email.split("@")[0] || "user",
    password: input.password,
    mail_password: input.mail_password,
  });
  job.chat_token = input.chat_token ?? null;
  job.platform_token = input.platform_token ?? null;
  job.api_key = input.api_key ?? null;
  job.zcode_jwt = input.zcode_jwt.trim();
  job.zcode_oauth_access_token = input.zcode_oauth_access_token ?? null;
  job.zcode_captcha_param = input.zcode_captcha_param?.trim() ?? null;
  job.zcode_user_id = input.zcode_user_id ?? null;
  job.zcode_session_id = newZcodeSessionId();
  job.step = input.zcode_captcha_param ? "done" : "zcode_captcha";
  job.error = null;
  jobLog(job, "success", "import", "Импортирован готовый ZCode аккаунт");
  if (job.step === "done") {
    try {
      syncJobToZcodePool(job);
    } catch {
      /* pool dup */
    }
  }
  saveAutoregJob(job);
  return job;
}

export function retryEmailWait(jobId: string): AutoregJob {
  const job = getAutoregJob(jobId);
  if (!job) throw new Error("job not found");
  if (!job.captcha_solved_at && !job.signup_at) {
    throw new Error("капча ещё не пройдена — создай задачу заново");
  }
  job.step = "email_wait";
  job.error = null;
  jobLog(job, "info", "email_wait", "Ждём новое письмо (старое не трогаем)", {
    captcha_solved_at: job.captcha_solved_at,
    last_verify_mail_at: job.last_verify_mail_at,
  });
  saveAutoregJob(job);
  return job;
}

export async function getJobEgressInfo(jobId: string) {
  const job = getAutoregJob(jobId);
  if (!job) throw new Error("job not found");
  if (!job.proxy) throw new Error("no proxy on job");
  const egress_ip = await fetchEgressIp(job.proxy);
  return {
    proxy: maskProxy(job.proxy),
    egress_ip,
  };
}

export function getJobPublic(job: AutoregJob) {
  const maskedKey = job.api_key
    ? `${job.api_key.split(".")[0]?.slice(0, 8)}...`
    : null;
  const needsBrowserFinish = Boolean(job.pending_verify_token);
  return {
    ...job,
    proxy: maskProxy(job.proxy),
    pending_verify_token: null,
    pending_verify_mail_at: null,
    pending_verify_username: null,
    needs_browser_finish: needsBrowserFinish,
    running: isJobRunning(job.id),
    cancellable:
      isJobRunning(job.id) ||
      (job.step !== "done" &&
        job.step !== "cancelled" &&
        job.step !== "error"),
    signup_via_proxy: job.signup_via_proxy,
    password: job.password.slice(0, 2) + "***",
    mail_password: job.mail_password
      ? job.mail_password.slice(0, 2) + "***"
      : null,
    has_mail_password: Boolean(job.mail_password),
    chat_token: job.chat_token ? job.chat_token.slice(0, 12) + "..." : null,
    platform_token: job.platform_token
      ? job.platform_token.slice(0, 12) + "..."
      : null,
    api_key: job.step === "done" ? job.api_key : maskedKey,
    api_key_masked: maskedKey,
    zcode_jwt:
      job.zcode_jwt && job.step === "done"
        ? job.zcode_jwt
        : job.zcode_jwt
          ? job.zcode_jwt.slice(0, 16) + "..."
          : null,
    zcode_oauth_access_token: job.zcode_oauth_access_token
      ? job.zcode_oauth_access_token.slice(0, 12) + "..."
      : null,
    zcode_captcha_param: job.zcode_captcha_param
      ? job.zcode_captcha_param.slice(0, 24) + "..."
      : null,
    zcode_bundle:
      job.zcode_jwt && job.step === "done"
        ? {
            email: job.email,
            zcode_jwt: job.zcode_jwt,
            oauth_access_token: job.zcode_oauth_access_token,
            user_id: job.zcode_user_id,
            captcha_verify_param: job.zcode_captcha_param,
            platform_api_key: job.api_key,
            chat_token: job.chat_token,
          }
        : undefined,
  };
}
