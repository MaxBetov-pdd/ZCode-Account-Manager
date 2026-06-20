import { anonymizeProxy, closeAnonymizedProxy } from "proxy-chain";

export interface JobBrowserProxy {
  /** Local anonymized proxy URL, e.g. http://127.0.0.1:52812. "direct" = no proxy. */
  url: string;
  host: string;
  port: number;
  /** host:port for Chrome / Windows proxy settings */
  display: string;
}

const localProxies = new Map<string, JobBrowserProxy>();

/** Маркер «идти напрямую с локального IP» — без прокси-туннеля. */
export const DIRECT_MARKER = "direct://";

export function isDirectProxy(proxy: string | null | undefined): boolean {
  return !proxy || proxy.trim() === DIRECT_MARKER;
}

/** Local forward proxy → job.proxy (browser captcha must use the same egress). */
export async function ensureJobBrowserProxy(
  jobId: string,
  upstreamProxy: string
): Promise<JobBrowserProxy> {
  const existing = localProxies.get(jobId);
  if (existing) return existing;

  // direct:// — без туннеля: браузер и HTTP идут напрямую с локального IP.
  if (isDirectProxy(upstreamProxy)) {
    const entry: JobBrowserProxy = {
      url: "direct",
      host: "",
      port: 0,
      display: "(direct — no proxy)",
    };
    localProxies.set(jobId, entry);
    return entry;
  }

  const url = await anonymizeProxy(upstreamProxy);
  const u = new URL(url);
  const entry: JobBrowserProxy = {
    url,
    host: u.hostname,
    port: Number(u.port),
    display: `${u.hostname}:${u.port}`,
  };
  localProxies.set(jobId, entry);
  return entry;
}

export function getJobBrowserProxy(jobId: string): JobBrowserProxy | null {
  return localProxies.get(jobId) ?? null;
}

export async function closeJobBrowserProxy(jobId: string): Promise<void> {
  const entry = localProxies.get(jobId);
  if (!entry) return;
  localProxies.delete(jobId);
  try {
    await closeAnonymizedProxy(entry.url, true);
  } catch {
    /* already closed */
  }
}
