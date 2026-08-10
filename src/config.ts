import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

const SLACK_ID_RE = /^[UCDG][A-Z0-9]+$/;

export type DmPolicy = "allowlist" | "open" | "disabled";

export interface BridgeConfig {
  slackBotToken: string;
  slackAppToken: string;
  cursorApiKey: string | undefined;
  agentBin: string;
  workspace: string;
  sessionDb: string;
  dmPolicy: DmPolicy;
  allowedUserIds: Set<string>;
  alertChannels: Set<string>;
  /** Channels where any human message engages (empty = none; alert channels still require mention to start). */
  openChannels: Set<string>;
  typingReaction: string;
  textChunkLimit: number;
  keepaliveSeconds: number;
  keepaliveThresholdSeconds: number;
  sessionTimeoutSeconds: number;
  botUserId: string | undefined;
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

export function loadConfig(envPath?: string): BridgeConfig {
  if (envPath) {
    loadDotenv({ path: envPath });
  } else if (process.env.DOTENV_CONFIG_PATH) {
    loadDotenv({ path: process.env.DOTENV_CONFIG_PATH });
  } else {
    loadDotenv();
  }

  const dmPolicy = parseDmPolicy(process.env.DM_POLICY);
  const allowedUserIds = parseIdList(process.env.ALLOWED_USER_IDS, "ALLOWED_USER_IDS");
  if (dmPolicy === "allowlist" && allowedUserIds.size === 0) {
    throw new Error("DM_POLICY=allowlist requires ALLOWED_USER_IDS");
  }

  return {
    slackBotToken: requireEnv("SLACK_BOT_TOKEN"),
    slackAppToken: requireEnv("SLACK_APP_TOKEN"),
    cursorApiKey: process.env.CURSOR_API_KEY?.trim() || undefined,
    agentBin: process.env.AGENT_BIN?.trim() || "agent",
    workspace: resolve(requireEnv("WORKSPACE")),
    sessionDb: resolve(process.env.SESSION_DB?.trim() || "./cursor-slack.db"),
    dmPolicy,
    allowedUserIds,
    alertChannels: parseIdList(process.env.ALERT_CHANNELS, "ALERT_CHANNELS"),
    openChannels: parseIdList(process.env.OPEN_CHANNELS, "OPEN_CHANNELS"),
    typingReaction: process.env.TYPING_REACTION?.trim() || "hourglass_flowing_sand",
    textChunkLimit: Number(process.env.TEXT_CHUNK_LIMIT ?? "3500"),
    keepaliveSeconds: Number(process.env.KEEPALIVE_SECONDS ?? "45"),
    keepaliveThresholdSeconds: Number(process.env.KEEPALIVE_THRESHOLD_SECONDS ?? "30"),
    sessionTimeoutSeconds: Number(process.env.SESSION_TIMEOUT_SECONDS ?? "900"),
    botUserId: process.env.BOT_USER_ID?.trim() || undefined,
  };
}

/** Exported for tests */
export const _testing = { parseIdList, parseDmPolicy, SLACK_ID_RE };
