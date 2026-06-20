import { ProxyAgent } from "undici";
import { getZaiBaseUrl, getSettings } from "./db.js";

/** Маркер «напрямую» — обрабатывается как отсутствие прокси. */
export const DIRECT_MARKER = "direct://";

/** True если прокси пустой или равен маркеру direct. */
export function isDirectProxy(proxy: string | null | undefined): boolean {
  if (!proxy) return true;
  const v = proxy.trim();
  return !v || v === "direct" || v === DIRECT_MARKER;
}

export async function fetchWithProxy(
  url: string,
  options: RequestInit & { proxy?: string | null } = {}
): Promise<Response> {
  const { proxy, ...rest } = options;
  if (isDirectProxy(proxy)) {
    // direct (или пусто) — идём напрямую с локального IP, без прокси-агента.
    return fetch(url, rest);
  }
  const agent = new ProxyAgent(proxy as string);
  return fetch(url, { ...rest, dispatcher: agent } as RequestInit);
}

export async function verifyApiKey(
  apiKey: string,
  proxy?: string | null,
  endpoint?: "general" | "coding"
): Promise<{ ok: boolean; status: number; message: string; endpoint: string }> {
  const settings = getSettings();
  const ep = endpoint || settings.endpoint;
  const base = getZaiBaseUrl(ep);
  const url = `${base}/chat/completions`;
  const body = JSON.stringify({
    model: "glm-5.2",
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 3,
  });

  try {
    const res = await fetchWithProxy(url, {
      method: "POST",
      proxy: proxy || null,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body,
    });
    const text = await res.text();
    if (res.ok) {
      return { ok: true, status: res.status, message: "OK", endpoint: ep };
    }
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { message?: string; code?: string } };
      msg = j.error?.message || msg;
      if (j.error?.code) msg = `[${j.error.code}] ${msg}`;
    } catch {
      /* raw */
    }
    return { ok: false, status: res.status, message: msg, endpoint: ep };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Request failed";
    return { ok: false, status: 0, message, endpoint: ep };
  }
}

export async function verifyApiKeyBothEndpoints(
  apiKey: string,
  proxy?: string | null
): Promise<{
  general: Awaited<ReturnType<typeof verifyApiKey>>;
  coding: Awaited<ReturnType<typeof verifyApiKey>>;
  hint: string;
}> {
  const [general, coding] = await Promise.all([
    verifyApiKey(apiKey, proxy, "general"),
    verifyApiKey(apiKey, proxy, "coding"),
  ]);

  let hint = "";
  if (coding.ok) {
    hint =
      "Ключ работает на Coding Plan endpoint. В настройках gateway выбери «Coding Plan».";
  } else if (general.ok) {
    hint = "Ключ работает только на general endpoint (платный баланс open.z.ai).";
  } else if (
    general.message.includes("1113") &&
    coding.message.includes("1113")
  ) {
    hint =
      "Оба endpoint вернули «нет баланса». Квота в редакторе Z.AI не привязана к этому API key — создай ключ на open.z.ai того же аккаунта, где Coding Plan.";
  } else if (general.message.includes("1113") && !coding.ok) {
    hint =
      "На general нет баланса. Если есть Coding Plan в редакторе Z.AI — переключи endpoint на coding и используй ключ с того же аккаунта.";
  }

  return { general, coding, hint };
}

export async function fetchEgressIp(proxy?: string | null): Promise<string | null> {
  try {
    const res = await fetchWithProxy("https://api.ipify.org?format=json", {
      proxy: proxy ?? null,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { ip?: string };
    return j.ip ?? null;
  } catch {
    return null;
  }
}

export async function verifyProxy(
  proxy: string
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetchWithProxy("https://api.z.ai/", {
      method: "HEAD",
      proxy,
    });
    return { ok: res.status < 500, message: `HTTP ${res.status}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Proxy failed";
    return { ok: false, message };
  }
}
