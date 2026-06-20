import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright";
import { PNG } from "pngjs";
import {
  CAPTCHA_PREFIX,
  CAPTCHA_REGION,
  CAPTCHA_SCENE_ID,
  DEFAULT_AVATAR,
} from "./types.js";
import {
  ZCODE_CAPTCHA_PREFIX,
  ZCODE_CAPTCHA_REGION,
  ZCODE_CAPTCHA_SCENE_ID,
} from "../zcode/constants.js";
import { parseRetryAfterSeconds } from "../autoreg.js";
import { JobCancelledError } from "./job-runner.js";
import { fetchEgressIp } from "../proxy-util.js";
import * as browserFns from "./captcha-browser-fns.js";
import {
  browserSessionExists,
  browserSessionPath,
  clearBrowserSession,
  saveBrowserSession,
} from "./browser-session.js";
import {
  describeCaptchaParam,
  formatCaptchaParamSummary,
  formatSignupFailureSummary,
} from "./debug-log.js";

const CAPTCHA_SCRIPT_URL =
  "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";

const CAPTCHA_IMG_CDN = "https://static-captcha.aliyuncs.com/";

const CAPTCHA_MOUNT_HTML =
  '<div id="captcha-element"></div><button id="captcha-button" type="button">Verify</button>';

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const PROXY_NOISE_URL_RE =
  /rum\.aliyuncs\.com|arms-retcode|retcode\.aliyuncs|\/e\.gif\b|hotjar|sentry\.io|googletagmanager|google-analytics|facebook\.com\/tr|doubleclick\.net/i;

const ESBUILD_POLYFILL = "var __name=function(t){return t};\n";

function captchaHeadless(): boolean {
  // Headless by default (the closed-loop solver works headless); opt out with
  // CAPTCHA_HEADLESS=0 to watch the browser.
  const v = process.env.CAPTCHA_HEADLESS?.toLowerCase();
  if (v === "0" || v === "false" || v === "no") return false;
  return true;
}

interface CaptchaInitPayload {
  Image: string;
  PuzzleImage: string;
  CertifyId?: string;
}

export function parsePlaywrightProxy(proxyUrl: string) {
  const raw = proxyUrl.includes("://") ? proxyUrl : `http://${proxyUrl}`;
  const u = new URL(raw);
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  return {
    server: `${u.protocol}//${u.hostname}:${port}`,
    username: decodeURIComponent(u.username) || undefined,
    password: decodeURIComponent(u.password) || undefined,
  };
}

interface ImgLike {
  width: number;
  height: number;
  data: Buffer;
}

interface GapResult {
  /** Gap left edge in background-image pixels. */
  offset: number;
  /** Puzzle piece content left edge inside its own canvas. */
  pieceMinX: number;
  /** Puzzle piece content width. */
  pieceWidth: number;
}

function grayAt(img: ImgLike, x: number, y: number): number {
  const i = (y * img.width + x) * 4;
  return 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
}

/** Sobel gradient magnitude map. */
function sobelMap(img: ImgLike): Float32Array {
  const m = new Float32Array(img.width * img.height);
  for (let y = 1; y < img.height - 1; y++) {
    for (let x = 1; x < img.width - 1; x++) {
      const gx =
        grayAt(img, x + 1, y - 1) +
        2 * grayAt(img, x + 1, y) +
        grayAt(img, x + 1, y + 1) -
        (grayAt(img, x - 1, y - 1) +
          2 * grayAt(img, x - 1, y) +
          grayAt(img, x - 1, y + 1));
      const gy =
        grayAt(img, x - 1, y + 1) +
        2 * grayAt(img, x, y + 1) +
        grayAt(img, x + 1, y + 1) -
        (grayAt(img, x - 1, y - 1) +
          2 * grayAt(img, x, y - 1) +
          grayAt(img, x + 1, y - 1));
      m[y * img.width + x] = Math.hypot(gx, gy);
    }
  }
  return m;
}

