import { toAnthropicModel } from "../anthropic-adapter.js";

type TextBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

function toTextBlocks(content: unknown): TextBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: "text", text: JSON.stringify(content ?? "") }];
  }
  return content.map((block) => {
    if (typeof block === "string") return { type: "text" as const, text: block };
    const b = block as { type?: string; text?: string; cache_control?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      return {
        type: "text" as const,
        text: b.text,
        ...(b.cache_control ? { cache_control: b.cache_control as { type: "ephemeral" } } : {}),
      };
    }
    return { type: "text" as const, text: JSON.stringify(block) };
  });
}

function normalizeSystem(system: unknown): TextBlock[] {
  if (Array.isArray(system)) {
    return system.flatMap((part) => {
      if (typeof part === "string") {
        return [{ type: "text" as const, text: part, cache_control: { type: "ephemeral" as const } }];
      }
      const p = part as { type?: string; text?: string; cache_control?: unknown };
      if (p.type === "text" && typeof p.text === "string") {
        return [
          {
            type: "text" as const,
            text: p.text,
            cache_control: (p.cache_control as { type: "ephemeral" }) ?? { type: "ephemeral" },
          },
        ];
      }
      return [{ type: "text" as const, text: JSON.stringify(part) }];
    });
  }
  if (typeof system === "string" && system.trim()) {
    return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  }
  return [
    {
      type: "text",
      text: "You are ZCode, an interactive coding agent",
      cache_control: { type: "ephemeral" },
    },
  ];
}

/** Shape Anthropic body like ZCode 3.1.2 agent (from traffic capture). */
export function normalizeZcodeAnthropicBody(
  body: Record<string, unknown>
): Record<string, unknown> {
  const thinking = body.thinking as { type?: string; budget_tokens?: number } | undefined;
  const outputConfig = body.output_config as { effort?: string } | undefined;

  const messages = ((body.messages || []) as Array<{ role: string; content: unknown }>).map(
    (msg) => {
      const blocks = toTextBlocks(msg.content);
      if (msg.role === "user" && blocks.length > 0) {
        const last = blocks[blocks.length - 1]!;
        if (!last.cache_control) {
          last.cache_control = { type: "ephemeral" };
        }
      }
      return { role: msg.role, content: blocks };
    }
  );

  const out: Record<string, unknown> = {
    model: toAnthropicModel(String(body.model || "GLM-5.2")),
    max_tokens: body.max_tokens ?? 8192,
    thinking: thinking?.type
      ? thinking
      : { type: "enabled", budget_tokens: 32000 },
    output_config: outputConfig?.effort
      ? outputConfig
      : { effort: "max" },
    system: normalizeSystem(body.system),
    messages,
    stream: true,
  };

  if (body.tools) out.tools = body.tools;
  if (body.tool_choice) out.tool_choice = body.tool_choice;

  return out;
}
