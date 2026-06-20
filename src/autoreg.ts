import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type AutoregStatus = "pending" | "ready" | "synced" | "error";

export type ExportFormat =
  | "email:mail_password"
  | "email:mail_password:zai_password"
  | "email:mail_password:zai_password:api_key"
  | "email:password"
  | "email:password:api_key"
  | "email:password:api_key:proxy"
  | "api_key";

export interface AutoregAccount {
  id: string;
  email: string;
  /** Mailbox password (Firstmail IMAP) */
  mail_password: string | null;
  /** Z.AI account password */
  password: string;
  api_key: string | null;
  proxy: string | null;
  status: AutoregStatus;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface AutoregSettings {
  password_length: number;
  export_format: ExportFormat;
  auto_save_file: boolean;
}

export const DEFAULT_AUTOREG_SETTINGS: AutoregSettings = {
  password_length: 14,
  export_format: "email:mail_password:zai_password:api_key",
  auto_save_file: true,
};

const CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*";

export function generatePassword(length = 14): string {
  const size = Math.max(8, Math.min(32, length));
  const bytes = crypto.randomBytes(size);
  let out = "";
  for (let i = 0; i < size; i++) {
    out += CHARS[bytes[i]! % CHARS.length];
  }
  return out;
}

/** host:port:user:pass | user:pass@host:port | http://... */
export function normalizeProxy(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  if (/^https?:\/\//i.test(s)) return s;

  const atMatch = s.match(/^([^:@]+):([^@]+)@([^:]+):(\d+)$/);
  if (atMatch) {
    return `http://${atMatch[1]}:${atMatch[2]}@${atMatch[3]}:${atMatch[4]}`;
  }

  const parts = s.split(":");
  if (parts.length === 2) {
    return `http://${parts[0]}:${parts[1]}`;
  }
  if (parts.length === 4) {
    return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
  }

  return `http://${s}`;
}

export function maskProxy(proxy: string | null): string {
  if (!proxy) return "—";
  try {
    const u = new URL(proxy);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return proxy.slice(0, 12) + "...";
  }
}

function looksLikeApiKey(s: string): boolean {
  return s.length >= 20 && s.includes(".");
}

export function formatAutoregLine(
  account: AutoregAccount,
  format: ExportFormat
): string {
  const mail = account.mail_password || "";
  const zai = account.password;
  switch (format) {
    case "email:mail_password":
      return `${account.email}:${mail || zai}`;
    case "email:mail_password:zai_password":
      return `${account.email}:${mail}:${zai}`;
    case "email:mail_password:zai_password:api_key":
      return `${account.email}:${mail}:${zai}:${account.api_key || ""}`;
    case "email:password":
      return `${account.email}:${zai}`;
    case "email:password:api_key":
      return `${account.email}:${zai}:${account.api_key || ""}`;
    case "email:password:api_key:proxy":
      return `${account.email}:${zai}:${account.api_key || ""}:${account.proxy || ""}`;
    case "api_key":
      return account.api_key || "";
  }
}

export interface ParsedAutoregLine {
  email: string;
  /** Mailbox password (Firstmail) */
  mail_password?: string;
  /** Z.AI account password */
  password?: string;
  api_key?: string;
  proxy?: string;
}

export function parseAutoregLine(line: string): ParsedAutoregLine | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  if (trimmed.includes("|")) {
    const [left, proxyPart] = trimmed.split("|").map((p) => p.trim());
    const parsed = parseAutoregLine(left);
    if (!parsed) return null;
    parsed.proxy = proxyPart;
    return parsed;
  }

  const parts = trimmed.split(":");
  if (parts.length < 2) return null;

  const email = parts[0]!.trim();
  if (!email.includes("@")) return null;

  if (parts.length === 2) {
    return { email, mail_password: parts[1] };
  }

  const mail_password = parts[1]!;
  const third = parts[2]!;

  if (parts.length === 3) {
    if (looksLikeApiKey(third)) {
      return { email, mail_password, api_key: third };
    }
    return { email, mail_password, password: third };
  }

  const zai_password = third;
  const api_key = parts.slice(3).join(":");
  return { email, mail_password, password: zai_password, api_key: api_key || undefined };
}

export function parseAutoregBulk(text: string): ParsedAutoregLine[] {
  return text
    .split(/[\n\r]+/)
    .map(parseAutoregLine)
    .filter((x): x is ParsedAutoregLine => x !== null);
}

let proxyIndex = 0;

export function parseRetryAfterSeconds(body: string, defaultSec = 35): number {
  const m = body.match(/after\s+(\d+)\s+seconds/i);
  return m ? Math.max(1, parseInt(m[1], 10)) + 2 : defaultSec;
}

export function pickProxyFromPool(proxies: string[]): string | null {
  const available = proxies.map(normalizeProxy).filter(Boolean) as string[];
  if (!available.length) return null;
  const proxy = available[proxyIndex % available.length]!;
  proxyIndex = (proxyIndex + 1) % available.length;
  return proxy;
}

export function writeAccountsFile(
  dataDir: string,
  lines: string[],
  filename = "accounts.txt"
): string {
  const dir = path.join(dataDir, "exports");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  const content = lines.filter(Boolean).join("\n") + (lines.length ? "\n" : "");
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

export function appendAccountLine(
  dataDir: string,
  line: string,
  filename = "accounts.txt"
): string {
  const dir = path.join(dataDir, "exports");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.appendFileSync(filePath, line + "\n", "utf-8");
  return filePath;
}

export function parseVerifyFromText(
  text: string,
  expectedEmail?: string
): {
  token: string;
  email: string;
  username: string;
} | null {
  const decoded = text.replace(/=\r?\n/g, "").replace(/=3D/gi, "=");
  const re = /verify_email\?([^"'<>\s]+)/gi;
  let m: RegExpExecArray | null;
  const expected = expectedEmail?.trim().toLowerCase();

  while ((m = re.exec(decoded)) !== null) {
    try {
      const qs = m[1]!.startsWith("?") ? m[1]!.slice(1) : m[1]!;
      const params = new URLSearchParams(qs.replace(/&amp;/g, "&"));
      const token = params.get("token")?.trim();
      const email = decodeURIComponent(params.get("email") || "").trim();
      const username = (params.get("username") || "").trim();
      if (!token?.startsWith("verify-") || !email || !username) continue;
      if (expected && email.toLowerCase() !== expected) continue;
      return { token, email, username };
    } catch {
      continue;
    }
  }
  return null;
}
