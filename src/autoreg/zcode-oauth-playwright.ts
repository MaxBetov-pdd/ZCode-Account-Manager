import { chromium, type BrowserContext } from "playwright";
import {
  createCaptchaInitCapture,
  parsePlaywrightProxy,
  solveSliderCaptchaOnPage,
} from "./captcha-playwright.js";
import { pollZcodeCliOAuth } from "../zcode/oauth-cli.js";

const PROXY_NOISE_URL_RE =
  /rum\.aliyuncs\.com|arms-retcode|retcode\.aliyuncs|\/e\.gif\b|hotjar|sentry\.io|googletagmanager|google-analytics|facebook\.com\/tr|doubleclick\.net/i;

const ESBUILD_POLYFILL = "var __name=function(t){return t};\n";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function oauthHeadless(): boolean {
  const v = process.env.CAPTCHA_HEADLESS?.toLowerCase();
  if (v === "0" || v === "false" || v === "no") return false;
  return true;
}

async function installProxyFriendlyRoutes(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (PROXY_NOISE_URL_RE.test(url)) {
      return route.abort();
    }
    if (/feilin\d+\.[a-f0-9]+\.js/i.test(url)) {
      try {
        const response = await route.fetch();
        const body = ESBUILD_POLYFILL + (await response.text());
        const headers = { ...response.headers() };
        delete headers["content-length"];
        await route.fulfill({ status: response.status(), headers, body });
        return;
      } catch {
        /* continue */
      }
    }
    return route.continue();
  });
}

async function openEmailLoginForm(
  page: import("playwright").Page,
  onProgress?: (msg: string) => void | Promise<void>
): Promise<void> {
  await onProgress?.("OAuth: жду Welcome screen…");

  const emailInput = page
    .getByPlaceholder(/enter your email/i)
    .or(page.locator('input[type="email"], input[placeholder*="Email" i]'));

  const emailBtn = page
    .getByRole("button", { name: /continue with email/i })
    .or(page.locator('button:has-text("Continue with Email")'))
    .or(page.getByText("Continue with Email", { exact: true }));

  // Уже на форме email
  if (await emailInput.first().isVisible().catch(() => false)) {
    return;
  }

  await onProgress?.("OAuth: клик Continue with Email…");
  await emailBtn.first().waitFor({ state: "visible", timeout: 60_000 });
  await emailBtn.first().click({ timeout: 10_000 });
  await emailInput.first().waitFor({ state: "visible", timeout: 30_000 });
}

async function fillLoginForm(
  page: import("playwright").Page,
  email: string,
  password: string
): Promise<void> {
  const emailLoc = page
    .getByPlaceholder(/enter your email/i)
    .or(page.locator('input[type="email"], input[placeholder*="Email" i]'))
    .first();
  await emailLoc.waitFor({ state: "visible", timeout: 30_000 });
  await emailLoc.fill(email, { timeout: 10_000 });
  const passLoc = page
    .getByPlaceholder(/enter your password/i)
    .or(page.locator('input[type="password"]'))
    .first();
  await passLoc.waitFor({ state: "visible", timeout: 15_000 });
  await passLoc.fill(password, { timeout: 10_000 });
}

async function triggerLoginCaptcha(
  page: import("playwright").Page,
  onProgress?: (msg: string) => void | Promise<void>
): Promise<void> {
  const verifyBtn = page
    .getByText(/click to start verification/i)
    .or(page.locator("#captcha-button"))
    .or(page.locator('[class*="captcha"]:has-text("verification")'))
    .or(page.locator("text=/start verification/i"));

  await onProgress?.("OAuth: Click to start verification…");
  await verifyBtn.first().waitFor({ state: "visible", timeout: 30_000 });
  await verifyBtn.first().click({ timeout: 10_000 });

  await page
    .locator("#aliyunCaptcha-sliding-slider, .aliyunCaptcha-sliding-slider")
    .first()
    .waitFor({ state: "visible", timeout: 45_000 });
}

async function clickSignIn(page: import("playwright").Page): Promise<void> {
  const signIn = page
    .getByRole("button", { name: /^sign in$/i })
    .or(page.locator('button:has-text("Sign in")'));
  await signIn.first().waitFor({ state: "visible", timeout: 20_000 });
  await signIn.first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(800);
  await page
    .waitForFunction(
      () => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          /^sign in$/i.test((b.textContent || "").trim())
        ) as HTMLButtonElement | undefined;
        return btn && !btn.disabled;
      },
      { timeout: 20_000 }
    )
    .catch(() => {});
  await Promise.all([
    page
      .waitForURL(
        (url) =>
          !url.pathname.endsWith("/auth") ||
          url.pathname.includes("/oauth/") ||
          url.hostname.includes("zcode.z.ai"),
        { timeout: 45_000, waitUntil: "domcontentloaded" }
      )
      .catch(() => {}),
    signIn.first().click({ timeout: 12_000 }),
  ]);
  await page.waitForTimeout(1500);
}

