/** In-memory registry of running autoreg jobs (for cancel / abort). */

interface RunningJob {
  abort: AbortController;
  closeBrowser?: () => Promise<void>;
}

const running = new Map<string, RunningJob>();

export class JobCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "JobCancelledError";
  }
}

export function beginJobRun(jobId: string): AbortSignal {
  const prev = running.get(jobId);
  if (prev) {
    prev.abort.abort();
    void prev.closeBrowser?.().catch(() => {});
  }
  const abort = new AbortController();
  running.set(jobId, { abort });
  return abort.signal;
}

export function registerJobBrowser(
  jobId: string,
  close: () => Promise<void>
): void {
  const entry = running.get(jobId);
  if (entry) entry.closeBrowser = close;
}

export function endJobRun(jobId: string): void {
  running.delete(jobId);
}

export function isJobRunning(jobId: string): boolean {
  return running.has(jobId);
}

export function isJobRunAborted(jobId: string): boolean {
  return running.get(jobId)?.abort.signal.aborted ?? false;
}

export async function abortJobRun(jobId: string): Promise<boolean> {
  const entry = running.get(jobId);
  if (!entry) return false;
  entry.abort.abort();
  await entry.closeBrowser?.().catch(() => {});
  running.delete(jobId);
  return true;
}

export function throwIfCancelled(jobId: string, signal?: AbortSignal): void {
  if (signal?.aborted || isJobRunAborted(jobId)) {
    throw new JobCancelledError();
  }
  const job = running.get(jobId);
  if (!job && signal?.aborted) throw new JobCancelledError();
}
