/**
 * Translate `opencode run --format json` lines into the Cursor stream-json
 * shape the progress draft and final-reply extractor already understand.
 */

export const OPENCODE_NEW_SESSION = "pending";

const SESSION_RE = /^ses_[A-Za-z0-9]+$/;

export function isOpenCodeSessionId(id: string | undefined): id is string {
  return Boolean(id && SESSION_RE.test(id));
}

const TOOL_KEYS: Record<string, string> = {
  bash: "bashToolCall",
  shell: "bashToolCall",
  exec: "bashToolCall",
  read: "readToolCall",
  write: "writeToolCall",
  edit: "editToolCall",
  grep: "grepToolCall",
  glob: "globToolCall",
  webfetch: "webFetchToolCall",
  websearch: "webSearchToolCall",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function toolArgs(part: Record<string, unknown>): Record<string, unknown> {
  const state = asRecord(part.state);
  const input = asRecord(state?.input) ?? asRecord(part.input) ?? asRecord(part.args) ?? {};
  return input;
}

function cursorToolKey(name: string): string {
  return TOOL_KEYS[name.toLowerCase()] ?? "taskToolCall";
}

const NARRATION_MAX = 120;

function assistantLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
}

function progressLine(line: string, statusPhrase: string): string {
  return JSON.stringify({ type: "progress", line, statusPhrase });
}

/** First line, capped, for the Slack status and draft. */
function narration(text: string): string | undefined {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  if (!line) return undefined;
  if (line.length <= NARRATION_MAX) return line;
  return `${line.slice(0, NARRATION_MAX - 1)}…`;
}

/**
 * One OpenCode JSON event → Cursor stream-json lines the draft already understands.
 * A text part is both the reply and, when short, a narration line. A tool is shown
 * from its title even when OpenCode only emits it after the command finishes.
 */
export function opencodeEventToCursorLine(line: string): {
  cursorLines: string[];
  sessionId?: string;
} {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return { cursorLines: [] };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { cursorLines: [] };
  }

  const sessionId =
    typeof obj.sessionID === "string"
      ? obj.sessionID
      : typeof obj.sessionId === "string"
        ? obj.sessionId
        : undefined;

  const part = asRecord(obj.part) ?? {};
  const partType = typeof part.type === "string" ? part.type : "";
  const eventType = typeof obj.type === "string" ? obj.type : "";

  if (partType === "reasoning" || partType === "thinking" || eventType === "reasoning") {
    const raw =
      typeof part.text === "string" ? part.text : typeof part.reasoning === "string" ? part.reasoning : "";
    const summary = narration(raw);
    if (!summary) return { sessionId, cursorLines: [] };
    return {
      sessionId,
      cursorLines: [progressLine(`💭 ${summary}`, "is thinking…")],
    };
  }

  if (eventType === "text" || partType === "text") {
    const text = typeof part.text === "string" ? part.text : typeof obj.text === "string" ? obj.text : "";
    if (!text.trim()) return { sessionId, cursorLines: [] };
    const cursorLines = [assistantLine(text)];
    const trimmedText = text.trim();
    if (trimmedText.length <= NARRATION_MAX && !trimmedText.includes("\n")) {
      cursorLines.push(progressLine(`💬 ${trimmedText}`, "is working…"));
    }
    return { sessionId, cursorLines };
  }

  const toolName =
    typeof part.tool === "string"
      ? part.tool
      : typeof part.name === "string"
        ? part.name
        : eventType === "tool" || eventType === "tool_use" || partType === "tool"
          ? "tool"
          : "";
  if (!toolName) return { sessionId, cursorLines: [] };

  const state = asRecord(part.state);
  const args = toolArgs(part);
  const title = typeof state?.title === "string" ? state.title.trim() : "";
  if (title) args.description = title;
  const key = cursorToolKey(toolName);
  if (key === "taskToolCall" && Object.keys(args).length === 0) {
    args.description = title || toolName;
  }
  const statusPhrase = title ? `is running ${title}` : `is running ${toolName}`;

  return {
    sessionId,
    cursorLines: [
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        statusPhrase,
        tool_call: { [key]: { args } },
      }),
    ],
  };
}

/** Hide proxy URLs before a harness error is logged or shown. */
export function redactSecrets(text: string): string {
  return text.replace(/https?:\/\/[^\s'"]+/g, "[url]");
}
