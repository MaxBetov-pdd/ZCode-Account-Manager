import type { Account } from "../db.js";
import type { AutoregJob } from "../autoreg/types.js";

/** Everything needed to call ZCode Start Plan like the editor */
export interface ZcodeAccountBundle {
  email: string | null;
  zcode_jwt: string;
  oauth_access_token: string | null;
  user_id: string | null;
  captcha_verify_param: string | null;
  captcha_expires_at: string | null;
  platform_api_key: string | null;
  chat_token: string | null;
  session_id: string | null;
}

export function bundleFromAccount(account: Account): ZcodeAccountBundle | null {
  if (account.kind !== "zcode_jwt" || !account.api_key.startsWith("eyJ")) {
    return null;
  }
  return {
    email: account.email,
    zcode_jwt: account.api_key,
    oauth_access_token: account.zcode_oauth_access_token ?? null,
    user_id: account.zcode_user_id ?? null,
    captcha_verify_param: account.zcode_captcha_param ?? null,
    captcha_expires_at: account.zcode_captcha_expires_at ?? null,
    platform_api_key: account.platform_api_key ?? null,
    chat_token: account.chat_token ?? null,
    session_id: account.zcode_session_id ?? null,
  };
}

export function bundleFromJob(job: AutoregJob): ZcodeAccountBundle | null {
  if (!job.zcode_jwt) return null;
  return {
    email: job.email,
    zcode_jwt: job.zcode_jwt,
    oauth_access_token: job.zcode_oauth_access_token,
    user_id: job.zcode_user_id,
    captcha_verify_param: job.zcode_captcha_param,
    captcha_expires_at: job.zcode_captcha_expires_at,
    platform_api_key: job.api_key,
    chat_token: job.chat_token,
    session_id: job.zcode_session_id,
  };
}

export function parseJwtUserId(jwt: string): string | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
        "utf8"
      )
    ) as { user_id?: string; sub?: string };
    return json.user_id || json.sub || null;
  } catch {
    return null;
  }
}
