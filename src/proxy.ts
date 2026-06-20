import { Request, Response } from "express";
import {
  getSettings,
  getZaiBaseUrl,
  listAccounts,
  recordError,
} from "./db.js";
import {
  handleUpstreamError,
  handleUpstreamSuccess,
  parseZaiError,
  pickAccount,
} from "./accounts.js";
import { openAiModelsList, prepareChatBody } from "./models.js";

const OPENAI_PATHS = [
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/embeddings",
  "/v1/models",
];

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function readProxyApiKeyFromRequest(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim()) return xApiKey.trim();
  const apiKey = req.headers["api-key"];
  if (typeof apiKey === "string" && apiKey.trim()) return apiKey.trim();
  return null;
}

export function checkProxyAuth(req: Request): boolean {
  const settings = getSettings();
  if (!settings.proxy_api_key) return true;
  const key = readProxyApiKeyFromRequest(req);
  return key === settings.proxy_api_key;
}

export async function proxyToZai(req: Request, res: Response): Promise<void> {
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

  // Local models list (Z.AI /models may differ per endpoint)
  if (req.method === "GET" && req.path === "/v1/models") {
    res.json(openAiModelsList());
    return;
  }

  const baseUrl = getZaiBaseUrl(settings.endpoint);
  const path = req.path.replace(/^\/v1/, "");
  const targetUrl = `${baseUrl}${path}`;

  let requestBody = req.body as Record<string, unknown> | undefined;
  if (
    path === "/chat/completions" &&
    requestBody &&
    typeof requestBody === "object"
  ) {
    requestBody = prepareChatBody(requestBody, settings.default_model);
  }

  const tried: string[] = [];
  const maxAttempts = Math.max(listAccounts().length, 1);
  let lastError: { status: number; body: string; kind?: string } | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const account = pickAccount(tried);
    if (!account) break;
    tried.push(account.id);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${account.api_key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (req.headers["accept-language"]) {
      headers["Accept-Language"] = String(req.headers["accept-language"]);
    }

    const isGet = req.method === "GET";
    const fetchOptions: RequestInit = {
      method: req.method,
      headers,
    };

    if (!isGet && requestBody && Object.keys(requestBody).length > 0) {
      fetchOptions.body = JSON.stringify(requestBody);
    }

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(targetUrl, fetchOptions);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upstream fetch failed";
      lastError = { status: 502, body: message };
      continue;
    }

    const contentType = upstream.headers.get("content-type") || "";
    const isStream =
      contentType.includes("text/event-stream") ||
      requestBody?.stream === true;

    if (isStream && upstream.ok && upstream.body) {
      res.status(upstream.status);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Account-Used", maskKey(account.api_key));

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let tokenEstimate = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          tokenEstimate += Math.ceil(chunk.length / 4);
          res.write(chunk);
        }
        handleUpstreamSuccess(account, { usage: { total_tokens: tokenEstimate } });
        res.end();
        return;
      } catch {
        handleUpstreamError(account, 500, "Stream interrupted");
        if (!res.headersSent) {
          res.status(502).json({ error: { message: "Stream interrupted" } });
        }
        return;
      }
    }

    const text = await upstream.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep raw */
    }

    if (upstream.status === 429) {
      handleUpstreamError(
        account,
        upstream.status,
        text,
        upstream.headers.get("retry-after")
      );
      const parsed = parseZaiError(upstream.status, text);
      lastError = { status: upstream.status, body: text, kind: parsed.kind };
      continue;
    }

    if (upstream.status === 503) {
      recordError(account.id);
      lastError = { status: upstream.status, body: text };
      continue;
    }

    if (!upstream.ok) {
      handleUpstreamError(account, upstream.status, text);
      if (upstream.status === 401 || upstream.status === 403) {
        lastError = { status: upstream.status, body: text };
        continue;
      }
      res.status(upstream.status);
      res.setHeader("X-Account-Used", maskKey(account.api_key));
      if (typeof parsed === "object") {
        res.json(parsed);
      } else {
        res.send(text);
      }
      return;
    }

    handleUpstreamSuccess(account, parsed);
    res.status(upstream.status);
    res.setHeader("X-Account-Used", maskKey(account.api_key));
    if (typeof parsed === "object") {
      res.json(parsed);
    } else {
      res.send(text);
    }
    return;
  }

  const status = lastError?.status ?? 503;
  let message = "Нет доступных аккаунтов Z.AI. Добавьте API keys в панели.";
  if (lastError?.body) {
    const err = parseZaiError(lastError.status, lastError.body);
    if (err.kind === "balance") {
      message =
        "Нет баланса / пакета на аккаунте Z.AI. Пополните на https://z.ai/manage-billing";
    } else if (status === 429) {
      message =
        "Дневной лимит Z.AI исчерпан на всех ключах. Добавьте аккаунты или дождитесь сброса (полночь Пекин).";
    } else if (err.message) {
      message = err.message;
    }
  } else if (status === 429) {
    message = "Все аккаунты в лимите. Попробуйте позже или добавьте ключи.";
  }

  res.status(status).json({
    error: {
      message,
      type: lastError?.kind === "balance" ? "insufficient_quota" : "service_unavailable",
      code: status,
    },
  });
}

export function isOpenAiPath(path: string): boolean {
  return OPENAI_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}
