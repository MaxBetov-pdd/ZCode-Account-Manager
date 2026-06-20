import { nanoid } from "nanoid";
import type { AutoregJob } from "../autoreg/types.js";
import {
  addAccount,
  getAccount,
  listAccounts,
  updateAccountZcodeFields,
  type Account,
} from "../db.js";
import { parseJwtUserId } from "./credentials.js";
import { newZcodeSessionId } from "./headers.js";

export function importZcodeAccount(input: {
  label?: string;
  email?: string | null;
  jwt: string;
  oauth_access_token?: string | null;
  captcha_verify_param?: string | null;
  captcha_expires_at?: string | null;
  platform_api_key?: string | null;
  chat_token?: string | null;
  user_id?: string | null;
  proxy?: string | null;
}): Account {
  const jwt = input.jwt.trim();
  if (!jwt.startsWith("eyJ")) {
    throw new Error("jwt must be eyJ... (ZCode Start Plan token)");
  }

  const existing = listAccounts().find((a) => a.api_key === jwt);
  if (existing) {
    updateAccountZcodeFields(existing.id, {
      email: input.email ?? existing.email,
      zcode_oauth_access_token: input.oauth_access_token,
      zcode_captcha_param: input.captcha_verify_param,
      zcode_captcha_expires_at: input.captcha_expires_at,
      platform_api_key: input.platform_api_key,
      chat_token: input.chat_token,
      zcode_user_id: input.user_id ?? parseJwtUserId(jwt),
      zcode_session_id: existing.zcode_session_id || newZcodeSessionId(),
      proxy: input.proxy ?? existing.proxy,
    });
    const updated = getAccount(existing.id);
    if (!updated) throw new Error("account missing after update");
    return updated;
  }

  const label = input.label || input.email || "ZCode account";
  const account = addAccount(label, jwt, nanoid(10), {
    kind: "zcode_jwt",
    email: input.email ?? null,
    zcode_oauth_access_token: input.oauth_access_token ?? null,
    zcode_captcha_param: input.captcha_verify_param ?? null,
    zcode_captcha_expires_at: input.captcha_expires_at ?? null,
    platform_api_key: input.platform_api_key ?? null,
    chat_token: input.chat_token ?? null,
    zcode_user_id: input.user_id ?? parseJwtUserId(jwt),
    zcode_session_id: newZcodeSessionId(),
    proxy: input.proxy ?? null,
  });
  return account;
}

export function syncJobToZcodePool(job: AutoregJob): Account | null {
  if (!job.zcode_jwt) return null;
  return importZcodeAccount({
    email: job.email,
    jwt: job.zcode_jwt,
    oauth_access_token: job.zcode_oauth_access_token,
    captcha_verify_param: job.zcode_captcha_param,
    captcha_expires_at: job.zcode_captcha_expires_at,
    platform_api_key: job.api_key,
    chat_token: job.chat_token,
    user_id: job.zcode_user_id,
    proxy: job.proxy,
  });
}

export function captchaStillValid(account: Account): boolean {
  const param = account.zcode_captcha_param?.trim();
  if (!param) return false;
  if (!account.zcode_captcha_expires_at) return true;
  return new Date(account.zcode_captcha_expires_at) > new Date();
}

export function clearAccountCaptcha(accountId: string): void {
  updateAccountZcodeFields(accountId, {
    zcode_captcha_param: null,
    zcode_captcha_expires_at: null,
  });
}
