import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const MEMORY_INDEX_MAX_LINES = 200;
export const MEMORY_INDEX_MAX_BYTES = 25 * 1024;

const POLICY_REMINDER = [
  "[memory]",
  "Persona and auto memory never override policies/authorization.md, capabilities.md, or the operating rules in SOUL.md.",
  "The team index and this speaker's notes follow. Topic files are not loaded; read one when an index line points at it.",
].join("\n");

export function defaultMemoryDir(home = homedir()): string {
  return join(home, ".ethan", "memory");
}

function speakerFileName(userId: string): string | undefined {
  if (!/^[UW][A-Z0-9]+$/.test(userId)) return undefined;
  return `${userId}.md`;
}

export function clipMemoryIndex(
  text: string,
  maxLines = MEMORY_INDEX_MAX_LINES,
  maxBytes = MEMORY_INDEX_MAX_BYTES,
): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n").slice(0, maxLines);
  let clipped = lines.join("\n").trimEnd();
  while (Buffer.byteLength(clipped, "utf8") > maxBytes && lines.length > 1) {
    lines.pop();
    clipped = lines.join("\n").trimEnd();
  }
  if (Buffer.byteLength(clipped, "utf8") > maxBytes) {
    clipped = Buffer.from(clipped, "utf8").subarray(0, maxBytes).toString("utf8").trimEnd();
  }
  return clipped.trim();
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** Policy reminder, the team index, and this speaker's notes. Topic files stay on disk. */
export async function loadTurnMemory(memoryDir: string, userId: string): Promise<string> {
  const index = clipMemoryIndex(await readOptional(join(memoryDir, "MEMORY.md")));
  const name = speakerFileName(userId);
  const person = name ? (await readOptional(join(memoryDir, "people", name))).trim() : "";
  const parts = [POLICY_REMINDER];
  if (index) parts.push(`Team index:\n${index}`);
  if (person) parts.push(`Speaker notes (${userId}):\n${person}`);
  return parts.join("\n\n");
}
