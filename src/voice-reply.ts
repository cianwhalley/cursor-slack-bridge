import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export type SplitVoiceReply = {
  caption: string;
  voicePath: string | undefined;
};

export function splitVoiceReply(text: string): SplitVoiceReply {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let voicePath: string | undefined;
  const kept: string[] = [];
  for (const line of lines) {
    const match = /^VOICE_REPLY:\s*(.+?)\s*$/.exec(line);
    if (match) {
      voicePath = match[1].trim();
      continue;
    }
    kept.push(line);
  }
  return { caption: kept.join("\n").trim(), voicePath };
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function isAllowedVoicePath(
  filePath: string,
  workspace: string,
  home = homedir(),
): boolean {
  if (!filePath || filePath.includes("\0")) return false;
  const resolved = resolve(filePath);
  if (!resolved.toLowerCase().endsWith(".mp3")) return false;
  const roots = [resolve(workspace), resolve(home, ".cache")];
  return roots.some((root) => isInside(root, resolved));
}

export async function unlinkVoiceFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // already gone
  }
}
