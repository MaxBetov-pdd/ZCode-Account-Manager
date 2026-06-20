import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchZcodeCaptchaConfig } from "./captcha-config.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const CAPTCHA_NODE_DIR = path.join(ROOT, "captcha_node");
const SOLVER_JS = path.join(CAPTCHA_NODE_DIR, "solver.js");

const CACHE_TTL_MS = Number(process.env.CAPTCHA_CACHE_TTL_MS || 45_000);
const SOLVE_RETRIES = Number(process.env.ZCODE_CAPTCHA_RETRIES || 4);
const SOLVE_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_TIMEOUT || 40) * 1000;
const NODE_BIN = process.env.ZCODE_NODE_PATH?.trim() || "node";

type CacheEntry = { param: string; cachedAt: number };

class JsdomCaptchaManager {
  /** Key = proxy URL or "direct" — captcha is IP-bound */
  private cache = new Map<string, CacheEntry>();
  private locks = new Map<string, Promise<string>>();

  invalidate(proxy?: string): void {
    this.cache.delete(cacheKey(proxy));
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  async getVerifyParam(proxy?: string): Promise<string> {
    const key = cacheKey(proxy);
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.cachedAt < CACHE_TTL_MS) {
      return hit.param;
    }

    const pending = this.locks.get(key);
    if (pending) return pending;

    const work = this.solveFresh(proxy).finally(() => {
      this.locks.delete(key);
    });
    this.locks.set(key, work);
    return work;
  }

  private async solveFresh(proxy?: string): Promise<string> {
    const key = cacheKey(proxy);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) {
      return hit.param;
    }

    const cfg = await fetchZcodeCaptchaConfig();
    let lastErr: string | null = null;

    for (let attempt = 1; attempt <= SOLVE_RETRIES; attempt++) {
      try {
        const param = await runSolver(
          cfg.sceneId,
          cfg.region,
          cfg.prefix,
          proxy
        );
        if (param) {
          this.cache.set(key, { param, cachedAt: Date.now() });
          return param;
        }
        lastErr = "solver returned empty";
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
    }

    throw new Error(
      `jsdom captcha failed after ${SOLVE_RETRIES} attempts: ${lastErr ?? "unknown"}`
    );
  }
}

function cacheKey(proxy?: string): string {
  return proxy?.trim() || "direct";
}

function runSolver(
  scene: string,
  region: string,
  prefix: string,
  proxy?: string
): Promise<string> {
  if (!fs.existsSync(SOLVER_JS)) {
    return Promise.reject(
      new Error(
        `Missing ${SOLVER_JS}. Run: cd captcha_node && npm install`
      )
    );
  }

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    const px = proxy?.trim();
    if (px) {
      env.HTTP_PROXY = px;
      env.HTTPS_PROXY = px;
    }

    const proc = spawn(NODE_BIN, [SOLVER_JS, scene, region, prefix], {
      cwd: CAPTCHA_NODE_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`jsdom captcha timeout (${SOLVE_TIMEOUT_MS}ms)`));
    }, SOLVE_TIMEOUT_MS);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`cannot spawn ${NODE_BIN}: ${err.message}`));
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      for (const line of stdout.split(/\r?\n/)) {
        if (line.startsWith("VERIFY_PARAM=")) {
          const param = line.slice("VERIFY_PARAM=".length).trim();
          if (param.length > 20) {
            resolve(param);
            return;
          }
        }
      }
      reject(
        new Error(
          `jsdom captcha exit ${code ?? "?"}: ${stderr.slice(0, 200) || stdout.slice(0, 200) || "no output"}`
        )
      );
    });
  });
}

export const jsdomCaptchaManager = new JsdomCaptchaManager();

export async function solveZcodeCaptchaJsdom(proxy?: string): Promise<string> {
  return jsdomCaptchaManager.getVerifyParam(proxy);
}

export function invalidateJsdomCaptcha(proxy?: string): void {
  if (proxy === undefined) {
    jsdomCaptchaManager.invalidateAll();
  } else {
    jsdomCaptchaManager.invalidate(proxy);
  }
}
