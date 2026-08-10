/**
 * OpenClaw-aligned tool progress lines for Cursor stream-json tool_calls.
 *
 * Defaults match OpenClaw: toolProgressDetail=explain, commandText=raw (show
 * human labels), commentary off. Shell lines use emoji + detail (no "Bash:"
 * prefix) — see openclaw `formatToolSummary` / `resolveExecDetail`.
 */

export type ToolDetailMode = "explain" | "raw";
export type CommandTextMode = "raw" | "status";

export interface ToolDisplayOptions {
  detailMode?: ToolDetailMode;
  commandText?: CommandTextMode;
  maxLineChars?: number;
}

const DEFAULT_MAX_LINE = 120;

const TOOL_META: Record<string, { emoji: string; label: string }> = {
  shell: { emoji: "🛠️", label: "Bash" },
  bash: { emoji: "🛠️", label: "Bash" },
  exec: { emoji: "🛠️", label: "Bash" },
  read: { emoji: "📖", label: "Read" },
  write: { emoji: "✍️", label: "Write" },
  edit: { emoji: "📝", label: "Edit" },
  delete: { emoji: "🗑️", label: "Delete" },
  grep: { emoji: "🔎", label: "Grep" },
  glob: { emoji: "🗂️", label: "Glob" },
  search: { emoji: "🔎", label: "Search" },
  websearch: { emoji: "🔎", label: "Web Search" },
  webfetch: { emoji: "🌐", label: "Web Fetch" },
  updatetodos: { emoji: "📋", label: "Todos" },
  todowrite: { emoji: "📋", label: "Todos" },
  task: { emoji: "🤖", label: "Task" },
};

/** Cursor `*ToolCall` key → canonical tool name. */
export function normalizeCursorToolName(toolCallKey: string): string {
  const base = toolCallKey.replace(/ToolCall$/, "");
  const lower = base.toLowerCase();
  if (lower === "shell" || lower === "bash" || lower === "exec") return "shell";
  if (lower === "read" || lower === "readfile") return "read";
  if (lower === "write" || lower === "writefile") return "write";
  if (lower === "edit" || lower === "strreplace" || lower === "applypatch") return "edit";
  if (lower === "delete" || lower === "deletefile") return "delete";
  if (lower === "grep" || lower === "rg") return "grep";
  if (lower === "glob" || lower === "globfilesearch") return "glob";
  if (lower === "websearch") return "websearch";
  if (lower === "webfetch" || lower === "fetch") return "webfetch";
  if (lower === "updatetodos" || lower === "todowrite") return "updatetodos";
  return lower;
}

function shortenHome(text: string): string {
  return text
    .replace(/\/home\/[^/\s]+/g, "~")
    .replace(/\/Users\/[^/\s]+/g, "~");
}

