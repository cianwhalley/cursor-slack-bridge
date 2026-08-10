export function stripBotMention(text: string, botUserId?: string): string {
  if (!botUserId) {
    return text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();
  }
  return text.replace(new RegExp(`<@${botUserId}>\\s*`, "g"), "").trim();
}

export function buildPrompt(prefix: string, userText: string, seedContext?: string): string {
  const parts = [prefix, userText.trim()];
  if (seedContext?.trim()) {
    parts.unshift(`${prefix} context from slack thread:\n${seedContext.trim()}\n`);
  }
  return parts.join("\n\n");
}

/**
 * Split text into Slack-safe chunks. Prefer breaking on newlines, then spaces.
 * Does not attempt perfect mrkdwn balance across chunks.
 */
export function chunkText(text: string, limit: number): string[] {
  if (limit < 100) {
    throw new Error("TEXT_CHUNK_LIMIT must be >= 100");
  }
  const trimmed = text.trimEnd();
  if (!trimmed) return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit * 0.4) {
      cut = remaining.lastIndexOf(" ", limit);
    }
    if (cut < limit * 0.4) {
      cut = limit;
    }
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
