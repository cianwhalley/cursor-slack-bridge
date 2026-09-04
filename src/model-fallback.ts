/** Cursor CLI model id for subscription Auto routing. */
export const AUTO_MODEL = "auto";

/** Built-in hop list when AGENT_MODEL_FALLBACK is unset. */
export const DEFAULT_FALLBACK_SPECS = ["latest", "sonnet", "sol"] as const;

const EFFORTS = [
  "extra-high",
  "xhigh",
  "max",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
] as const;

type Effort = (typeof EFFORTS)[number];

export type ModelFamily = "auto" | "grok" | "sonnet5" | "sol" | "other";

export interface ParsedModel {
  raw: string;
  family: ModelFamily;
  version: number[];
  effort: Effort;
  fast: boolean;
  thinking: boolean;
}

/** Errors when fast / pinned model quota is exhausted (retry with Auto / chain). */
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

/**
 * Catalog / account errors: pinned id retired, not on this plan, or not in
 * the CLI allow-list. Distinct from transient "unavailable" (outage).
 */
export function isUnavailableModelError(text: string): boolean {
  const t = text.toLowerCase();
  if (!t.trim()) return false;
  return (
    t.includes("cannot use this model") ||
    t.includes("available models:") ||
    t.includes("unknown model") ||
    t.includes("invalid model") ||
    t.includes("model not found") ||
    t.includes("not a valid model") ||
    t.includes("model is not available") ||
    t.includes("model not available") ||
    t.includes("unsupported model")
  );
}

/** Transient provider/model failures that are safe to retry on the next hop. */
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

export function isRetryableModelError(text: string): boolean {
  return (
    isUsageLimitError(text) ||
    isTransientModelError(text) ||
    isUnavailableModelError(text)
  );
}

export function agentErrorText(result: {
  status: string;
  text: string;
  stderr: string;
}): string {
  return [result.text, result.stderr].filter(Boolean).join("\n").trim();
}

/** Strip the huge "Available models:" dump from Slack-facing errors. */
export function publicAgentError(text: string): string {
  const cut = text.search(/available models:/i);
  if (cut === -1) return text.trim();
  return `${text.slice(0, cut).trim().replace(/[.:]+$/, "")} (not on this account / retired)`;
}

/** One-line reason for Slack (no secrets, no catalog dump). */
export function usageLimitReason(text: string): string {
  if (isUnavailableModelError(text) && !isUsageLimitError(text)) {
    return "pinned model is not available";
  }
  const raw = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!raw) return "fast usage limit reached";
  const stripped = raw
    .replace(/^ActionRequiredError:\s*/i, "")
    .replace(/\s*Available models:[\s\S]*/i, "")
    .trim();
  return stripped.length > 160 ? `${stripped.slice(0, 157)}…` : stripped;
}

export function fallbackModelLabel(model: string | undefined): string {
  if (!model || model === AUTO_MODEL) return "Auto";
  const parsed = parseModel(model);
  if (parsed.family === "grok") {
    const v = formatVersion(parsed.version);
    return v ? `Grok ${v}` : "Grok";
  }
  if (parsed.family === "sonnet5") return "Sonnet 5";
  if (parsed.family === "sol") return "GPT Sol";
  if (model.startsWith("gpt-5.6-sol")) return "GPT-5.6 Sol";
  return model;
}

export function fallbackReplyPrefix(reason: string, model?: string): string {
  return `⚡ *Reply via ${fallbackModelLabel(model)}* — ${reason}\n\n`;
}

export function parseAvailableModels(text: string): string[] {
  const m = text.match(/available models:\s*([\s\S]+)/i);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/[.;]+$/g, ""))
    .filter((s) => s.length > 0 && !/\s/.test(s));
}

export function parseModel(raw: string): ParsedModel {
  const id = raw.trim();
  const lower = id.toLowerCase();
  const family = detectFamily(lower);
  const version = parseVersion(lower, family);
  const remainder = remainderTokens(lower, family, version);
  return {
    raw: id,
    family,
    version,
    effort: parseEffort(remainder),
    fast: remainder.includes("fast"),
    thinking: remainder.includes("thinking"),
  };
}

