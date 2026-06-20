import { fetchWithProxy } from "../proxy-util.js";
import { DEFAULT_AVATAR, ZAI_OAUTH_CLIENT_ID, ZAI_OAUTH_REDIRECT } from "./types.js";

const CHAT_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://chat.z.ai",
  "x-region": "overseas",
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

const PLATFORM_HEADERS = {
  Origin: "https://z.ai",
  Referer: "https://z.ai/",
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

export interface HttpResult<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  text: string;
}

async function request<T>(
  url: string,
  init: RequestInit & { proxy?: string | null }
): Promise<HttpResult<T>> {
  const { proxy, ...rest } = init;
  try {
    const res = await fetchWithProxy(url, { ...rest, proxy: proxy || null });
    const text = await res.text();
    let data: T | undefined;
    try {
      data = JSON.parse(text) as T;
    } catch {
      /* raw */
    }
    return { ok: res.ok, status: res.status, data, text: text.slice(0, 2000) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, text: message };
  }
}

export async function chatSignup(
  payload: {
    name: string;
    email: string;
    password: string;
    captcha_verify_param: string;
    profile_image_url?: string;
  },
  proxy?: string | null
) {
  return request<{ success?: boolean }>("https://chat.z.ai/api/v1/auths/signup", {
    method: "POST",
    headers: CHAT_HEADERS,
    body: JSON.stringify({
      ...payload,
      profile_image_url: payload.profile_image_url || DEFAULT_AVATAR,
      sso_redirect: null,
    }),
    proxy,
  });
}

export async function chatFinishSignup(
  payload: {
    username: string;
    email: string;
    password: string;
    token: string;
  },
  opts?: { proxy?: string | null; referer?: string; profile_image_url?: string }
) {
  const headers: Record<string, string> = { ...CHAT_HEADERS };
  const verifyUrl =
    opts?.referer ??
    `https://chat.z.ai/auth/verify_email?token=${encodeURIComponent(payload.token)}` +
      `&email=${encodeURIComponent(payload.email)}` +
      `&username=${encodeURIComponent(payload.username)}&language=en`;
  headers.Referer = verifyUrl;

  const body = JSON.stringify({
    ...payload,
    profile_image_url: opts?.profile_image_url || DEFAULT_AVATAR,
    sso_redirect: null,
  });

  const proxy = opts?.proxy ?? null;
  const cookies: string[] = [];

  const mergeCookies = (res: Response) => {
    const raw =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [];
    for (const line of raw) {
      const name = line.split("=")[0]!;
      cookies.splice(
        0,
        cookies.length,
        ...cookies.filter((c) => !c.startsWith(`${name}=`))
      );
      cookies.push(line.split(";")[0]!);
    }
  };

  const req = async (url: string, init: RequestInit) => {
    const h: Record<string, string> = {
      ...CHAT_HEADERS,
      ...(init.headers as Record<string, string> | undefined),
    };
    if (cookies.length) h.cookie = cookies.join("; ");
    const res = await fetchWithProxy(url, { ...init, headers: h, proxy });
    mergeCookies(res);
    return res;
  };

  try {
    await req("https://chat.z.ai/", {
      method: "GET",
      headers: { Accept: "text/html" },
    });
    await req(verifyUrl, {
      method: "GET",
      headers: { Accept: "text/html", Referer: "https://chat.z.ai/" },
    });
    const res = await req("https://chat.z.ai/api/v1/auths/finish_signup", {
      method: "POST",
      headers,
      body,
    });
    const text = await res.text();
    let data:
      | { success?: boolean; user?: { token?: string; email?: string; name?: string } }
      | undefined;
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      /* raw */
    }
    return { ok: res.ok, status: res.status, data, text: text.slice(0, 2000) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, text: message };
  }
}

export async function platformLogin(chatToken: string, proxy?: string | null) {
  return request<{
    code?: number;
    success?: boolean;
    data?: { access_token?: string };
  }>("https://api.z.ai/api/auth/z/login", {
    method: "POST",
    headers: { ...PLATFORM_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ token: chatToken }),
    proxy,
  });
}

export async function oauthExchange(
  authCode: string,
  proxy?: string | null
) {
  const body = new URLSearchParams({
    clientId: ZAI_OAUTH_CLIENT_ID,
    authCode,
    redirectUri: encodeURIComponent(
      "https://z.ai%2Fmanage-apikey%2Fapikey-list"
    ),
  });
  return request<{
    code?: number;
    data?: { access_token?: string };
  }>("https://api.z.ai/api/auth/z/zaiAuthToken", {
    method: "POST",
    headers: {
      ...PLATFORM_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    proxy,
  });
}

export async function oauthAuthorize(chatToken: string, proxy?: string | null) {
  const url =
    `https://chat.z.ai/api/oauth/authorize?` +
    new URLSearchParams({
      client_id: ZAI_OAUTH_CLIENT_ID,
      response_type: "code",
      state: String(Date.now()),
      redirect_uri: ZAI_OAUTH_REDIRECT,
    });
  return fetchWithProxy(url, {
    method: "GET",
    redirect: "manual",
    headers: {
      ...CHAT_HEADERS,
      Authorization: `Bearer ${chatToken}`,
      Cookie: "",
    },
    proxy: proxy || null,
  });
}

export async function getCustomerInfo(
  platformToken: string,
  proxy?: string | null
) {
  return request<{
    code?: number;
    data?: {
      organizations?: {
        organizationId: string;
        projects?: { projectId: string; projectType?: number }[];
      }[];
    };
  }>("https://api.z.ai/api/biz/customer/getCustomerInfo", {
    method: "GET",
    headers: { ...PLATFORM_HEADERS, Authorization: `Bearer ${platformToken}` },
    proxy,
  });
}

export async function createApiKey(
  platformToken: string,
  orgId: string,
  projectId: string,
  name: string,
  proxy?: string | null
) {
  const url = `https://api.z.ai/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys`;
  return request<{
    code?: number;
    data?: { apiKey?: string; secretKey?: string };
  }>(url, {
    method: "POST",
    headers: {
      ...PLATFORM_HEADERS,
      Authorization: `Bearer ${platformToken}`,
      "Content-Type": "application/json",
      "bigmodel-organization": orgId,
      "bigmodel-project": projectId,
    },
    body: JSON.stringify({ name, keyType: 1 }),
    proxy,
  });
}

export async function copyApiKeySecret(
  platformToken: string,
  orgId: string,
  projectId: string,
  apiKeyId: string,
  proxy?: string | null
) {
  const url = `https://api.z.ai/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys/copy/${apiKeyId}`;
  return request<{
    code?: number;
    data?: { apiKey?: string; secretKey?: string };
  }>(url, {
    method: "GET",
    headers: {
      ...PLATFORM_HEADERS,
      Authorization: `Bearer ${platformToken}`,
      "bigmodel-organization": orgId,
      "bigmodel-project": projectId,
    },
    proxy,
  });
}
