/**
 * Parse Cursor `agent --output-format stream-json` lines into public progress
 * and final reply text. Mirrors OpenClaw: never surface private thinking;
 * prefer the last assistant text (Cursor's `result` concatenates all bubbles).
 */

import {
  findCursorToolEntry,
  formatOcToolProgressLine,
  type CommandTextMode,
  type ToolDetailMode,
} from "./oc-tool-display.js";

export type StreamProgressEvent = {
  kind: "tool";
  line: string;
  statusPhrase?: string;
};

export interface ProgressParseOptions {
  detailMode?: ToolDetailMode;
  commandText?: CommandTextMode;
  maxLineChars?: number;
  /** OpenClaw streaming.progress.commentary — default false. */
  commentary?: boolean;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && "text" in block) {
      parts.push(String((block as { text: string }).text));
    }
  }
  return parts.join("");
}

/** Compact OpenClaw-style progress line from a stream-json object. */
export function progressFromStreamObject(
  obj: Record<string, unknown>,
  options: ProgressParseOptions = {},
): StreamProgressEvent | undefined {
  const type = obj.type;
  if (type === "tool_call" && obj.subtype === "started") {
    const toolCall = (obj.tool_call ?? {}) as Record<string, unknown>;
    const entry = findCursorToolEntry(toolCall);
    if (!entry) return undefined;
    const line = formatOcToolProgressLine(entry.key, entry.payload, {
      detailMode: options.detailMode,
      commandText: options.commandText,
      maxLineChars: options.maxLineChars,
    });
    if (!line) return undefined;
    const name = entry.key.replace(/ToolCall$/, "").toLowerCase();
    return {
      kind: "tool",
      line,
      statusPhrase: `is running ${name}`,
    };
  }
  // OpenClaw commentary lane defaults off — do not push assistant preambles into the draft.
  if (type === "assistant" && options.commentary) {
    const text = contentText((obj.message as { content?: unknown } | undefined)?.content).trim();
    if (text && text.length <= 120 && !text.includes("\n")) {
      return {
        kind: "tool",
        line: `💬 ${text}`,
        statusPhrase: "is working…",
      };
    }
  }
  return undefined;
}

export function progressFromStreamLine(
  line: string,
  options: ProgressParseOptions = {},
): StreamProgressEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return progressFromStreamObject(JSON.parse(trimmed) as Record<string, unknown>, options);
  } catch {
    return undefined;
  }
}

/**
 * Final Slack text: last assistant message content.
 * Ignores thinking; does not use Cursor `result` (it joins all assistant bubbles).
 */
export function extractAssistantText(streamJsonLines: string[]): string {
  let lastAssistant = "";
  for (const line of streamJsonLines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed) as {
        type?: string;
        message?: { content?: unknown };
      };
      if (obj.type === "thinking") continue;
      if (obj.type === "assistant") {
        const text = contentText(obj.message?.content).trim();
        if (text) lastAssistant = text;
      }
    } catch {
      // ignore
    }
  }
  return lastAssistant;
}