/**
 * Resolve the retry hop list for a failed primary.
 * Specs: `latest` (same family + options, else Auto), `sonnet`, `sol`,
 * or a concrete Cursor model id.
 */
export function resolveFallbackChain(opts: {
  primaryModel: string | undefined;
  fallbackSpecs: string[] | undefined;
  errorText: string;
  tried?: Iterable<string>;
}): string[] {
  const specs = opts.fallbackSpecs;
  if (!specs?.length) return [];
  const primary = opts.primaryModel?.trim();
  if (!primary) return [];
  const available = parseAvailableModels(opts.errorText);
  const tried = new Set(
    [...(opts.tried ?? []), primary].map((s) => s.trim()).filter(Boolean),
  );
  const parsedPrimary = parseModel(primary);
  const out: string[] = [];
  for (const spec of specs) {
    const resolved = resolveSpec(spec, parsedPrimary, available);
    if (!resolved || tried.has(resolved)) continue;
    tried.add(resolved);
    out.push(resolved);
  }
  return out;
}

/** True when the pinned model failed and we should retry with the next hop. */
export function shouldRetryWithFallback(opts: {
  primaryModel: string | undefined;
  fallbackModel: string | undefined;
  errorText: string;
  status: string;
}): boolean {
  const { primaryModel, fallbackModel, errorText, status } = opts;
  if (!primaryModel || !fallbackModel) return false;
  if (primaryModel === fallbackModel) return false;
  if (!isRetryableModelError(errorText)) return false;
  if (status === "error" || status === "timeout") return true;
  if (status === "ok") return true;
  return false;
}

export function shouldRetryModelError(errorText: string, status: string): boolean {
  if (!isRetryableModelError(errorText)) return false;
  return status === "error" || status === "timeout" || status === "ok";
}

function detectFamily(lower: string): ModelFamily {
  if (lower === AUTO_MODEL || lower === "latest") return "auto";
  if (lower.includes("grok")) return "grok";
  if (/sonnet-5\b/.test(lower) || lower.includes("claude-sonnet-5")) return "sonnet5";
  if (/(^|-)sol(-|$)/.test(lower)) return "sol";
  return "other";
}

function parseVersion(lower: string, family: ModelFamily): number[] {
  let m: RegExpMatchArray | null = null;
  if (family === "grok") m = lower.match(/grok-(\d+(?:\.\d+)*)/);
  else if (family === "sonnet5") m = lower.match(/sonnet-(\d+(?:[.-]\d+)*)/);
  else if (family === "sol") m = lower.match(/gpt-(\d+(?:\.\d+)*)-sol/);
  else m = lower.match(/(\d+(?:\.\d+)+)/);
  if (!m) return [];
  return m[1].split(/[.-]/).map((n) => Number(n)).filter((n) => Number.isFinite(n));
}

function remainderTokens(lower: string, family: ModelFamily, version: number[]): string[] {
  let rest = lower;
  if (family === "grok") rest = rest.replace(/^cursor-grok-\d+(?:\.\d+)*/, "");
  else if (family === "sonnet5") rest = rest.replace(/^claude-sonnet-\d+(?:[.-]\d+)*/, "");
  else if (family === "sol") rest = rest.replace(/^gpt-\d+(?:\.\d+)*-sol/, "");
  else if (version.length) {
    rest = rest.replace(version.join("."), "").replace(version.join("-"), "");
  }
  return rest.split("-").filter(Boolean);
}

function parseEffort(tokens: string[]): Effort {
  const joined = tokens.join("-");
  for (const effort of EFFORTS) {
    if (tokens.includes(effort) || joined.includes(effort)) return effort;
  }
  return "high";
}

function formatVersion(version: number[]): string {
  return version.join(".");
}

