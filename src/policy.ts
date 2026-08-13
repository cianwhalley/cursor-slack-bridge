import type { BridgeConfig } from "./config.js";

export type SlackEventLike = {
  type?: string;
  channel?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
  channel_type?: string;
};

export type EngageDecision =
  | {
      engage: true;
      channelId: string;
      userId: string;
      text: string;
      messageTs: string;
      threadTs: string;
      isDm: boolean;
      label: string;
    }
  | { engage: false; reason: string };

export interface ThreadParticipationStore {
  hasParticipated(channelId: string, threadTs: string): boolean;
  markParticipated(channelId: string, threadTs: string): void;
}

function isDmChannel(channelId: string, channelType?: string): boolean {
  if (channelType === "im") return true;
  return channelId.startsWith("D");
}

export function stripBotMention(text: string, botUserId: string | undefined): string {
  if (!botUserId) {
    return text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();
  }
  const re = new RegExp(`<@${botUserId}>\\s*`, "g");
  return text.replace(re, "").trim();
}

export function mentionedBot(text: string, botUserId: string | undefined): boolean {
  if (!botUserId) return /<@[A-Z0-9]+>/.test(text);
  return text.includes(`<@${botUserId}>`);
}

export function slackPromptPrefix(isDm: boolean, channelId: string): string {
  if (isDm) return "[slack dm]";
  return `[slack ${channelId}]`;
}

/**
 * Decide whether this Slack event should wake the Cursor agent.
 * Channel replies continue without re-mention only if we already participated in that thread.
 */
export function shouldEngage(
  event: SlackEventLike,
  config: BridgeConfig,
  participation: ThreadParticipationStore,
): EngageDecision {
  if (event.bot_id || event.subtype === "bot_message") {
    return { engage: false, reason: "bot_message" };
  }
  if (config.botUserId && event.user === config.botUserId) {
    return { engage: false, reason: "own_user" };
  }

  const channelId = event.channel?.trim() ?? "";
  const text = event.text?.trim() ?? "";
  const messageTs = event.ts?.trim() ?? "";
  const userId = event.user?.trim() ?? "";

  if (!channelId || !messageTs) {
    return { engage: false, reason: "missing_channel_or_ts" };
  }
  if (!text) {
    return { engage: false, reason: "empty_text" };
  }
  if (!userId) {
    return { engage: false, reason: "missing_user" };
  }

  const isDm = isDmChannel(channelId, event.channel_type);

  if (isDm) {
    if (config.dmPolicy === "disabled") {
      return { engage: false, reason: "dm_disabled" };
    }
    if (config.dmPolicy === "allowlist" && !config.allowedUserIds.has(userId)) {
      return { engage: false, reason: "dm_not_allowlisted" };
    }
    const cleaned = stripBotMention(text, config.botUserId);
    if (!cleaned) {
      return { engage: false, reason: "empty_text_after_mention_strip" };
    }
    return {
      engage: true,
      channelId,
      userId,
      text: cleaned,
      messageTs,
      threadTs: messageTs, // replies still use Slack thread_ts for posting; session key is "main"
      isDm: true,
      label: "slack:dm",
    };
  }

  // Channels / groups — allowlist applies to mentions and thread follow-ups.
  if (config.allowedUserIds.size > 0 && !config.allowedUserIds.has(userId)) {
    return { engage: false, reason: "user_not_allowlisted" };
  }

  const threadTs = (event.thread_ts || messageTs).trim();
  const isThreadReply = Boolean(event.thread_ts && event.thread_ts !== event.ts);
  const hasMention = mentionedBot(text, config.botUserId);
  const participated = participation.hasParticipated(channelId, threadTs);
  const inAlert = config.alertChannels.has(channelId);
  const inOpen = config.openChannels.has(channelId);

  // configured: only ALERT/OPEN channels. any: every channel the bot can see.
  if (!inAlert && !inOpen && config.channelPolicy !== "any") {
    return { engage: false, reason: "channel_not_configured" };
  }

  if (isThreadReply && participated) {
    const cleaned = stripBotMention(text, config.botUserId);
    if (!cleaned) {
      return { engage: false, reason: "empty_text_after_mention_strip" };
    }
    return {
      engage: true,
      channelId,
      userId,
      text: cleaned,
      messageTs,
      threadTs,
      isDm: false,
      label: `slack:${channelId}:${threadTs}`,
    };
  }

  // Root message or first engage in thread: require @mention
  if (!hasMention) {
    return { engage: false, reason: "mention_required" };
  }

  const cleaned = stripBotMention(text, config.botUserId);
  if (!cleaned) {
    return { engage: false, reason: "empty_text_after_mention_strip" };
  }

  return {
    engage: true,
    channelId,
    userId,
    text: cleaned,
    messageTs,
    threadTs, // for top-level mention, thread_ts === message.ts
    isDm: false,
    label: `slack:${channelId}:${threadTs}`,
  };
}

export function isBridgeCommand(text: string): "ping" | "stop" | "help" | null {
  const t = text.trim().toLowerCase();
  if (t === "ping") return "ping";
  if (t === "stop" || t === "exit") return "stop";
  if (t === "help" || t === "?") return "help";
  return null;
}

/** Slack mrkdwn — no Markdown headings. */
export function bridgeHelpText(opts: {
  workspace: string;
  dmPolicy: string;
  channelPolicy: string;
}): string {
  return [
    "*Cursor Slack bridge*",
    "This bot is the Slack face of a Cursor agent on a local workspace — not a Cloud Agent.",
    "",
    `Workspace: \`${opts.workspace}\``,
    `DM policy: \`${opts.dmPolicy}\` · Channel policy: \`${opts.channelPolicy}\``,
    "",
    "*Commands* (no Cursor run):",
    "• `ping` — liveness + workspace path",
    "• `stop` / `exit` — kill the active agent run in this DM/thread",
    "• `help` — this message",
    "",
    "*How to talk*",
    "• DM: send a message (if you are allowlisted)",
    "• Channel: `@mention` to start a thread; replies continue without mention",
    "• While a run is in progress, follow-ups queue — send `stop` to cancel",
  ].join("\n");
}