function pieceBBox(puzzle: ImgLike): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  w: number;
  h: number;
} {
  let minX = puzzle.width,
    maxX = 0,
    minY = puzzle.height,
    maxY = 0;
  for (let y = 0; y < puzzle.height; y++) {
    for (let x = 0; x < puzzle.width; x++) {
      if (puzzle.data[(y * puzzle.width + x) * 4 + 3]! > 40) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Locate the puzzle gap in the background image.
 *
 * The gap is a semi-transparent, puzzle-shaped overlay: it is brighter than its
 * surroundings (matched-brightness term) and has a sharp puzzle-shaped outline
 * (silhouette-edge term). Combining both is robust to busy backgrounds (water,
 * sky) that defeat a naive colour or content match.
 */
export function detectGap(bg: ImgLike, puzzle: ImgLike): GapResult {
  const bb = pieceBBox(puzzle);
  const fallback: GapResult = { offset: 0, pieceMinX: bb.minX, pieceWidth: bb.w };
  if (bg.width - bb.w <= 0) return fallback;

  const bgEdge = sobelMap(bg);
  const gray = new Float32Array(bg.width * bg.height);
  for (let y = 0; y < bg.height; y++) {
    for (let x = 0; x < bg.width; x++) {
      const i = (y * bg.width + x) * 4;
      gray[y * bg.width + x] = (bg.data[i]! + bg.data[i + 1]! + bg.data[i + 2]!) / 3;
    }
  }

  const inShape = (x: number, y: number): boolean =>
    x >= 0 &&
    y >= 0 &&
    x < puzzle.width &&
    y < puzzle.height &&
    puzzle.data[(y * puzzle.width + x) * 4 + 3]! > 40;

  const shape: Array<[number, number]> = [];
  const edge: Array<[number, number]> = [];
  for (let py = bb.minY; py <= bb.maxY; py++) {
    for (let px = bb.minX; px <= bb.maxX; px++) {
      if (!inShape(px, py)) continue;
      shape.push([px - bb.minX, py]);
      if (
        !inShape(px - 1, py) ||
        !inShape(px + 1, py) ||
        !inShape(px, py - 1) ||
        !inShape(px, py + 1)
      ) {
        edge.push([px - bb.minX, py]);
      }
    }
  }
  if (shape.length === 0 || edge.length === 0) return fallback;

  const bright: number[] = [];
  const edges: number[] = [];
  for (let x = 0; x <= bg.width - bb.w; x++) {
    let inSum = 0;
    for (const [dx, dy] of shape) inSum += gray[dy * bg.width + (x + dx)]!;
    const lx = Math.max(0, x - bb.w);
    const rx = Math.min(bg.width - bb.w, x + bb.w);
    let lSum = 0,
      rSum = 0;
    for (const [dx, dy] of shape) {
      lSum += gray[dy * bg.width + (lx + dx)]!;
      rSum += gray[dy * bg.width + (rx + dx)]!;
    }
    bright.push(inSum / shape.length - (lSum + rSum) / (2 * shape.length));
    let es = 0;
    for (const [dx, dy] of edge) es += bgEdge[dy * bg.width + (x + dx)]!;
    edges.push(es / edge.length);
  }

  const norm = (arr: number[]): number[] => {
    const mn = Math.min(...arr);
    const mx = Math.max(...arr);
    return arr.map((v) => (mx > mn ? (v - mn) / (mx - mn) : 0));
  };
  const nb = norm(bright);
  const ne = norm(edges);
  let bestX = 0;
  let bestScore = -1;
  for (let x = 0; x < nb.length; x++) {
    const s = nb[x]! * 0.6 + ne[x]! * 0.4;
    if (s > bestScore) {
      bestScore = s;
      bestX = x;
    }
  }
  return { offset: bestX, pieceMinX: bb.minX, pieceWidth: bb.w };
}

/** Backwards-compatible wrapper (returns only the gap offset). */
export function findSlideOffset(bg: ImgLike, puzzle: ImgLike): number {
  return detectGap(bg, puzzle).offset;
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

function captchaImageUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return CAPTCHA_IMG_CDN + path.replace(/^\//, "");
}

async function parseInitResponse(response: Response): Promise<CaptchaInitPayload | null> {
  try {
    const raw = JSON.parse(await response.text()) as CaptchaInitPayload & {
      Result?: CaptchaInitPayload;
      Data?: CaptchaInitPayload;
      data?: CaptchaInitPayload;
      ResultObject?: CaptchaInitPayload;
    };
    const candidates = [raw, raw.Result, raw.Data, raw.data, raw.ResultObject];
    for (const data of candidates) {
      if (data?.PuzzleImage && data?.Image) return data;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function scrapeCaptchaInitFromDom(page: Page): Promise<CaptchaInitPayload | null> {
  for (const frame of page.frames()) {
    const data = await frame.evaluate(() => {
      const srcs = [...document.querySelectorAll("img")]
        .map((i) => (i as HTMLImageElement).src)
        .filter(Boolean);
      const back = srcs.find((s) => /back\.png/i.test(s));
      const puzzle = srcs.find((s) => /shadow\.png/i.test(s));
      if (!back || !puzzle) return null;
      return { Image: back, PuzzleImage: puzzle };
    });
    if (data?.Image && data.PuzzleImage) return data;
  }
  return null;
}

export interface CaptchaInitStore {
  getLatest(): CaptchaInitPayload | null;
  waitFor(timeoutMs: number): Promise<CaptchaInitPayload | null>;
  clearLatest(): void;
}

/** Подписка на InitCaptchaV3 — вызывать ДО клика «verification». */
export function createCaptchaInitCapture(page: Page): CaptchaInitStore {
  return attachCaptchaInitStore(page);
}

function attachCaptchaInitStore(page: Page): CaptchaInitStore {
  let latest: CaptchaInitPayload | null = null;
  const waiters: Array<(v: CaptchaInitPayload) => void> = [];

  const onResponse = async (response: Response) => {
    const url = response.url();
    if (!url.includes("captcha-open") || url.includes("verify")) return;
    if (/\.(js|png|jpg|jpeg|woff|gif)/i.test(url)) return;
    const parsed = await parseInitResponse(response);
    if (!parsed) return;
    latest = parsed;
    for (const w of waiters.splice(0)) w(parsed);
  };

  page.on("response", onResponse);

  return {
    getLatest: () => latest,
    waitFor(timeoutMs: number) {
      if (latest) return Promise.resolve(latest);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(latest), timeoutMs);
        waiters.push((v) => {
          clearTimeout(timer);
          resolve(v);
        });
      });
    },
    clearLatest() {
      latest = null;
    },
  };
}

async function launchCaptchaBrowser(
  proxy?: string,
  onBrowser?: (close: () => Promise<void>) => void,
  jobId?: string
): Promise<{ browser: Browser; page: Page; initStore: CaptchaInitStore }> {
  // direct:// (или пусто) — браузер идёт напрямую, без прокси.
  const effectiveProxy =
    proxy && proxy.trim() && proxy.trim() !== "direct" && proxy.trim() !== "direct://"
      ? proxy
      : undefined;
  const browser = await chromium.launch({
    headless: captchaHeadless(),
    slowMo: captchaHeadless() ? 0 : 30,
    ...(effectiveProxy ? { proxy: parsePlaywrightProxy(effectiveProxy) } : {}),
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });
  onBrowser?.(async () => {
    await browser.close().catch(() => {});
  });

  const storageState =
    jobId && browserSessionExists(jobId) ? browserSessionPath(jobId) : undefined;
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
    ...(storageState ? { storageState } : {}),
  });
  await installProxyFriendlyRoutes(context);
  await context.addInitScript(() => {
    (globalThis as unknown as { __name?: (t: unknown) => unknown }).__name = (
      t: unknown
    ) => t;
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await context.newPage();
  return { browser, page, initStore: attachCaptchaInitStore(page) };
}

/** Navigate, mount widget, init Aliyun SDK. */
async function setupCaptchaSolverPage(
  page: Page,
  opts: { pageUrl: string; sceneId: string; prefix: string; region: string },
  report?: (msg: string) => void | Promise<void>
): Promise<void> {
  await report?.(`${opts.pageUrl} — captcha widget…`);
  await page.goto(opts.pageUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.evaluate(browserFns.mountCaptchaDom, CAPTCHA_MOUNT_HTML);
  await page.addScriptTag({ url: CAPTCHA_SCRIPT_URL });
  await page.waitForFunction(
    "typeof window.initAliyunCaptcha === 'function'",
    { timeout: 45000 }
  );
  await page.evaluate(browserFns.initAliyunCaptchaWidget, {
    sceneId: opts.sceneId,
    prefix: opts.prefix,
    region: opts.region,
  });
  await page.waitForTimeout(800);
}

async function setupSolverPage(
  page: Page,
  report?: (msg: string) => void | Promise<void>
): Promise<void> {
  await setupCaptchaSolverPage(
    page,
    {
      pageUrl: "https://chat.z.ai/auth/signup",
      sceneId: CAPTCHA_SCENE_ID,
      prefix: CAPTCHA_PREFIX,
      region: CAPTCHA_REGION,
    },
    report
  );
}

async function setupZcodeSolverPage(
  page: Page,
  report?: (msg: string) => void | Promise<void>
): Promise<void> {
  await setupCaptchaSolverPage(
    page,
    {
      pageUrl: "https://zcode.z.ai/",
      sceneId: ZCODE_CAPTCHA_SCENE_ID,
      prefix: ZCODE_CAPTCHA_PREFIX,
      region: ZCODE_CAPTCHA_REGION,
    },
    report
  );
}

async function waitForInit(
  page: Page,
  initStore: CaptchaInitStore,
  report?: (msg: string) => void | Promise<void>
): Promise<CaptchaInitPayload> {
  let init = initStore.getLatest();
  if (!init) {
    initStore.clearLatest();
    const pending = initStore.waitFor(20_000);
    const sliderVisible = await page
      .locator("#aliyunCaptcha-sliding-slider")
      .isVisible()
      .catch(() => false);
    if (!sliderVisible) {
      await page.click("#captcha-button", { timeout: 5000 }).catch(() => {});
    }
    await page.waitForSelector("#aliyunCaptcha-sliding-slider", { timeout: 15_000 });
    init = (await pending) ?? initStore.getLatest();
  }
  if (!init?.Image || !init?.PuzzleImage) {
    await report?.("init из DOM (картинки в модалке)…");
    init = (await scrapeCaptchaInitFromDom(page)) ?? init;
  }
  if (!init?.Image || !init?.PuzzleImage) {
    throw new Error("нет init (Image/PuzzleImage)");
  }
  await report?.(`init OK (${init.CertifyId?.slice(0, 8) ?? "?"})`);
  return init;
}

/** Download a captcha image through the browser context (uses proxy, no CORS). */
async function downloadCaptchaImage(page: Page, path: string): Promise<Buffer> {
  const urls: string[] = [];
  if (/^https?:\/\//i.test(path)) {
    urls.push(path);
  } else {
    const p = path.replace(/^\//, "");
    urls.push(CAPTCHA_IMG_CDN + p);
    urls.push(`https://static-captcha-sgp.aliyuncs.com/${p}`);
  }
  let lastErr: unknown;
  for (const url of urls) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await page.context().request.get(url, { timeout: 12_000 });
        if (res.ok()) return Buffer.from(await res.body());
        lastErr = new Error(`HTTP ${res.status()}`);
      } catch (err) {
        lastErr = err;
      }
      await page.waitForTimeout(300);
    }
  }
  throw new Error(`captcha image download failed: ${String(lastErr)}`);
}

async function findRenderedCaptchaBgWidth(page: Page): Promise<number> {
  const selectors = [
    "img.puzzle",
    'img[src*="back.png"]',
    ".aliyunCaptcha-img img",
    "#aliyunCaptcha-img img",
  ];
  for (const frame of page.frames()) {
    for (const sel of selectors) {
      const loc = frame.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      const box = await loc.boundingBox();
      if (box && box.width > 20) return box.width;
    }
  }
  return 0;
}

/**
 * Target horizontal position (CSS `left`, rendered px) for the puzzle piece so
 * that its visible content aligns with the gap.
 */
async function computeTargetLeft(
  page: Page,
  init: CaptchaInitPayload
): Promise<number> {
  const [backBuf, puzzleBuf] = await Promise.all([
    downloadCaptchaImage(page, init.Image),
    downloadCaptchaImage(page, init.PuzzleImage),
  ]);
  const bgPng = PNG.sync.read(backBuf);
  const puzzlePng = PNG.sync.read(puzzleBuf);
  const gap = detectGap(
    { width: bgPng.width, height: bgPng.height, data: bgPng.data },
    { width: puzzlePng.width, height: puzzlePng.height, data: puzzlePng.data }
  );

  let renderedBgWidth = await findRenderedCaptchaBgWidth(page);
  if (!renderedBgWidth) {
    renderedBgWidth = Math.round(bgPng.width * 0.72);
  }

  const scale = renderedBgWidth / bgPng.width;
  // Piece starts at style.left=0 with its content at pieceMinX; to align the
  // content with the gap the piece must travel (gap - pieceMinX) image px.
  return (gap.offset - gap.pieceMinX) * scale;
}

async function findSliderHandle(page: Page) {
  for (const frame of page.frames()) {
    const handle = frame.locator("#aliyunCaptcha-sliding-slider").first();
    if ((await handle.count()) === 0) continue;
    const box = await handle.boundingBox();
    if (box && box.width > 5) return { frame, handle, box };
  }
  return null;
}

async function findSliderBox(page: Page) {
  const sh = await findSliderHandle(page);
  return sh?.box ?? null;
}

async function readPuzzleLeft(page: Page): Promise<number> {
  for (const frame of page.frames()) {
    const v = await frame
      .evaluate(() => {
        const e = document.getElementById("aliyunCaptcha-puzzle");
        if (!e) return null;
        const left = parseFloat(e.style.left);
        return Number.isNaN(left) ? 0 : left;
      })
      .catch(() => null);
    if (v != null) return v;
  }
  return 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Closed-loop slide: drag the handle while reading the puzzle piece's real
 * position and stop exactly on the gap. The Aliyun slider animates the piece
 * with easing, so the piece lags the handle during a fast drag — an open-loop
 * drag therefore lands short. Reading `aliyunCaptcha-puzzle` and settling
 * before release makes the landing accurate regardless of that easing.
 */
async function closedLoopSlide(
  page: Page,
  targetLeft: number,
  report?: (msg: string) => void | Promise<void>
): Promise<void> {
  const sh = await findSliderHandle(page);
  if (!sh) throw new Error("slider not found");
  const { handle: sliderLoc, box } = sh;
  await report?.(`drag → ${Math.round(targetLeft)}px`);
  await sliderLoc.scrollIntoViewIfNeeded().catch(() => {});
  await sliderLoc.hover({ force: true });
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  // approach the handle with a few idle hovers (human-like)
  for (let i = 0; i < 4; i++) {
    await page.mouse.move(
      startX - 15 + Math.random() * 30,
      startY - 5 + Math.random() * 10
    );
    await sleep(30 + Math.random() * 40);
  }
  await page.mouse.move(startX, startY);
  await sleep(120);
  await page.mouse.down();
  await sleep(90);

  let offsetX = 0;
  const maxDrag = Math.max(targetLeft + 40, 280);
  while (offsetX < maxDrag) {
    const remain = targetLeft - (await readPuzzleLeft(page));
    if (remain <= 1.2) break;
    offsetX += Math.max(2, Math.min(22, remain * 0.9));
    await page.mouse.move(startX + offsetX, startY + (Math.random() - 0.5) * 2, {
      steps: 3,
    });
    await sleep(45 + Math.random() * 35);
  }

  await sleep(250);
  for (let k = 0; k < 6; k++) {
    const remain = targetLeft - (await readPuzzleLeft(page));
    if (Math.abs(remain) <= 0.8) break;
    offsetX = Math.max(0, Math.min(maxDrag, offsetX + remain));
    await page.mouse.move(startX + offsetX, startY + (Math.random() - 0.5), {
      steps: 2,
    });
    await sleep(160);
  }

  await sleep(250 + Math.random() * 150);
  await page.mouse.up();
}

async function waitForCaptchaParam(
  page: Page,
  timeoutMs: number
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = (await page.evaluate(browserFns.getCaptchaState)) as {
      param?: string | null;
    } | null;
    const param = state?.param?.trim();
    if (param && param.length > 20) return param;
    await page.waitForTimeout(250);
  }
  return null;
}

async function refreshCaptcha(
  page: Page,
  initStore: CaptchaInitStore
): Promise<CaptchaInitPayload> {
  initStore.clearLatest();
  const pending = initStore.waitFor(15000);
  const refresh = page.locator(".aliyunCaptcha-refresh, #aliyunCaptcha-refresh").first();
  if ((await refresh.count()) > 0) {
    await refresh.click({ timeout: 3000 }).catch(() => {});
  } else {
    await page.click("#captcha-button", { timeout: 3000 }).catch(() => {});
  }
  await page.waitForSelector("#aliyunCaptcha-sliding-slider", { timeout: 10000 });
  const init = (await pending) ?? initStore.getLatest();
  if (!init) throw new Error("нет init после refresh");
  return init;
}

async function isOAuthVerificationPassed(page: Page): Promise<boolean> {
  if (await page.getByText(/verification passed/i).isVisible().catch(() => false)) {
    return true;
  }
  const modalOpen = await page
    .getByText(/please complete security verification/i)
    .isVisible()
    .catch(() => false);
  const sliderOpen = await page
    .locator("#aliyunCaptcha-sliding-slider")
    .isVisible()
    .catch(() => false);
  return !modalOpen && !sliderOpen;
}

async function pollAfterSlide(
  page: Page,
  report?: (msg: string) => void | Promise<void>,
  opts?: { nativeEmbed?: boolean }
): Promise<string | null> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const state = (await page.evaluate(browserFns.getCaptchaState)) as {
      param?: string | null;
    } | null;
    const param = state?.param?.trim();
    if (param && param.length > 20) return param;

    if (opts?.nativeEmbed && (await isOAuthVerificationPassed(page))) {
      await report?.("Verification Passed ✓");
      return "__verification_passed__";
    }

    await page.waitForTimeout(350);
  }
  return null;
}

async function trySolveOnce(
  page: Page,
  initStore: CaptchaInitStore,
  report?: (msg: string) => void | Promise<void>,
  opts?: { nativeEmbed?: boolean }
): Promise<string | null> {
  let init = await waitForInit(page, initStore, report);

  const attempts = opts?.nativeEmbed ? 2 : 4;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) init = await refreshCaptcha(page, initStore);

    let targetLeft: number;
    try {
      await report?.("detect gap…");
      targetLeft = await computeTargetLeft(page, init);
    } catch (err) {
      await report?.(`detect fail: ${String(err)}`);
      continue;
    }
    await report?.(`gap target ${Math.round(targetLeft)}px (попытка ${i + 1})`);

    await closedLoopSlide(page, targetLeft, report);
    await page.click("#captcha-button", { timeout: 3000 }).catch(() => {});

    const result = await pollAfterSlide(page, report, opts);
    if (result === "__verification_passed__") {
      return result;
    }
    if (result) {
      await report?.(`param OK — ${formatCaptchaParamSummary(result)}`);
      return result;
    }

    if (opts?.nativeEmbed && (await isOAuthVerificationPassed(page))) {
      await report?.("Verification Passed (после poll)");
      return "__verification_passed__";
    }

    await report?.(`нет param (попытка ${i + 1})`);
  }

  return null;
}

