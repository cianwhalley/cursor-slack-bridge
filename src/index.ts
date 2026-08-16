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
  // Slack has no disabled-button attribute. UX:
  //   Trash: drop that row; keep other Trash buttons; hide Send All until discards drain.
  //   Send All: only after trash idle; replace with Working… until CLI finishes.
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

    const mentionMatch =
      typeof (header?.text as { text?: string } | undefined)?.text === "string"
        ? String((header?.text as { text: string }).text).match(/^<@[A-Z0-9]+>|@\S+/)
        : null;
    const mention = mentionMatch?.[0] || "<@cian>";

    if (remainingItems.length === 0) {
      const text = `${mention} Discarding last item… Send All stays hidden until discards finish.`;
      return {
        text,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text } },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: "_Trashing…_ — Send All returns when discards finish (or nothing left).",
              },
            ],
          },
        ],
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

    // Never include Send All while a trash is in flight — reappears after idle refresh.
    const out: Block[] = [
      { type: "section", text: { type: "mrkdwn", text: headerText } },
      ...itemBlocks,
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "_Trashing…_ — keep Trashing rows if needed. Send All returns when discards finish.",
          },
        ],
      },
    ];
    const text =
      headerText +
      "\n" +
      itemBlocks.map((b) => String((b.text as { text: string }).text)).join("\n");
    return { text, blocks: out };
  }

  // Serialize approve CLIs. Trash skips Slack in the CLI; after trash drain we refresh
  // once from Drive (Send All comes back). Send All is rejected while trash pending.
  let parentEmailChain: Promise<void> = Promise.resolve();
  let parentEmailInFlight = 0;
  let parentEmailTrashPending = 0;
  let parentEmailLastChannel = "";
  let parentEmailLastTs = "";
  let parentEmailLastAction: "trash" | "send_all" = "trash";
  let parentEmailSlack: WebClient | null = null;

  const WORKING_BLOCKS = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":hourglass_flowing_sand: *Sending…* Gmail drafts + SMS — hang tight (do not click again).",
      },
    },
  ];

  async function applySendingState(channel: string, messageTs: string): Promise<void> {
    if (!parentEmailSlack || !channel || !messageTs) return;
    try {
      await parentEmailSlack.chat.update({
        channel,
        ts: messageTs,
        text: "Sending… hang tight (do not click again).",
        blocks: WORKING_BLOCKS as never,
      });
    } catch (err) {
      console.warn(`[parent-email] Working… update failed: ${String(err)}`);
    }
  }

  function runApproveCli(cliArgs: string[]): Promise<number> {
    const hub = config.workspace;
    const script = resolve(hub, "skills/orders-mvp-sync/scripts/run-parent-email-approve.sh");
    return new Promise((resolve) => {
      console.log(`[parent-email] spawn ${[script, ...cliArgs].join(" ")}`);
      const child = spawn("bash", [script, ...cliArgs], {
        cwd: hub,
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
        console.log(`[parent-email] exit=${code ?? 1}${snip ? ` :: ${snip}` : ""}`);
        resolve(code ?? 1);
      });
      child.on("error", (err) => {
        console.warn(`[parent-email] spawn error: ${String(err)}`);
        resolve(1);
      });
    });
  }

  function enqueueParentEmail(
    cliArgs: string[],
    channel: string,
    messageTs: string,
    kind: "trash" | "send_all",
  ): void {
    if (channel) parentEmailLastChannel = channel;
    if (messageTs) parentEmailLastTs = messageTs;
    parentEmailLastAction = kind;
    parentEmailInFlight += 1;
    if (kind === "trash") parentEmailTrashPending += 1;
    parentEmailChain = parentEmailChain
      .then(async () => {
        await runApproveCli(cliArgs);
      })
      .catch((err) => {
        console.warn(`[parent-email] chain error: ${String(err)}`);
      })
      .then(async () => {
        parentEmailInFlight -= 1;
        if (kind === "trash") parentEmailTrashPending = Math.max(0, parentEmailTrashPending - 1);
        if (parentEmailInFlight !== 0) return;
        // Send All CLI already published the final Slack state — do not refresh.
        if (kind === "send_all" || parentEmailLastAction === "send_all") return;
        const ch = parentEmailLastChannel;
        const ts = parentEmailLastTs;
        if (!ch || !ts) return;
        // Trash drain complete — restore list + Send All from Drive.
        await runApproveCli([
          "--action",
          "refresh",
          "--channel",
          ch,
          "--message-ts",
          ts,
        ]);
      });
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

    parentEmailSlack = client;

    const kind = actionId === "parent_email_trash" ? "trash" : "send_all";

    // Stale Send All (or confirm held open during trash) — refuse until discards drain.
    if (kind === "send_all" && parentEmailTrashPending > 0) {
      console.warn(
        `[parent-email] ignore send_all while trash_pending=${parentEmailTrashPending}`,
      );
      return;
    }

    if (channel && messageTs) {
      try {
        if (kind === "trash") {
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
          await applySendingState(channel, messageTs);
        }
      } catch (err) {
        console.warn(`[parent-email] optimistic update failed: ${String(err)}`);
      }
    }

    const cliArgs =
      kind === "trash"
        ? ["--action", "trash", "--id", value, "--skip-slack"]
        : ["--action", "send_all"];
    if (channel) cliArgs.push("--channel", channel);
    if (messageTs) cliArgs.push("--message-ts", messageTs);
    enqueueParentEmail(cliArgs, channel, messageTs, kind);
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
