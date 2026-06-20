export interface HarEntry {
  request: {
    method: string;
    url: string;
    postData?: { text?: string; mimeType?: string };
    headers?: { name: string; value: string }[];
  };
  response?: { status: number; content?: { text?: string } };
}

export interface ParsedHarRequest {
  method: string;
  url: string;
  host: string;
  path: string;
  authHeader?: string;
  body?: string;
  status?: number;
  tags: string[];
}

function tagUrl(url: string, method: string): string[] {
  const tags: string[] = [];
  const u = url.toLowerCase();
  if (u.includes("register") || u.includes("signup")) tags.push("register");
  if (u.includes("login") || u.includes("signin") || u.includes("auth")) tags.push("auth");
  if (u.includes("api-key") || u.includes("apikey") || u.includes("/key"))
    tags.push("api-key");
  if (u.includes("captcha") || u.includes("verify")) tags.push("captcha");
  if (u.includes("sms") || u.includes("email")) tags.push("verification");
  if (method === "POST" && u.includes("z.ai")) tags.push("z.ai");
  return tags;
}

export function parseHar(har: unknown): ParsedHarRequest[] {
  const data = har as { log?: { entries?: HarEntry[] } };
  const entries = data?.log?.entries || [];
  const seen = new Set<string>();
  const out: ParsedHarRequest[] = [];

  for (const entry of entries) {
    const url = entry.request?.url || "";
    if (!url.includes("z.ai") && !url.includes("bigmodel")) continue;

    const method = entry.request?.method || "GET";
    const key = `${method} ${url}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let host = "";
    let path = "";
    try {
      const parsed = new URL(url);
      host = parsed.host;
      path = parsed.pathname + parsed.search;
    } catch {
      path = url;
    }

    const authHeader = entry.request?.headers?.find(
      (h) => h.name.toLowerCase() === "authorization"
    )?.value;

    out.push({
      method,
      url,
      host,
      path,
      authHeader: authHeader
        ? authHeader.slice(0, 20) + "***"
        : undefined,
      body: entry.request?.postData?.text?.slice(0, 500),
      status: entry.response?.status,
      tags: tagUrl(url, method),
    });
  }

  return out.sort((a, b) => {
    const order = ["register", "auth", "captcha", "verification", "api-key"];
    const ai = order.findIndex((t) => a.tags.includes(t));
    const bi = order.findIndex((t) => b.tags.includes(t));
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}