/** Слайдер-капча на текущей странице (OAuth login modal). */
export async function solveSliderCaptchaOnPage(
  page: Page,
  opts?: {
    onProgress?: (message: string) => void | Promise<void>;
    skipWait?: boolean;
    /** Передай store, созданный ДО клика verification */
    initStore?: CaptchaInitStore;
  }
): Promise<string> {
  const initStore = opts?.initStore ?? createCaptchaInitCapture(page);
  if (!opts?.skipWait) {
    await opts?.onProgress?.("жду капчу…");
    await page.waitForSelector("#aliyunCaptcha-sliding-slider", { timeout: 45000 });
  }
  await opts?.onProgress?.("сольвер: gap + drag…");
  const nativeEmbed = Boolean(opts?.initStore);
  const param = await trySolveOnce(page, initStore, opts?.onProgress, { nativeEmbed });
  if (!param) throw new Error("капча: нет verify param");
  return param;
}

export interface PlaywrightSignupPayload {
  name: string;
  email: string;
  password: string;
  profile_image_url: string;
}

export interface PlaywrightSignupResult {
  captchaParam: string;
  signup: BrowserSignupResult;
}

interface BrowserSignupResult {
  status: number;
  ok: boolean;
  body: string;
  ctx?: { pageUrl: string; pageOrigin: string; cookieCount: number };
  paramInfo?: { length: number; head: string; isJson: boolean };
}

