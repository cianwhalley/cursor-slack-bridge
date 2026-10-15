import { config as loadDotenv } from "dotenv";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DEFAULT_FALLBACK_SPECS } from "./model-fallback.js";
import { defaultMemoryDir } from "./memory-context.js";

const SLACK_ID_RE = /^[UCDG][A-Z0-9]+$/;

export type DmPolicy = "allowlist" | "open" | "disabled";
export type ChannelPolicy = "configured" | "any";

export type AgentHarnessName = "cursor" | "opencode";

export interface BridgeConfig {
  slackBotToken: string;
  slackAppToken: string;
  /** Which CLI owns the chat. Default `cursor` so existing instances stay unchanged. */
  harness: AgentHarnessName;
  cursorApiKey: string | undefined;
  agentBin: string;
  workspace: string;
  /** Auto-memory directory. Default `$HOME/.ethan/memory`. */
  memoryDir: string;
  /** Optional Cursor model id (e.g. grok-4.7-high-fast). Passed as agent --model. */
  agentModel: string | undefined;
  /**
   * Retry hops when the pinned model is retired, rate-limited, or degraded.
   * Default: latest (same options) → Sonnet 5 → GPT Sol. Empty = off.
   */
  agentModelFallbacks: string[];
  sessionDb: string;
  dmPolicy: DmPolicy;
  allowedUserIds: Set<string>;
  /** configured = ALERT/OPEN channels only; any = every channel the bot is in (still allowlisted). */
  channelPolicy: ChannelPolicy;
  alertChannels: Set<string>;
  /** Channels where any human message engages (empty = none; alert channels still require mention to start). */
  openChannels: Set<string>;
  typingReaction: string;
  textChunkLimit: number;
  /** OpenClaw-style: off | progress (one editable draft). */
  streamingMode: "off" | "progress";
  /** Seconds before creating the progress draft (OpenClaw ~1.5). */
  draftDelaySeconds: number;
  /** Refresh assistant.threads.setStatus while running (default 90). */
  statusKeepaliveSeconds: number;
  maxProgressLines: number;
  maxLineChars: number;
  progressLabel: string;
  /** OpenClaw agents.defaults.toolProgressDetail */
  toolProgressDetail: "explain" | "raw";
  /** OpenClaw streaming.progress.commandText */
  progressCommandText: "raw" | "status";
  /** OpenClaw streaming.progress.commentary (default false). */
  progressCommentary: boolean;
  sessionTimeoutSeconds: number;
  botUserId: string | undefined;
  /** When set, approval trailers and button clicks must use this Slack user id. */
  approverUserId?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseIdList(raw: string | undefined, field: string): Set<string> {
  if (!raw?.trim()) {
    return new Set();
  }
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (!SLACK_ID_RE.test(id)) {
      throw new Error(
        `${field}: invalid Slack ID ${JSON.stringify(id)} — use canonical IDs only (e.g. U0123456789, C0123456789)`,
      );
    }
  }
  return new Set(ids);
}

function parseDmPolicy(raw: string | undefined): DmPolicy {
  const value = (raw ?? "allowlist").trim().toLowerCase();
  if (value === "allowlist" || value === "open" || value === "disabled") {
    return value;
  }
  throw new Error(`DM_POLICY must be allowlist|open|disabled, got ${JSON.stringify(raw)}`);
}

function parseChannelPolicy(raw: string | undefined): ChannelPolicy {
  const value = (raw ?? "configured").trim().toLowerCase();
  if (value === "configured" || value === "any") {
    return value;
  }
  throw new Error(`CHANNEL_POLICY must be configured|any, got ${JSON.stringify(raw)}`);
}

