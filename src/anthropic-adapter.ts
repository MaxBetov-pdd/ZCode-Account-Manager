/** OpenAI chat/completions ↔ Anthropic messages (minimal) */

export function toAnthropicModel(raw: string): string {
  const m = raw.trim();
  const lower = m.toLowerCase();
  if (lower === "glm-5.2-max" || lower === "glm-5.2_max") return "GLM-5.2";
  if (lower === "glm-5.2") return "GLM-5.2";
  if (lower === "glm-5-turbo") return "GLM-5-Turbo";
  if (m.startsWith("GLM-")) return m;
  return m;
}

export function openAiChatToAnthropic(
  body: Record<string, unknown>
): Record<string, unknown> {
  const rawMessages = (body.messages || []) as Array<{
    role: string;
    content: unknown;
  }>;

  const systemParts: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const msg of rawMessages) {
    const text =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content ?? "");
    if (msg.role === "system") {
      systemParts.push(text);
      continue;
    }
    messages.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: text,
    });
  }

  const out: Record<string, unknown> = {
    model: toAnthropicModel(String(body.model || "GLM-5.2")),
    max_tokens: body.max_tokens ?? 8192,
    messages,
    stream: body.stream === true,
  };

  if (systemParts.length) {
    out.system = systemParts.join("\n\n");
  }

  const thinking = body.thinking as { type?: string; budget_tokens?: number } | undefined;
  if (thinking?.type === "enabled") {
    out.thinking = {
      type: "enabled",
      budget_tokens: thinking.budget_tokens ?? 32000,
    };
  }

  const effort = body.reasoning_effort || (body.output_config as { effort?: string })?.effort;
  if (effort === "max") {
    out.output_config = { effort: "max" };
  }

  return out;
}

export function anthropicToOpenAiCompletion(
  data: Record<string, unknown>,
  model: string
): Record<string, unknown> {
  const content = (data.content as Array<{ type?: string; text?: string }>) || [];
  const text = content
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("");

  const usage = (data.usage as Record<string, number>) || {};
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;

  return {
    id: String(data.id || "chatcmpl-zai"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: data.stop_reason === "end_turn" ? "stop" : "stop",
      },
    ],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output,
    },
  };
}

export function anthropicModelsList(): {
  object: string;
  data: { id: string; object: string; owned_by: string }[];
} {
  return {
    object: "list",
    data: [
      { id: "GLM-5.2", object: "model", owned_by: "zcode" },
      { id: "GLM-5-Turbo", object: "model", owned_by: "zcode" },
      { id: "glm-5.2", object: "model", owned_by: "zcode" },
      { id: "glm-5-turbo", object: "model", owned_by: "zcode" },
    ],
  };
}
