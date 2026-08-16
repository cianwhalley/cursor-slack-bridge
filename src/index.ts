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
  // Slack has no disabled-button attribute. Trash: drop that row immediately and keep
  // the rest. Send All: replace with Working… until the CLI finishes.
  // https://docs.slack.dev/reference/block-kit/block-elements/button-element
  const parentEmailActions = new Set(["parent_email_trash", "parent_email_send_all"]);

  function optimisticTrashBlocks(
    rawBlocks: unknown,
    trashId: string,
  ): { text: string; blocks: Record<string, unknown>[] } | null {
    if (!Array.isArray(rawBlocks) || !trashId) return null;
    type Block = Record<string, unknown>;
    const blocks = rawBlocks.map((b) => ({ ...(b as Block) })) as Block[];

    const isItemTrashRow = (b: Block): boolean => {
      const accessory = b.accessory as Record<string, unknown> | undefined;
      return (
        b.type === "section" &&
        !!accessory &&
        accessory.type === "button" &&
        accessory.action_id === "parent_email_trash"
      );
    };

    const remainingItems = blocks.filter(
      (b) => isItemTrashRow(b) && String((b.accessory as { value?: string }).value || "") !== trashId,
    );
    const header = blocks.find((b) => b.type === "section" && !b.accessory);
    const actions = blocks.find((b) => b.type === "actions");
    const context = blocks.find((b) => b.type === "context");

    const mentionMatch =
      typeof (header?.text as { text?: string } | undefined)?.text === "string"
        ? String((header?.text as { text: string }).text).match(/^<@[A-Z0-9]+>|@\S+/)
        : null;
    const mention = mentionMatch?.[0] || "<@cian>";

    if (remainingItems.length === 0) {
      const text = `${mention} Parent emails: all clear — none pending.`;
      return {
        text,
        blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
      };
    }

    const headerText = `${mention} Parent emails awaiting send (${remainingItems.length})`;
    const itemBlocks = remainingItems.map((b, i) => {
      const prev = String((b.text as { text?: string } | undefined)?.text || "");
      const withoutNum = prev.replace(/^\d+\.\s*/, "");
      const label = `${i + 1}. ${withoutNum}`;
      return {
        type: "section",
        text: { type: "mrkdwn", text: label },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Trash" },
          action_id: "parent_email_trash",
          value: String((b.accessory as { value?: string }).value || ""),
          style: "danger",
        },
      };
    });

    const out: Block[] = [
      { type: "section", text: { type: "mrkdwn", text: headerText } },
      ...itemBlocks,
    ];
    if (actions) {
      // Rebuild Send All without stale block_id
      out.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Send All" },
            action_id: "parent_email_send_all",
            value: "all",
            style: "primary",
            confirm: {
              title: { type: "plain_text", text: "Send all pending?" },
              text: {
                type: "mrkdwn",
                text:
                  "This sends the remaining Gmail drafts (and held SMS) now. " +
                  "You’ll see a Working… state until it finishes.",
              },
              confirm: { type: "plain_text", text: "Send All" },
              deny: { type: "plain_text", text: "Cancel" },
            },
          },
        ],
      });
    }
    if (context) {
      out.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Or reply: `send all` | `discard 2`",
          },
        ],
      });
    }
    const text =
      headerText +
      "\n" +
      itemBlocks.map((b) => String((b.text as { text: string }).text)).join("\n");
    return { text, blocks: out };
  }

  app.action(/.*/, async ({ ack, body, action, client }) => {
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
    const messageBlocks =
      body && typeof body === "object" && "message" in body
        ? (body as { message?: { blocks?: unknown } }).message?.blocks
        : undefined;

    if (channel && messageTs) {
      try {
        if (actionId === "parent_email_trash") {
          const optimistic = optimisticTrashBlocks(messageBlocks, value);
          if (optimistic) {
            await client.chat.update({
              channel,
              ts: messageTs,
              text: optimistic.text,
              blocks: optimistic.blocks as never,
            });
          }
        } else {
          const workingLabel =
            ":hourglass_flowing_sand: *Sending…* Gmail drafts + SMS — hang tight (do not click again).";
          await client.chat.update({
            channel,
            ts: messageTs,
            text: "Sending… hang tight (do not click again).",
            blocks: [
              {
                type: "section",
                text: { type: "mrkdwn", text: workingLabel },
              },
            ],
          });
        }
      } catch (err) {
        console.warn(`[parent-email] optimistic update failed: ${String(err)}`);
      }
    }

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
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("exit", (code) => {
      const snip = out.trim().slice(-800);
      console.log(`[parent-email] exit=${code}${snip ? ` :: ${snip}` : ""}`);
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