/** Comma list of hops (`latest,sonnet,sol`). `off` disables. Unset → default chain. */
export function parseModelFallbacks(raw: string | undefined): string[] {
  if (raw === undefined) return [...DEFAULT_FALLBACK_SPECS];
  const value = raw.trim();
  if (!value) return [...DEFAULT_FALLBACK_SPECS];
  if (/^(off|none|false|disabled)$/i.test(value)) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(envPath?: string): BridgeConfig {
  if (envPath) {
    loadDotenv({ path: envPath });
  } else if (process.env.DOTENV_CONFIG_PATH) {
    loadDotenv({ path: process.env.DOTENV_CONFIG_PATH });
  } else {
    loadDotenv();
  }

  const harness = parseHarness(process.env.HARNESS);
  const dmPolicy = parseDmPolicy(process.env.DM_POLICY);
  const channelPolicy = parseChannelPolicy(process.env.CHANNEL_POLICY);
  const allowedUserIds = parseIdList(process.env.ALLOWED_USER_IDS, "ALLOWED_USER_IDS");
  if (dmPolicy === "allowlist" && allowedUserIds.size === 0) {
    throw new Error("DM_POLICY=allowlist requires ALLOWED_USER_IDS");
  }
  if (channelPolicy === "any" && allowedUserIds.size === 0) {
    throw new Error("CHANNEL_POLICY=any requires ALLOWED_USER_IDS");
  }

  return {
    slackBotToken: requireEnv("SLACK_BOT_TOKEN"),
    slackAppToken: requireEnv("SLACK_APP_TOKEN"),
    harness,
    cursorApiKey: process.env.CURSOR_API_KEY?.trim() || undefined,
    agentBin: process.env.AGENT_BIN?.trim() || (harness === "opencode" ? "opencode" : "agent"),
    workspace: resolve(requireEnv("WORKSPACE")),
    memoryDir: resolve(process.env.ETHAN_MEMORY_DIR?.trim() || defaultMemoryDir(homedir())),
    agentModel: process.env.AGENT_MODEL?.trim() || undefined,
    agentModelFallbacks:
      harness === "opencode" && process.env.AGENT_MODEL_FALLBACK === undefined
        ? []
        : parseModelFallbacks(process.env.AGENT_MODEL_FALLBACK),
    sessionDb: resolve(process.env.SESSION_DB?.trim() || "./cursor-slack.db"),
    dmPolicy,
    allowedUserIds,
    channelPolicy,
    alertChannels: parseIdList(process.env.ALERT_CHANNELS, "ALERT_CHANNELS"),
    openChannels: parseIdList(process.env.OPEN_CHANNELS, "OPEN_CHANNELS"),
    typingReaction: process.env.TYPING_REACTION?.trim() || "hourglass_flowing_sand",
    textChunkLimit: Number(process.env.TEXT_CHUNK_LIMIT ?? "3500"),
    streamingMode: parseStreamingMode(process.env.STREAMING_MODE),
    draftDelaySeconds: Number(process.env.DRAFT_DELAY_SECONDS ?? "0"),
    statusKeepaliveSeconds: Number(process.env.STATUS_KEEPALIVE_SECONDS ?? "90"),
    maxProgressLines: Number(process.env.MAX_PROGRESS_LINES ?? "8"),
    maxLineChars: Number(process.env.MAX_LINE_CHARS ?? "120"),
    progressLabel: process.env.PROGRESS_LABEL?.trim() || "Working",
    toolProgressDetail: parseEnum(process.env.TOOL_PROGRESS_DETAIL, ["explain", "raw"], "explain"),
    progressCommandText: parseEnum(process.env.PROGRESS_COMMAND_TEXT, ["raw", "status"], "raw"),
    progressCommentary: parseBool(process.env.PROGRESS_COMMENTARY, false),
    sessionTimeoutSeconds: Number(process.env.SESSION_TIMEOUT_SECONDS ?? "900"),
    botUserId: process.env.BOT_USER_ID?.trim() || undefined,
    approverUserId: parseOptionalSlackUserId(process.env.APPROVER_USER_ID, "APPROVER_USER_ID"),
  };
}

function parseOptionalSlackUserId(raw: string | undefined, field: string): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!SLACK_ID_RE.test(value) || !value.startsWith("U")) {
    throw new Error(`${field}: invalid Slack user ID ${JSON.stringify(value)}`);
  }
  return value;
}

function parseHarness(raw: string | undefined): AgentHarnessName {
  const value = (raw ?? "cursor").trim().toLowerCase();
  if (value === "cursor" || value === "opencode") return value;
  throw new Error(`HARNESS must be cursor|opencode, got ${JSON.stringify(raw)}`);
}

function parseStreamingMode(raw: string | undefined): "off" | "progress" {
  const value = (raw ?? "progress").trim().toLowerCase();
  if (value === "off" || value === "progress") return value;
  throw new Error(`STREAMING_MODE must be off|progress, got ${JSON.stringify(raw)}`);
}

function parseEnum<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T): T {
  if (!raw?.trim()) return fallback;
  const value = raw.trim().toLowerCase() as T;
  if ((allowed as readonly string[]).includes(value)) return value;
  throw new Error(`expected ${allowed.join("|")}, got ${JSON.stringify(raw)}`);
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  throw new Error(`expected boolean, got ${JSON.stringify(raw)}`);
}

/** Exported for tests */
export const _testing = {
  parseIdList,
  parseDmPolicy,
  parseChannelPolicy,
  parseModelFallbacks,
  SLACK_ID_RE,
};
