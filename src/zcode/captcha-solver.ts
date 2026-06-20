/**
 * ZCode Start Plan captcha — решается через Playwright (scene 11xygtvd).
 *
 * Раньше использовался jsdom-солвер (captcha_node/solver.js), но эта папка
 * отсутствует в установке, а Playwright-солвер для zcode-капчи уже реализован
 * в autoreg/captcha-playwright.ts (solveZcodeCaptchaWithPlaywright).
 * Капча = HTTP-заголовок X-Aliyun-Captcha-Verify-Param, одноразовая.
 */

import {
  getAccount,
  updateAccountZcodeFields,
  type Account,
} from "../db.js";
import { proxyForZcodeAccount } from "./account-proxy.js";

// Совместимость: invalidateJsdomCaptcha теперь no-op (Playwright не кеширует по прокси).
export function invalidateJsdomCaptcha(_proxy?: string | null): void {
  /* no-op — Playwright-солвер не имеет кеша по прокси */
}

// Заглушка для обратной совместимости (никто не должен вызывать напрямую).
export async function solveZcodeCaptchaJsdom(
  proxy?: string | null
): Promise<string> {
  return solveZcodeCaptchaWithPlaywrightProxy(proxy);
}

/** Решает ZCode-капчу (scene 11xygtvd) через Playwright + Chromium. */
async function solveZcodeCaptchaWithPlaywrightProxy(
  proxy?: string | null
): Promise<string> {
  // Динамический импорт — избегаем циклической зависимости и тащим солвер.
  const { solveZcodeCaptchaWithPlaywright } = await import(
    "../autoreg/captcha-playwright.js"
  );
  // direct/пустой прокси → браузер идёт напрямую (см. launchCaptchaBrowser).
  const effective =
    proxy && proxy.trim() && proxy.trim() !== "direct" && proxy.trim() !== "direct://"
      ? proxy
      : undefined;
  return solveZcodeCaptchaWithPlaywright({ proxy: effective, maxAttempts: 3 });
}

export async function ensureZcodeCaptchaForAccount(
  account: Account
): Promise<string> {
  const proxy = proxyForZcodeAccount(account);
  const param = await solveZcodeCaptchaWithPlaywrightProxy(proxy);
  updateAccountZcodeFields(account.id, {
    zcode_captcha_param: param,
    zcode_captcha_expires_at: new Date(Date.now() + 45_000).toISOString(),
  });
  return param;
}

export async function refreshZcodeCaptchaForAccount(
  accountId: string
): Promise<string> {
  const account = getAccount(accountId);
  if (!account) throw new Error("account not found");
  invalidateJsdomCaptcha(proxyForZcodeAccount(account));
  return ensureZcodeCaptchaForAccount(account);
}

/** Капча одноразовая — после upstream-запроса кеш инвалидируется. */
export function consumeZcodeCaptcha(account: Account): void {
  invalidateJsdomCaptcha(proxyForZcodeAccount(account));
}