/** Middle-ellipsis truncate (OpenClaw progress maxLineChars default 120). */
export function truncateProgressLine(text: string, maxChars = DEFAULT_MAX_LINE): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(-(maxChars - 1 - half))}`;
}

/** Strip leading cd / export / set boilerplate (OpenClaw stripShellPreamble spirit). */
export function stripShellPreamble(command: string): string {
  let rest = command.trim();
  // Drop leading env assignments and set/cd lines joined with ; or &&
  for (let i = 0; i < 12; i++) {
    const m = rest.match(
      /^(?:export\s+[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s*;\s*|set\s+-[a-zA-Z]+\s*;\s*|cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*(?:&&|;)\s*)/,
    );
    if (!m) break;
    rest = rest.slice(m[0].length).trim();
  }
  return rest;
}

function explainShell(command: string): string {
  const cleaned = stripShellPreamble(command);
  const words = cleaned.split(/\s+/).filter(Boolean);
  const bin = (words[0] ?? "command").replace(/^\.\//, "").split("/").pop() ?? "command";

  if (bin === "hostname") return "hostname";
  if (bin === "pwd") return "print working directory";
  if (bin === "ls") {
    const target = words.find((w, i) => i > 0 && !w.startsWith("-"));
    return target ? `list files in ${shortenHome(target)}` : "list files";
  }
  if (bin === "cat" || bin === "head" || bin === "tail") {
    const target = words.find((w, i) => i > 0 && !w.startsWith("-") && !/^\d+$/.test(w));
    return target ? `show ${shortenHome(target)}` : `show ${bin} output`;
  }
  if (bin === "git") {
    const sub = words[1];
    const map: Record<string, string> = {
      status: "check git status",
      diff: "check git diff",
      log: "view git history",
      pull: "pull git changes",
      push: "push git changes",
      fetch: "fetch git changes",
      commit: "create git commit",
      add: "stage git changes",
      checkout: "switch git branch",
      branch: "list git branches",
    };
    if (sub && map[sub]) return map[sub];
    return sub ? `run git ${sub}` : "run git command";
  }
  if (bin === "grep" || bin === "rg") return "search text";
  if (bin === "find") return "find files";
  if (bin === "npm" || bin === "pnpm" || bin === "yarn" || bin === "bun") {
    return `run ${bin} ${words[1] ?? "command"}`;
  }
  if (bin === "python" || bin === "python3" || bin === "node") {
    return `run ${bin} script`;
  }
  if (bin === "systemctl") return `systemctl ${words[1] ?? ""}`.trim();
  if (bin === "which" || bin === "command") return `locate ${words[1] ?? "binary"}`;
  // Prefer short binary+arg over full pipeline noise
  if (cleaned.length <= 60) return cleaned;
  return `run ${bin}`;
}

function pathFromArgs(args: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file_path", "filePath", "targetFile", "target_file"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return shortenHome(v.trim());
  }
  return undefined;
}

function detailForTool(
  name: string,
  args: Record<string, unknown>,
  detailMode: ToolDetailMode,
): string | undefined {
  if (name === "shell") {
    const description =
      typeof args.description === "string" ? args.description.trim() : undefined;
    const command = typeof args.command === "string" ? args.command.trim() : undefined;
    if (detailMode === "explain") {
      if (description) return description;
      if (command) return explainShell(command);
      return undefined;
    }
    // raw: explain · command
    const explain = description || (command ? explainShell(command) : undefined);
    if (command) {
      const compact = stripShellPreamble(command).replace(/\s+/g, " ");
      if (explain && explain !== compact) return `${explain} · ${compact}`;
      return compact;
    }
    return explain;
  }

  if (name === "read") {
    const path = pathFromArgs(args);
    return path ? `from ${path}` : undefined;
  }
  if (name === "write") {
    const path = pathFromArgs(args);
    return path ? `to ${path}` : undefined;
  }
  if (name === "edit") {
    const path = pathFromArgs(args);
    return path ? `in ${path}` : undefined;
  }
  if (name === "delete") {
    const path = pathFromArgs(args);
    return path ? path : undefined;
  }
  if (name === "grep" || name === "search") {
    const pattern =
      (typeof args.pattern === "string" && args.pattern) ||
      (typeof args.query === "string" && args.query) ||
      undefined;
    const path = pathFromArgs(args) || (typeof args.path === "string" ? args.path : undefined);
    if (pattern && path) return `"${pattern}" in ${shortenHome(path)}`;
    if (pattern) return `for "${pattern}"`;
    return undefined;
  }
  if (name === "glob") {
    const g =
      (typeof args.globPattern === "string" && args.globPattern) ||
      (typeof args.glob === "string" && args.glob) ||
      (typeof args.pattern === "string" && args.pattern) ||
      undefined;
    return g ? `for ${g}` : undefined;
  }
  if (name === "websearch") {
    const q = typeof args.query === "string" ? args.query : undefined;
    return q ? `for "${q}"` : undefined;
  }
  if (name === "webfetch") {
    const url = typeof args.url === "string" ? args.url : undefined;
    return url;
  }
  if (name === "updatetodos") {
    return undefined; // label only
  }
  return undefined;
}

/**
 * Format one OpenClaw-style progress line from a Cursor tool_call payload.
 * Returns undefined for tools that should stay off the draft (none today).
 */
export function formatOcToolProgressLine(
  toolCallKey: string,
  toolPayload: Record<string, unknown>,
  options: ToolDisplayOptions = {},
): string | undefined {
  const detailMode = options.detailMode ?? "explain";
  const commandText = options.commandText ?? "raw";
  const maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE;

  const name = normalizeCursorToolName(toolCallKey);
  const meta = TOOL_META[name] ?? { emoji: "🧩", label: defaultTitle(toolCallKey) };
  const args = (toolPayload.args ?? toolPayload) as Record<string, unknown>;

  const isShell = name === "shell";
  if (isShell && commandText === "status") {
    return truncateProgressLine(`${meta.emoji} ${meta.label}`, maxLineChars);
  }

  const detail = detailForTool(name, args, detailMode);
  let line: string;
  if (isShell && detail) {
    // OpenClaw: shell-family → `${emoji} ${detail}` (no Label:)
    line = `${meta.emoji} ${detail}`;
  } else if (detail) {
    line = `${meta.emoji} ${meta.label}: ${detail}`;
  } else {
    line = `${meta.emoji} ${meta.label}`;
  }
  return truncateProgressLine(shortenHome(line), maxLineChars);
}

function defaultTitle(toolCallKey: string): string {
  const base = toolCallKey.replace(/ToolCall$/, "");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Extract first *ToolCall entry from Cursor stream-json tool_call object. */
export function findCursorToolEntry(
  toolCall: Record<string, unknown>,
): { key: string; payload: Record<string, unknown> } | undefined {
  for (const [key, value] of Object.entries(toolCall)) {
    if (key.endsWith("ToolCall") && value && typeof value === "object") {
      return { key, payload: value as Record<string, unknown> };
    }
  }
  return undefined;
}