function versionRank(version: number[]): number {
  return (version[0] ?? 0) * 1_000_000 + (version[1] ?? 0) * 1_000 + (version[2] ?? 0);
}

function effortIndex(effort: Effort): number {
  return EFFORTS.indexOf(effort);
}

function resolveSpec(
  spec: string,
  primary: ParsedModel,
  available: string[],
): string | undefined {
  const token = spec.trim();
  if (!token) return undefined;
  const kind = token.toLowerCase();
  if (kind === "latest") return pickLatestSameOptions(primary, available);
  if (kind === "sonnet" || kind === "sonnet-5" || kind === "claude-sonnet-5") {
    return pickFamilyMatch("sonnet5", primary, available) ?? defaultSonnet(primary);
  }
  if (kind === "sol" || kind === "gpt-sol" || kind === "gpt-5.6-sol") {
    return pickFamilyMatch("sol", primary, available) ?? defaultSol(primary);
  }
  if (kind === AUTO_MODEL) return AUTO_MODEL;
  if (!available.length) return token;
  if (available.includes(token)) return token;
  const parsed = parseModel(token);
  if (parsed.family !== "other" && parsed.family !== "auto") {
    return pickFamilyMatch(parsed.family, parsed, available);
  }
  return undefined;
}

function pickLatestSameOptions(
  primary: ParsedModel,
  available: string[],
): string | undefined {
  if (!available.length) return AUTO_MODEL;
  if (primary.family === "auto" || primary.family === "other") return AUTO_MODEL;
  const newer = available
    .map(parseModel)
    .filter(
      (m) =>
        m.family === primary.family &&
        versionRank(m.version) > versionRank(primary.version),
    );
  if (!newer.length) return undefined;
  const maxVer = Math.max(...newer.map((m) => versionRank(m.version)));
  const newest = newer.filter((m) => versionRank(m.version) === maxVer);
  return pickBestOptions(primary, newest)?.raw;
}

function pickFamilyMatch(
  family: ModelFamily,
  primary: ParsedModel,
  available: string[],
): string | undefined {
  if (family === "auto" || family === "other") return undefined;
  const candidates = available
    .map(parseModel)
    .filter((m) => m.family === family && m.raw !== primary.raw);
  if (!candidates.length) return undefined;
  const maxVer = Math.max(...candidates.map((m) => versionRank(m.version)));
  const newest = candidates.filter((m) => versionRank(m.version) === maxVer);
  return pickBestOptions(primary, newest)?.raw;
}

function pickBestOptions(primary: ParsedModel, candidates: ParsedModel[]): ParsedModel | undefined {
  if (!candidates.length) return undefined;
  const familyHasFast = candidates.some((m) => m.fast);
  const scored = candidates.map((cand) => ({
    cand,
    score: optionScore(primary, cand, familyHasFast),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.cand;
}

function optionScore(primary: ParsedModel, cand: ParsedModel, familyHasFast: boolean): number {
  let score = 0;
  if (cand.effort === primary.effort) score += 100;
  else score += Math.max(0, 40 - Math.abs(effortIndex(cand.effort) - effortIndex(primary.effort)) * 8);
  if (cand.fast === primary.fast) score += 40;
  else if (!familyHasFast) score += 28;
  if (cand.thinking === primary.thinking) score += 20;
  else if (!primary.thinking && cand.thinking) score += 30;
  return score;
}

function defaultSonnet(primary: ParsedModel): string {
  const effort = mapConstructedEffort(primary.effort);
  let id = `claude-sonnet-5-thinking-${effort}`;
  if (primary.fast) id += "-fast";
  return id;
}

function defaultSol(primary: ParsedModel): string {
  const effort = mapConstructedEffort(primary.effort);
  let id = `gpt-5.6-sol-${effort}`;
  if (primary.fast) id += "-fast";
  return id;
}

function mapConstructedEffort(effort: Effort): Effort {
  if (effort === "extra-high") return "xhigh";
  if (effort === "minimal" || effort === "none") return "medium";
  return effort;
}