async function clickOAuthConsent(
  page: import("playwright").Page,
  onProgress?: (msg: string) => void | Promise<void>
): Promise<void> {
  await page
    .getByText(/would like to access your|authorize.*z code|Z Code.*access/i)
    .waitFor({ state: "visible", timeout: 60_000 })
    .catch(() => {});

  await onProgress?.(`OAuth: consent @ ${page.url().slice(0, 80)}…`);

  await onProgress?.("OAuth: consent — Terms checkbox…");
  const checkbox = page
    .getByRole("checkbox")
    .or(page.locator('input[type="checkbox"]'))
    .first();
  if (await checkbox.isVisible().catch(() => false)) {
    if (!(await checkbox.isChecked().catch(() => false))) {
      await checkbox.check({ timeout: 8000 }).catch(() => checkbox.click({ force: true }));
    }
  } else {
    await page
      .locator("label")
      .filter({ hasText: /terms of service|privacy policy|用户协议|服务条款/i })
      .first()
      .click({ timeout: 5000 })
      .catch(() => {});
  }

  await page.waitForTimeout(500);

  await onProgress?.("OAuth: Continue / Authorize…");
  const continueBtn = page
    .getByRole("button", {
      name: /continue|authorize|approve|allow|confirm|agree|accept|授权|继续|确认/i,
    })
    .or(page.locator('button[type="submit"]:not([disabled])'))
    .or(page.locator('button:has-text("Continue")'))
    .or(page.locator('button:has-text("Authorize")'));

  await page
    .waitForFunction(
      () => {
        const buttons = [...document.querySelectorAll("button")];
        return buttons.some((b) => {
          const t = (b.textContent || "").trim();
          return (
            !b.disabled &&
            /continue|authorize|approve|allow|confirm|agree|accept|授权|继续|确认/i.test(t)
          );
        });
      },
      { timeout: 30_000 }
    )
    .catch(() => {});

  if (await continueBtn.first().isVisible().catch(() => false)) {
    await continueBtn.first().click({ timeout: 12_000 });
    return;
  }

  const clicked = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const btn = buttons.find((b) => {
      const t = (b.textContent || "").trim();
      return (
        !b.disabled &&
        /continue|authorize|approve|allow|confirm|agree|accept|授权|继续|确认/i.test(t)
      );
    }) as HTMLButtonElement | undefined;
    if (btn) {
      btn.click();
      return btn.textContent?.trim() || "button";
    }
    return null;
  });

  if (!clicked) {
    const snippet = await page
      .evaluate(() => document.body?.innerText?.slice(0, 400) || "")
      .catch(() => "");
    throw new Error(
      `OAuth consent button not found. URL=${page.url()} body=${snippet.slice(0, 120)}`
    );
  }
  await onProgress?.(`OAuth: clicked «${clicked}»`);
}

