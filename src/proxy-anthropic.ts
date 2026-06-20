import { Request, Response } from "express";
import {
  handleUpstreamError,
  handleUpstreamSuccess,
  parseZaiError,
  pickAccount,
} from "./accounts.js";
import {
  anthropicModelsList,
  anthropicToOpenAiCompletion,
  openAiChatToAnthropic,
} from "./anthropic-adapter.js";
import { getSettings, getAccount, listAccounts } from "./db.js";
import { ENDPOINT_META, type GatewayEndpoint, readZcodeJwt } from "./endpoints.js";
import { checkProxyAuth } from "./proxy.js";
import {
  ensureZcodeCaptchaForAccount,
  refreshZcodeCaptchaForAccount,
  consumeZcodeCaptcha,
  invalidateJsdomCaptcha,
} from "./zcode/captcha-solver.js";
import { buildZcodeAnthropicHeaders } from "./zcode/headers.js";
import { proxyForZcodeAccount } from "./zcode/account-proxy.js";
import {
  fetchZcodeUpstream,
  shouldUseZcodeElectronProxy,
  zcodePlanMessagesPath,
} from "./zcode/zcode-fetch.js";
import { isZcodeLocalProxyConnectionError } from "./zcode/zcode-local-proxy.js";
import { normalizeZcodeAnthropicBody } from "./zcode/body.js";

const MAX_CAPTCHA_RETRIES = 3;

function isCaptchaError(_status: number, text: string, code?: number): boolean {
  if (code === 3007) return true;
  const low = text.toLowerCase();
  return (
    low.includes("captcha") ||
    low.includes("verify token") ||
    low.includes("verify failed")
  );
}