async function signupViaBrowser(
  page: Page,
  signup: PlaywrightSignupPayload,
  captchaParam: string
): Promise<BrowserSignupResult> {
  return (await page.evaluate(browserFns.browserChatSignup, {
    name: signup.name,
    email: signup.email,
    password: signup.password,
    captcha_verify_param: captchaParam,
    profile_image_url: signup.profile_image_url,
    sso_redirect: null,
  })) as BrowserSignupResult;
}

async function waitForFinishResponse(
  page: Page,
  timeoutMs: number
): Promise<{ status: number; ok: boolean; body: string } | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      page.off("response", onResponse);
      resolve(null);
    }, timeoutMs);
    const onResponse = async (response: Response) => {
      if (!response.url().includes("finish_signup")) return;
      clearTimeout(timer);
      page.off("response", onResponse);
      const body = await response.text().catch(() => "");
      resolve({
        status: response.status(),
        ok: response.ok(),
        body,
      });
    };
    page.on("response", onResponse);
  });
}

export async function finishSignupWithPlaywright(opts: {
  proxy: string;
  jobId?: string;
  username: string;
  email: string;
  password: string;
  token: string;
  profile_image_url?: string;
  onProgress?: (message: string) => void | Promise<void>;
}): Promise<{ status: number; ok: boolean; body: string }> {
  const {
    proxy,
    jobId,
    username,
    email,
    password,
    token,
    profile_image_url = DEFAULT_AVATAR,
    onProgress,
  } = opts;
  const verifyUrl =
    `https://chat.z.ai/auth/verify_email?token=${encodeURIComponent(token)}` +
    `&email=${encodeURIComponent(email)}` +
    `&username=${encodeURIComponent(username)}&language=en`;

  let browser: Browser | null = null;
  try {
    const egress = await fetchEgressIp(proxy);
    const hasSession = jobId ? browserSessionExists(jobId) : false;
    await onProgress?.(
      `finish: Playwright (egress ${egress ?? "?"}, session ${hasSession ? "restored" : "new"})…`
    );
    const launched = await launchCaptchaBrowser(proxy, undefined, jobId);
    browser = launched.browser;
    const { page } = launched;

    const autoFinish = waitForFinishResponse(page, 12000);

    await onProgress?.("finish: verify_email…");
    await page
      .goto(verifyUrl, { waitUntil: "networkidle", timeout: 60000 })
      .catch(() => page.goto(verifyUrl, { waitUntil: "domcontentloaded", timeout: 60000 }));
    await page.waitForTimeout(1500);

    let result = await autoFinish;
    if (!result) {
      await onProgress?.("finish: POST finish_signup…");
      result = (await page.evaluate(browserFns.browserChatFinishSignup, {
        username,
        email,
        password,
        token,
        profile_image_url,
        verifyUrl,
      })) as { status: number; ok: boolean; body: string };
    } else {
      await onProgress?.(`finish: auto response HTTP ${result.status}`);
    }
    return result;
  } finally {
    await browser?.close().catch(() => {});
  }
}

