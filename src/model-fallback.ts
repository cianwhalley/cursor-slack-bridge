/** Cursor CLI model id for subscription Auto routing. */
export const AUTO_MODEL = "auto";

/** Errors when fast / pinned model quota is exhausted (retry with Auto). */
export function isUsageLimitError(text: string): boolean {
  const t = text.toLowerCase();
  if (!t.trim()) return false;
  return (
    t.includes("actionrequirederror") ||
    t.includes("out of usage") ||
    t.includes("switch to auto") ||
    (t.includes("increase limits") && t.includes("faster")) ||
    (t.includes("usage") && t.includes("limit") && t.includes("faster"))
  );
}

export function agentErrorText(result: {
  status: string;
  text: string;
  stderr: string;
}): string {
  return [result.text, result.stderr].filter(Boolean).join("\n").trim();
}

/** One-line reason for Slack (no secrets). */
export function usageLimitReason(text: string): string {
  const raw = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!raw) return "fast usage limit reached";
  const stripped = raw.replace(/^ActionRequiredError:\s*/i, "").trim();
  return stripped.length > 160 ? `${stripped.slice(0, 157)}…` : stripped;
}

export function switchingToAutoNotice(reason: string): string {
  return `*Switching to Auto mode* — ${reason}. Retrying your message…`;
}

export function autoModeReplyPrefix(reason: string): string {
  return `_Retried in Auto mode (${reason})._\n\n`;
}

export function shouldRetryWithAuto(opts: {
  primaryModel: string | undefined;
  fallbackModel: string | undefined;
  errorText: string;
  status: string;
}): opts is { fallbackModel: string; primaryModel: string; errorText: string; status: string } {
  const { primaryModel, fallbackModel, errorText, status } = opts;
  if (!primaryModel || !fallbackModel) return false;
  if (primaryModel === fallbackModel || primaryModel === AUTO_MODEL) return false;
  if (status !== "error" && status !== "timeout") return false;
  return isUsageLimitError(errorText);
}
