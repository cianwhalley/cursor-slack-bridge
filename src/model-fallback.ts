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

/** Transient provider/model failures that are safe to retry on the configured fallback. */
export function isTransientModelError(text: string): boolean {
  const t = text.toLowerCase();
  if (!t.trim()) return false;
  return (
    t.includes("service unavailable") ||
    t.includes("temporarily unavailable") ||
    (t.includes("model") && t.includes("unavailable")) ||
    t.includes("model is degraded") ||
    t.includes("provider is degraded") ||
    t.includes("overloaded") ||
    t.includes("at capacity") ||
    t.includes("upstream error") ||
    t.includes("bad gateway") ||
    t.includes("gateway timeout")
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

export function fallbackModelLabel(model: string | undefined): string {
  if (!model || model === AUTO_MODEL) return "Auto";
  if (model.startsWith("gpt-5.6-sol")) return "GPT-5.6 Sol";
  return model;
}

export function fallbackReplyPrefix(reason: string, model?: string): string {
  return `⚡ *Reply via ${fallbackModelLabel(model)}* — ${reason}\n\n`;
}

/** True when the pinned model failed and we should retry with the configured fallback. */
export function shouldRetryWithFallback(opts: {
  primaryModel: string | undefined;
  fallbackModel: string | undefined;
  errorText: string;
  status: string;
}): boolean {
  const { primaryModel, fallbackModel, errorText, status } = opts;
  if (!primaryModel || !fallbackModel) return false;
  if (primaryModel === fallbackModel || primaryModel === AUTO_MODEL) return false;
  if (!isUsageLimitError(errorText) && !isTransientModelError(errorText)) return false;
  if (status === "error" || status === "timeout") return true;
  // Cursor sometimes surfaces the limit as assistant text with exit 0.
  if (status === "ok") return true;
  return false;
}
