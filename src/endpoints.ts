import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type GatewayEndpoint =
  | "general"
  | "coding"
  | "anthropic"
  | "zcode-plan";

export const ENDPOINT_META: Record<
  GatewayEndpoint,
  { label: string; baseUrl: string; protocol: "openai" | "anthropic" }
> = {
  general: {
    label: "Open Platform (general)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    protocol: "openai",
  },
  coding: {
    label: "GLM Coding Plan (OpenAI)",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    protocol: "openai",
  },
  anthropic: {
    label: "GLM Coding Plan (Anthropic)",
    baseUrl: "https://api.z.ai/api/anthropic",
    protocol: "anthropic",
  },
  "zcode-plan": {
    label: "ZCode Start Plan (как редактор)",
    baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
    protocol: "anthropic",
  },
};

export function defaultZcodeConfigPath(): string {
  return path.join(os.homedir(), ".zcode", "v2", "config.json");
}

export function readZcodeJwt(configPath?: string): string | null {
  const p = configPath || defaultZcodeConfigPath();
  if (!fs.existsSync(p)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(p, "utf-8")) as {
      provider?: Record<string, { options?: { apiKey?: string }; enabled?: boolean }>;
    };
    const providers = cfg.provider || {};
    for (const id of [
      "builtin:zai-start-plan",
      "builtin:bigmodel-start-plan",
      "builtin:zai-coding-plan",
    ]) {
      const block = providers[id];
      const key = block?.options?.apiKey?.trim();
      if (key && key.startsWith("eyJ")) return key;
    }
    for (const block of Object.values(providers)) {
      const key = block?.options?.apiKey?.trim();
      if (key && key.startsWith("eyJ")) return key;
    }
  } catch {
    return null;
  }
  return null;
}

export function zcodeConfigSummary(configPath?: string): {
  configPath: string;
  found: boolean;
  hasJwt: boolean;
  activeProvider: string | null;
} {
  const p = configPath || defaultZcodeConfigPath();
  if (!fs.existsSync(p)) {
    return { configPath: p, found: false, hasJwt: false, activeProvider: null };
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(p, "utf-8")) as {
      provider?: Record<string, { enabled?: boolean }>;
    };
    const active = Object.entries(cfg.provider || {}).find(([, v]) => v.enabled)?.[0] || null;
    return {
      configPath: p,
      found: true,
      hasJwt: Boolean(readZcodeJwt(p)),
      activeProvider: active,
    };
  } catch {
    return { configPath: p, found: true, hasJwt: false, activeProvider: null };
  }
}