export async function solveCaptchaAndSignupWithPlaywright(opts: {
  proxy: string;
  jobId?: string;
  signup: PlaywrightSignupPayload;
  maxAttempts?: number;
  onProgress?: (message: string, step?: "captcha" | "signup") => void | Promise<void>;
  signal?: AbortSignal;
  onBrowser?: (close: () => Promise<void>) => void;
}): Promise<PlaywrightSignupResult> {
  const { proxy, jobId, signup, maxAttempts = 3, onProgress, signal, onBrowser } = opts;
  if (!proxy?.trim()) {
    throw new Error("proxy обязателен");
  }

  const report = (msg: string, step: "captcha" | "signup" = "captcha") =>
    onProgress?.(msg, step);

  let browser: Browser | null = null;
  try {
    const egress = await fetchEgressIp(proxy);
    await report(
      captchaHeadless()
        ? `Playwright headless (egress ${egress ?? "?"})…`
        : `Playwright (egress ${egress ?? "?"})…`
    );

    const launched = await launchCaptchaBrowser(proxy, onBrowser, jobId);
    browser = launched.browser;
    const { page, initStore } = launched;

    if (signal?.aborted) throw new JobCancelledError();

    await setupSolverPage(page, (m) => report(m));

    let lastErr = "captcha failed";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) throw new JobCancelledError();
      try {
        await report(`solver попытка ${attempt}/${maxAttempts}`);
        const param = await trySolveOnce(page, initStore, (m) => report(m));
        if (!param) {
          lastErr = "нет captcha_verify_param";
          await setupSolverPage(page, (m) => report(m));
          continue;
        }

        await report("signup из браузера (тот же IP)…", "signup");
        const paramDbg = describeCaptchaParam(param);
        await report(
          `debug pre-signup egress=${egress ?? "?"} param=${paramDbg.format} len=${paramDbg.length}`,
          "signup"
        );
        const signupRes = await signupViaBrowser(page, signup, param);
        if (signupRes.ctx) {
          await report(
            `debug browser page=${signupRes.ctx.pageUrl} cookies=${signupRes.ctx.cookieCount}`,
            "signup"
          );
        }
        if (
          !signupRes.ok ||
          !signupRes.body.includes('"success":true')
        ) {
          await report(formatSignupFailureSummary(signupRes), "signup");
          if (signupRes.paramInfo) {
            await report(
              `debug sent param len=${signupRes.paramInfo.length} json=${signupRes.paramInfo.isJson} head=${JSON.stringify(signupRes.paramInfo.head)}`,
              "signup"
            );
          }
          const egressAfter = await fetchEgressIp(proxy);
          if (egressAfter && egress && egressAfter !== egress) {
            await report(
              `debug WARN egress changed ${egress} → ${egressAfter}`,
              "signup"
            );
          }
        }
        if (
          jobId &&
          signupRes.ok &&
          signupRes.body.includes('"success":true')
        ) {
          await saveBrowserSession(page, jobId);
          await report(`browser session saved (${jobId.slice(0, 8)})`, "signup");
        }
        if (signupRes.ok && signupRes.body.includes('"success":true')) {
          return { captchaParam: param, signup: signupRes };
        }
        return { captchaParam: param, signup: signupRes };
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        await report(`ошибка: ${lastErr}`);
        if (attempt < maxAttempts) {
          await setupSolverPage(page, (m) => report(m));
        }
      }
    }
    throw new Error(lastErr);
  } finally {
    await browser?.close().catch(() => {});
  }
}

