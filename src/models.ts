export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
}

/** Official model IDs from https://docs.z.ai/api-reference/llm/chat-completion */
export const ZAI_MODELS: ModelInfo[] = [
  { id: "glm-5.2", name: "GLM-5.2", description: "Flagship, reasoning_effort=max" },
  { id: "glm-5.2[1m]", name: "GLM-5.2 1M", description: "1M context (Claude Code style)" },
  { id: "glm-5.1", name: "GLM-5.1" },
  { id: "glm-5-turbo", name: "GLM-5-Turbo" },
  { id: "glm-5", name: "GLM-5" },
  { id: "glm-4.7", name: "GLM-4.7" },
  { id: "glm-4.6", name: "GLM-4.6" },
  { id: "glm-4.5", name: "GLM-4.5" },
];

const MAX_ALIASES = new Set([
  "glm-5.2-max",
  "glm-5.2_max",
  "glm-5.2 max",
  "glm-52-max",
  "glm-5.2max",
  "glm-5.2-max",
  "glm-5.2[max]",
]);

export function normalizeModelName(raw: string): string {
  const m = raw.trim().toLowerCase();
  if (MAX_ALIASES.has(m)) return "glm-5.2";
  if (m === "glm-5.2[1m]") return "glm-5.2[1m]";
  const known = ZAI_MODELS.find((x) => x.id.toLowerCase() === m);
  if (known) return known.id;
  return raw.trim();
}

export function prepareChatBody(
  body: Record<string, unknown>,
  defaultModel = "glm-5.2"
): Record<string, unknown> {
  const out = { ...body };
  const rawModel = String(body.model || defaultModel);
  const lower = rawModel.toLowerCase().trim();

  const wantsMax = MAX_ALIASES.has(lower);
  out.model = wantsMax ? "glm-5.2" : normalizeModelName(rawModel);

  if (wantsMax || lower === "glm-5.2[max]") {
    if (!out.thinking) {
      out.thinking = { type: "enabled" };
    }
    if (!out.reasoning_effort) {
      out.reasoning_effort = "max";
    }
  }

  return out;
}

export function openAiModelsList(): { object: string; data: { id: string; object: string; owned_by: string }[] } {
  return {
    object: "list",
    data: ZAI_MODELS.map((m) => ({
      id: m.id,
      object: "model",
      owned_by: "z.ai",
    })),
  };
}
