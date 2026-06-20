import crypto from "node:crypto";
import {
  ZCODE_BASE_URL,
  ZCODE_OAUTH_CLI_PROVIDER,
  ZCODE_OAUTH_POLL_TOKEN_BYTES,
} from "./constants.js";

interface ApiEnvelope<T> {
  code: number;
  msg?: string;
  data?: T;
}

export interface ZcodeOAuthInitResult {
  flow_id: string;
  poll_token: string;
  authorize_url: string;
  expires_at: number;
  poll_interval_sec: number;
}

export type ZcodeOAuthPollResult =
  | { status: "pending" }
  | { status: "failed" }
  | {
      status: "ready";
      jwt: string;
      oauth_access_token: string;
      user_id: string;
      email?: string;
      name?: string;
    };

function createInitPollToken(): string {
  return crypto.randomBytes(ZCODE_OAUTH_POLL_TOKEN_BYTES).toString("hex");
}

async function parseEnvelope<T>(res: Response): Promise<ApiEnvelope<T>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as ApiEnvelope<T>;
  } catch {
    throw new Error(`Invalid ZCode OAuth response HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

export async function initZcodeCliOAuth(): Promise<ZcodeOAuthInitResult> {
  const pollToken = createInitPollToken();
  const res = await fetch(`${ZCODE_BASE_URL}/api/v1/oauth/cli/init`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pollToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ provider: ZCODE_OAUTH_CLI_PROVIDER }),
  });

  const body = await parseEnvelope<{
    flow_id: string;
    poll_token: string;
    authorize_url: string;
    expires_at: number;
    poll_interval_sec: number;
  }>(res);

  if (!res.ok || body.code !== 0 || !body.data) {
    throw new Error(
      `ZCode OAuth init failed: ${body.msg || res.status} (code ${body.code ?? "?"})`
    );
  }

  return body.data;
}

export async function pollZcodeCliOAuth(
  flowId: string,
  pollToken: string
): Promise<ZcodeOAuthPollResult> {
  const res = await fetch(
    `${ZCODE_BASE_URL}/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`,
    { headers: { Authorization: `Bearer ${pollToken}` } }
  );

  const body = await parseEnvelope<{
    status: string;
    token?: string;
    user?: { user_id?: string; email?: string; name?: string };
    zai?: { access_token?: string };
  }>(res);

  if (!res.ok || body.code !== 0) {
    throw new Error(
      `ZCode OAuth poll failed: ${body.msg || res.status} (code ${body.code ?? "?"})`
    );
  }

  const data = body.data;
  if (!data) throw new Error("ZCode OAuth poll: empty data");

  if (data.status === "pending" || data.status === "failed") {
    return { status: data.status };
  }

  if (
    data.status === "ready" &&
    typeof data.token === "string" &&
    data.user?.user_id &&
    data.zai?.access_token
  ) {
    return {
      status: "ready",
      jwt: data.token,
      oauth_access_token: data.zai.access_token,
      user_id: data.user.user_id,
      email: data.user.email,
      name: data.user.name,
    };
  }

  throw new Error("ZCode OAuth poll: unexpected ready payload");
}

export async function waitZcodeCliOAuth(
  flowId: string,
  pollToken: string,
  opts?: { timeoutMs?: number; intervalMs?: number }
): Promise<Extract<ZcodeOAuthPollResult, { status: "ready" }>> {
  const timeoutMs = opts?.timeoutMs ?? 5 * 60_000;
  const intervalMs = opts?.intervalMs ?? 2000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await pollZcodeCliOAuth(flowId, pollToken);
    if (result.status === "ready") return result;
    if (result.status === "failed") {
      throw new Error("ZCode OAuth authorization failed");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error("ZCode OAuth poll timeout — open authorize_url and log in");
}
