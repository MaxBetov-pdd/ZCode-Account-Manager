import type { Account } from "../db.js";
import { listAutoregAccounts, listAutoregJobs } from "../db.js";

/** Sticky egress proxy for zcode_jwt: captcha + chat must share the same IP. */
export function proxyForZcodeAccount(account: Account): string | undefined {
  const fromEnv = process.env.ZCODE_CAPTCHA_PROXY?.trim();
  if (fromEnv) return fromEnv;

  if (account.proxy?.trim()) return account.proxy.trim();

  const email = account.email?.toLowerCase();
  if (!email) return undefined;

  const ar = listAutoregAccounts().find(
    (a) => a.email?.toLowerCase() === email
  );
  if (ar?.proxy?.trim()) return ar.proxy.trim();

  const job = listAutoregJobs().find(
    (j) => j.email?.toLowerCase() === email && j.zcode_jwt
  );
  return job?.proxy?.trim() || undefined;
}