function isPlanBlocked(status: number, text: string, code?: number): boolean {
  if (code === 3012) return true;
  return status === 405 && text.toLowerCase().includes("method not allowed");
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function resolveAuthToken(
  endpoint: GatewayEndpoint,
  accountKey: string | null
): string | null {
  if (accountKey?.trim()) return accountKey.trim();
  if (endpoint === "zcode-plan") {
    const settings = getSettings();
    return readZcodeJwt(settings.zcode_config_path || undefined);
  }
  return null;
}

function anthropicHeaders(
  token: string,
  account: import("./db.js").Account | null | undefined,
  stream: boolean
): Record<string, string> {
  if (account?.kind === "zcode_jwt" || token.startsWith("eyJ")) {
    return buildZcodeAnthropicHeaders({
      jwt: token,
      captchaVerifyParam: account?.zcode_captcha_param,
      sessionId: account?.zcode_session_id,
      stream,
    });
  }

  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (token.startsWith("eyJ")) {
    h.Authorization = `Bearer ${token}`;
    h["x-api-key"] = token;
  } else {
    h["x-api-key"] = token;
  }
  return h;
}

export async function proxyAnthropic(
  req: Request,
  res: Response,
  opts?: { openAiCompat?: boolean }
): Promise<void> {
  if (!checkProxyAuth(req)) {
    res.status(401).json({
      error: {
        message: "Invalid or missing proxy API key",
        type: "invalid_request_error",
      },
    });
    return;
  }

  const settings = getSettings();
  const endpoint = settings.endpoint as GatewayEndpoint;
  const meta = ENDPOINT_META[endpoint];
  if (!meta || meta.protocol !== "anthropic") {
    res.status(500).json({ error: { message: "Not an anthropic endpoint" } });
    return;
  }

  const openAiCompat =
    opts?.openAiCompat ?? req.path === "/v1/chat/completions";

  if (req.method === "GET" && req.path === "/v1/models") {
    res.json(anthropicModelsList());
    return;
  }

  const isMessages =
    req.path === "/v1/messages" || req.path.startsWith("/v1/messages/");
  if (!isMessages && !openAiCompat) {
    res.status(404).json({ error: { message: "Not found" } });
    return;
  }

  let body = req.body as Record<string, unknown>;
  const modelForResponse = String(body.model || settings.default_model || "GLM-5-Turbo");
  if (openAiCompat) {
    body = openAiChatToAnthropic(body);
  }

  if (endpoint === "zcode-plan") {
    body = normalizeZcodeAnthropicBody(body);
  }

  const viaElectron =
    endpoint === "zcode-plan" ? await shouldUseZcodeElectronProxy() : false;
  const messagesPath = zcodePlanMessagesPath();
  const tried: string[] = [];
  const maxAttempts = Math.max(listAccounts().length, 1);
  let lastError: { status: number; body: string } | null = null;
  let missingCaptcha = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const account = pickAccount(tried);
    let token: string | null = null;
    let accountId: string | null = null;
    let accountRecord: import("./db.js").Account | null = null;

    if (account) {
      tried.push(account.id);
      accountId = account.id;
      accountRecord = account;
      token = resolveAuthToken(endpoint, account.api_key);

      // zcode_jwt: капча опциональна — шлём запрос; при 3007 обнови через POST /api/zcode/captcha
    } else if (endpoint === "zcode-plan" && attempt === 0) {
      token = resolveAuthToken(endpoint, null);
    } else {
      break;
    }

    if (!token) break;
    const authToken = token;

    if (accountRecord?.kind === "zcode_jwt" && !viaElectron) {
      try {
        await ensureZcodeCaptchaForAccount(accountRecord);
        accountRecord = getAccount(accountId!) ?? accountRecord;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "captcha solve failed";
        lastError = { status: 503, body: message };
        missingCaptcha = true;
        continue;
      }
    }

    const isStream = body.stream === true;

    let upstream: globalThis.Response | undefined;
    let captchaFailed = false;

    for (let captchaRound = 0; captchaRound < MAX_CAPTCHA_RETRIES; captchaRound++) {
      const headers = anthropicHeaders(authToken, accountRecord, isStream);
      const zcodeProxy =
        accountRecord?.kind === "zcode_jwt" && !viaElectron
          ? proxyForZcodeAccount(accountRecord)
          : undefined;
      try {
        upstream = await fetchZcodeUpstream(messagesPath, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          proxy: zcodeProxy ?? null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "fetch failed";
        if (viaElectron && isZcodeLocalProxyConnectionError(err)) {
          lastError = {
            status: 503,
            body: `ZCode Electron proxy недоступен. Запусти ZCode с патчем (http://127.0.0.1:9999). ${message}`,
          };
          missingCaptcha = true;
        } else {
          lastError = { status: 502, body: message };
        }
        break;
      }

      if (isStream && upstream.ok && upstream.body) {
        res.status(upstream.status);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        if (accountId) res.setHeader("X-Account-Used", maskKey(authToken));

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(decoder.decode(value, { stream: true }));
          }
          if (accountId && accountRecord) {
            handleUpstreamSuccess(accountRecord, { usage: { total_tokens: 0 } });
          }
          res.end();
        } catch {
          res.status(502).json({ error: { message: "Stream interrupted" } });
        }
        return;
      }

      const text = await upstream.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        /* raw */
      }

      if (!upstream.ok) {
        lastError = { status: upstream.status, body: text };
        const code = (parsed as { code?: number }).code;

        if (isPlanBlocked(upstream.status, text, code)) {
          if (accountId && accountRecord) {
            handleUpstreamError(accountRecord, upstream.status, text);
          }
          break; // try next account
        }

        if (
          !viaElectron &&
          isCaptchaError(upstream.status, text, code) &&
          captchaRound < MAX_CAPTCHA_RETRIES - 1
        ) {
          invalidateJsdomCaptcha(proxyForZcodeAccount(accountRecord));
          try {
            await refreshZcodeCaptchaForAccount(accountId!);
            accountRecord = getAccount(accountId!) ?? accountRecord;
            continue;
          } catch {
            missingCaptcha = true;
            captchaFailed = true;
          }
        } else if (accountId && accountRecord) {
          handleUpstreamError(accountRecord, upstream.status, text);
        } else if (isCaptchaError(upstream.status, text, code)) {
          missingCaptcha = true;
          captchaFailed = true;
        }
        break;
      }

      if (accountId && accountRecord?.kind === "zcode_jwt" && !viaElectron) {
        consumeZcodeCaptcha(accountRecord);
      }

      if (accountId && accountRecord) {
        handleUpstreamSuccess(accountRecord, parsed);
      }

      res.status(upstream.status);
      if (accountId) res.setHeader("X-Account-Used", maskKey(authToken));

      if (openAiCompat) {
        res.json(anthropicToOpenAiCompletion(parsed, modelForResponse));
      } else if (Object.keys(parsed).length) {
        res.json(parsed);
      } else {
        res.send(text);
      }
      return;
    }

    if (captchaFailed) continue;
    if (
      lastError &&
      isPlanBlocked(
        lastError.status,
        lastError.body,
        (() => {
          try {
            return JSON.parse(lastError.body).code as number;
          } catch {
            return undefined;
          }
        })()
      )
    ) {
      continue;
    }
    break;
  }

  if (missingCaptcha) {
    res.status(503).json({
      error: {
        message:
          "jsdom captcha failed. Run: cd captcha_node && npm install",
        type: "zcode_captcha",
        code: 3007,
      },
    });
    return;
  }

  let message =
    endpoint === "zcode-plan"
      ? "Нет JWT ZCode. Заверши OAuth в job или POST /api/zcode/import."
      : "Нет доступных ключей. Для anthropic нужен API key с GLM Coding Plan на open.z.ai.";
  if (lastError?.body) {
    const err = parseZaiError(lastError.status, lastError.body);
    if (err.message) message = err.message;
  }

  res.status(lastError?.status ?? 503).json({
    error: { message, type: "service_unavailable" },
  });
}

export function isAnthropicEndpoint(endpoint: string): boolean {
  const meta = ENDPOINT_META[endpoint as GatewayEndpoint];
  return meta?.protocol === "anthropic";
}
