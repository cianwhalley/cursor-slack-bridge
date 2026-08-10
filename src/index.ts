import { App } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
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
        await web.chat.postMessage({
          channel,
          text,
          thread_ts: threadTs,
          mrkdwn: true,
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

  app.event("app_mention", async ({ event }) => {
    router.handleEvent(event as SlackEventLikeCompat);
  });

  // Interactivity stub — ack only (buttons later)
  app.action(/.*/, async ({ ack }) => {
    await ack();
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