export async function solveZcodeCaptchaWithPlaywright(opts: {
  proxy?: string;
  maxAttempts?: number;
  onProgress?: (message: string) => void | Promise<void>;
}): Promise<string> {
  const { proxy, maxAttempts = 3, onProgress } = opts;

  let browser: Browser | null = null;
  try {
    const launched = await launchCaptchaBrowser(proxy);
    browser = launched.browser;
    const { page, initStore } = launched;
    await setupZcodeSolverPage(page, onProgress);

    let lastErr = "zcode captcha failed";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await onProgress?.(`ZCode captcha попытка ${attempt}/${maxAttempts}`);
        const param = await trySolveOnce(page, initStore, onProgress);
        if (param && param.length > 20) return param;
        lastErr = "empty param";
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
      if (attempt < maxAttempts) await setupZcodeSolverPage(page, onProgress);
    }
    throw new Error(lastErr);
  } finally {
    await browser?.close().catch(() => {});
  }
}

export async function solveSignupCaptchaWithPlaywright(opts: {
  proxy: string;
  maxAttempts?: number;
  onProgress?: (message: string) => void | Promise<void>;
}): Promise<string> {
  const { proxy, maxAttempts = 3, onProgress } = opts;
  if (!proxy?.trim()) throw new Error("proxy required");

  let browser: Browser | null = null;
  try {
    const launched = await launchCaptchaBrowser(proxy);
    browser = launched.browser;
    const { page, initStore } = launched;
    await setupSolverPage(page, onProgress);

    let lastErr = "captcha failed";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const param = await trySolveOnce(page, initStore, onProgress);
        if (param && param.length > 20) return param;
        lastErr = "empty param";
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
      if (attempt < maxAttempts) await setupSolverPage(page, onProgress);
    }
    throw new Error(lastErr);
  } finally {
    await browser?.close().catch(() => {});
  }
}
