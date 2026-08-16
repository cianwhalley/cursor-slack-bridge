import { App } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { CursorAgentRunner } from "./agent-runner.js";
import { loadConfig } from "./config.js";
import { MessageRouter } from "./router.js";
import { SessionStore } from "./sessions.js";

async function main(): Promise<void> {
  const envFile = process.env.CURSOR_SLACK_ENV || process.env.DOTENV_CONFIG_PATH;
  const config = loadConfig(envFile);

  const web = new WebClient(config.slackBotToken);
  const auth = await web.auth.test();
  if (!auth.ok || !auth.user_id) {
    throw new Error(`auth.test failed: ${JSON.stringify(auth)}`);
  }
  const botUserId = config.botUserId ?? String(auth.user_id);
  console.log(`[boot] bot_user_id=${botUserId} workspace=${config.workspace}`);

  const sessions = new SessionStore(config.sessionDb);
  const runner = new CursorAgentRunner();

  const slack = {
    authBotUserId: botUserId,
    reactions: {
      async add(channel: string, timestamp: string, name: string) {
        await web.reactions.add({ channel, timestamp, name });
      },
      async remove(channel: string, timestamp: string, name: string) {
        await web.reactions.remove({ channel, timestamp, name });
      },
    },
    poster: {
      async post(channel: string, text: string, threadTs?: string) {
        const res = await web.chat.postMessage({
          channel,
          text,
          thread_ts: threadTs,
          mrkdwn: true,
        });
        return typeof res.ts === "string" ? res.ts : undefined;
      },
      async update(channel: string, ts: string, text: string) {
        await web.chat.update({ channel, ts, text });
      },
      async delete(channel: string, ts: string) {
        await web.chat.delete({ channel, ts });
      },
    },
    assistantStatus: {
      async setStatus(channel: string, threadTs: string, status: string) {
        await web.assistant.threads.setStatus({
          channel_id: channel,
          thread_ts: threadTs,
          status,
        });
      },
    },
  };

  const router = new MessageRouter({
    config: { ...config, botUserId },
    sessions,
    runner,
    slack,
    queueSameThread: true,
  });

  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  app.event("message", async ({ event }) => {
    // Ignore message subtypes we don't handle (edits, joins, etc.) except file_share with text
    const ev = event as {
      subtype?: string;
      bot_id?: string;
      channel?: string;
      user?: string;
      text?: string;
      ts?: string;
      thread_ts?: string;
      channel_type?: string;
    };
    if (ev.subtype && ev.subtype !== "file_share") {
      return;
    }
    // Return immediately — Bolt acks the Socket Mode envelope; work is async.
    router.handleEvent(ev);
  });

  // Also subscribe to app_mention — Slack often emits BOTH for a channel @mention.
  // MessageRouter dedupes by channel:ts so we do not double-queue / fake "Still working…".
  app.event("app_mention", async ({ event }) => {
    router.handleEvent(event as SlackEventLikeCompat);
  });

  // Parent-email approve buttons (orders-mvp) — ack fast, spawn CLI (no agent wake).
  const parentEmailActions = new Set(["parent_email_trash", "parent_email_send_all"]);
  app.action(/.*/, async ({ ack, body, action }) => {
    await ack();
    const actionId =
      action && typeof action === "object" && "action_id" in action
        ? String((action as { action_id?: string }).action_id || "")
        : "";
    if (!parentEmailActions.has(actionId)) {
      return;
    }
    const userId =
      body && typeof body === "object" && "user" in body
        ? String((body as { user?: { id?: string } }).user?.id || "")
        : "";
    if (config.allowedUserIds.size > 0 && userId && !config.allowedUserIds.has(userId)) {
      console.warn(`[parent-email] ignore action from non-allowlisted user=${userId}`);
      return;
    }
    const value =
      action && typeof action === "object" && "value" in action
        ? String((action as { value?: string }).value || "")
        : "";
    const channel =
      body && typeof body === "object" && "channel" in body
        ? String((body as { channel?: { id?: string } }).channel?.id || "")
        : "";
    const messageTs =
      body && typeof body === "object" && "message" in body
        ? String((body as { message?: { ts?: string } }).message?.ts || "")
        : "";
    const hub = config.workspace;
    const script = resolve(hub, "skills/orders-mvp-sync/scripts/run-parent-email-approve.sh");
    const args = [script, "--action", actionId === "parent_email_trash" ? "trash" : "send_all"];
    if (actionId === "parent_email_trash" && value) {
      args.push("--id", value);
    }
    if (channel) args.push("--channel", channel);
    if (messageTs) args.push("--message-ts", messageTs);
    console.log(`[parent-email] spawn ${args.join(" ")}`);
    const child = spawn("bash", args, {
      cwd: hub,
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  });

  const shutdown = async () => {
    console.log("[boot] shutting down");
    sessions.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.start();
  console.log("[boot] cursor-slack-bridge Socket Mode listening");
}

type SlackEventLikeCompat = {
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