async function waitOAuthReady(
  flowId: string,
  pollToken: string,
  opts: { timeoutMs: number; intervalMs: number; onPollTick?: () => void }
) {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    opts.onPollTick?.();
    const result = await pollZcodeCliOAuth(flowId, pollToken);
    if (result.status === "ready") return result;
    if (result.status === "failed") {
      throw new Error("ZCode OAuth authorization failed");
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  throw new Error("ZCode OAuth poll timeout");
}

/**
 * OAuth по записанному flow:
 * authorize → … → Sign in → Terms ✓ → Continue → poll JWT
 */
export async function completeZcodeOAuthAuthorize(opts: {
  proxy: string;
  authorizeUrl: string;
  email: string;
  password: string;
  flowId: string;
  pollToken: string;
  onProgress?: (msg: string) => void | Promise<void>;
  onPollTick?: () => void;
}): Promise<{
  jwt: string;
  oauth_access_token: string;
  user_id: string;
}> {
  // direct:// (или пусто) — браузер идёт напрямую, без прокси.
  const effectiveProxy =
    opts.proxy && opts.proxy.trim() && opts.proxy.trim() !== "direct"
    && opts.proxy.trim() !== "direct://"
      ? opts.proxy
      : undefined;
  const browser = await chromium.launch({
    headless: oauthHeadless(),
    slowMo: oauthHeadless() ? 0 : 40,
    ...(effectiveProxy ? { proxy: parsePlaywrightProxy(effectiveProxy) } : {}),
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });
    await installProxyFriendlyRoutes(context);
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await context.newPage();

    await opts.onProgress?.("OAuth: открываю authorize…");
    await opts.onProgress?.(
      oauthHeadless() ? "OAuth: браузер headless" : "OAuth: браузер ВИДИМЫЙ (помоги если зависнет)"
    );
    await page.goto(opts.authorizeUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    await opts.onProgress?.(`OAuth: ${page.url().slice(0, 70)}…`);

    await openEmailLoginForm(page, opts.onProgress);
    await opts.onProgress?.("OAuth: email форма…");
    await fillLoginForm(page, opts.email, opts.password);

    const captchaInit = createCaptchaInitCapture(page);
    await opts.onProgress?.("OAuth: сольвер готов, жду verification…");

    await triggerLoginCaptcha(page, opts.onProgress);
    await solveSliderCaptchaOnPage(page, {
      skipWait: true,
      initStore: captchaInit,
      onProgress: (m) => opts.onProgress?.(`OAuth captcha: ${m}`),
    });

    const pollPromise = waitOAuthReady(opts.flowId, opts.pollToken, {
      timeoutMs: 5 * 60_000,
      intervalMs: 2000,
      onPollTick: opts.onPollTick,
    });

    await opts.onProgress?.("OAuth: жду Verification Passed…");
    await page
      .getByText(/verification passed/i)
      .waitFor({ state: "visible", timeout: 15_000 })
      .catch(() => {});
    await page
      .locator("#aliyunCaptcha-sliding-slider")
      .waitFor({ state: "hidden", timeout: 8_000 })
      .catch(() => {});
    await page.waitForTimeout(2000);

    await opts.onProgress?.("OAuth: Sign in…");
    await clickSignIn(page);
    await page
      .waitForLoadState("networkidle", { timeout: 45_000 })
      .catch(() => page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {}));

    const loginErr = page.getByText(
      /incorrect|invalid credentials|wrong password|password is incorrect|密码错误|登录失败/i
    );
    if (await loginErr.first().isVisible().catch(() => false)) {
      throw new Error(
        "Login failed — нужен пароль входа Z.AI (не mail_password). Проверь password в autoreg."
      );
    }

    await opts.onProgress?.("OAuth: жду consent/authorize…");
    // consent/authorize может быть на /api/oauth/authorize ИЛИ /auth/oauth/authorize
    // (chat.z.ai). Покрываем оба + финальный callback.
    await page
      .waitForURL(
        /\/(api|auth)\/oauth\/authorize|zcode\.z\.ai\/api\/v1\/oauth\/cli\/callback/i,
        { timeout: 90_000, waitUntil: "domcontentloaded" }
      )
      .catch(async () => {
        await opts.onProgress?.(`OAuth: still @ ${page.url().slice(0, 90)}…`);
      });

    // Consent-экран: URL может быть как /api/oauth/authorize, так и
    // /auth/oauth/authorize (chat.z.ai). Плюс детектим по содержимому страницы
    // («ZCode would like to access your Z.ai account») — это самый надёжный
    // признак, что показан consent и нужно кликнуть Continue.
    const isConsentUrl = /\/(api|auth)\/oauth\/authorize/i.test(page.url());
    const consentText = await page
      .evaluate(() => document.body?.innerText?.replace(/\s+/g, " ").trim() || "")
      .catch(() => "");
    const isConsentPage = /would like to access your|access your Z\.ai account|Access your profile info/i.test(
      consentText
    );

    if (isConsentUrl || isConsentPage) {
      await clickOAuthConsent(page, opts.onProgress);
    } else if (!page.url().includes("/oauth/cli/callback")) {
      const bodySnippet = consentText.slice(0, 300);
      throw new Error(
        `OAuth redirect missing after login. URL=${page.url().slice(0, 120)} page="${bodySnippet}"`
      );
    }

    await page
      .waitForURL(/zcode\.z\.ai\/api\/v1\/oauth\/cli\/callback/i, { timeout: 30_000 })
      .catch(() => {});

    const result = await pollPromise;
    await opts.onProgress?.("OAuth: JWT получен");
    return {
      jwt: result.jwt,
      oauth_access_token: result.oauth_access_token,
      user_id: result.user_id,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
