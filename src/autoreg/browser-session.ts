import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";

function sessionDir(): string {
  const dir = path.join(process.cwd(), "data", "autoreg-sessions");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function browserSessionPath(jobId: string): string {
  return path.join(sessionDir(), `${jobId}.json`);
}

export function browserSessionExists(jobId: string): boolean {
  return fs.existsSync(browserSessionPath(jobId));
}

export async function saveBrowserSession(page: Page, jobId: string): Promise<void> {
  await page.context().storageState({ path: browserSessionPath(jobId) });
}

export function clearBrowserSession(jobId: string): void {
  try {
    fs.unlinkSync(browserSessionPath(jobId));
  } catch {
    /* ignore */
  }
}
