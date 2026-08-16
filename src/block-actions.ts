/**
 * Config-driven Slack Block Kit actions → hub shell script (no agent wake).
 *
 * Typical pattern: per-row secondary buttons stay clickable; primary (“commit”)
 * is hidden until secondaries drain, then idle refresh restores it.
 */
import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type OptimisticStrategy = "drop_row_hide_primary" | "replace_working" | "none";

export interface BlockActionGroup {
  /** Log / queue label */
  id: string;
  /** Hub-relative or absolute path to bash script */
  script: string;
  /** Per-row discard / trash action_id */
  secondaryActionId: string;
  /** Commit / send-all action_id — gated while secondary jobs pending */
  primaryActionId: string;
  /** CLI args for secondary; supports {{value}} {{channel}} {{message_ts}} */
  secondaryArgs: string[];
  /** CLI args for primary */
  primaryArgs: string[];
  /** After secondary drain, run once (restore primary UI). Empty = skip. */
  idleRefreshArgs?: string[];
  optimisticSecondary?: OptimisticStrategy;
  optimisticPrimary?: OptimisticStrategy;
  /** Header while secondary busy: {{mention}} {{count}} */
  busyHeaderTemplate?: string;
  busyContext?: string;
  emptyBusyText?: string;
  /** Full-message Working… text (mrkdwn) */
  workingText?: string;
  rowButtonLabel?: string;
}

export interface BlockActionsConfig {
  groups: BlockActionGroup[];
}

type SlackBlock = Record<string, unknown>;

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

function fillArgs(args: string[], vars: Record<string, string>): string[] {
  return args.map((a) => fill(a, vars));
}

export function loadBlockActionsConfig(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
): BlockActionsConfig | null {
  const inline = env.BLOCK_ACTIONS_JSON?.trim();
  if (inline) {
    return parseBlockActionsConfig(JSON.parse(inline));
  }
  const pathRaw = env.BLOCK_ACTIONS_CONFIG?.trim();
  if (!pathRaw) return null;
  const path = isAbsolute(pathRaw) ? pathRaw : resolve(workspace, pathRaw);
  return parseBlockActionsConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function parseBlockActionsConfig(raw: unknown): BlockActionsConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("block-actions config must be an object");
  }
  const groups = (raw as { groups?: unknown }).groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error("block-actions config.groups must be a non-empty array");
  }
  const out: BlockActionGroup[] = [];
  for (const g of groups) {
    if (!g || typeof g !== "object") throw new Error("invalid group");
    const o = g as Record<string, unknown>;
    const id = String(o.id || "");
    const script = String(o.script || "");
    const secondaryActionId = String(o.secondaryActionId || "");
    const primaryActionId = String(o.primaryActionId || "");
    if (!id || !script || !secondaryActionId || !primaryActionId) {
      throw new Error(`group ${id || "?"} missing id/script/secondaryActionId/primaryActionId`);
    }
    if (!Array.isArray(o.secondaryArgs) || !Array.isArray(o.primaryArgs)) {
      throw new Error(`group ${id} secondaryArgs/primaryArgs must be arrays`);
    }
    out.push({
      id,
      script,
      secondaryActionId,
      primaryActionId,
      secondaryArgs: o.secondaryArgs.map(String),
      primaryArgs: o.primaryArgs.map(String),
      idleRefreshArgs: Array.isArray(o.idleRefreshArgs)
        ? o.idleRefreshArgs.map(String)
        : undefined,
      optimisticSecondary: (o.optimisticSecondary as OptimisticStrategy) || "drop_row_hide_primary",
      optimisticPrimary: (o.optimisticPrimary as OptimisticStrategy) || "replace_working",
      busyHeaderTemplate: o.busyHeaderTemplate ? String(o.busyHeaderTemplate) : undefined,
      busyContext: o.busyContext ? String(o.busyContext) : undefined,
      emptyBusyText: o.emptyBusyText ? String(o.emptyBusyText) : undefined,
      workingText: o.workingText ? String(o.workingText) : undefined,
      rowButtonLabel: o.rowButtonLabel ? String(o.rowButtonLabel) : undefined,
    });
  }
  return { groups: out };
}

/** Exported for unit tests */
export function dropRowHidePrimary(
  rawBlocks: unknown,
  opts: {
    rowActionId: string;
    removeValue: string;
    busyHeaderTemplate: string;
    busyContext: string;
    emptyBusyText: string;
    rowButtonLabel: string;
  },
): { text: string; blocks: SlackBlock[] } | null {
  if (!Array.isArray(rawBlocks) || !opts.removeValue) return null;
  const blocks = rawBlocks.map((b) => ({ ...(b as SlackBlock) })) as SlackBlock[];

  const isRow = (b: SlackBlock): boolean => {
    const accessory = b.accessory as Record<string, unknown> | undefined;
    return (
      b.type === "section" &&
      !!accessory &&
      accessory.type === "button" &&
      accessory.action_id === opts.rowActionId
    );
  };

  const remaining = blocks.filter(
    (b) => isRow(b) && String((b.accessory as { value?: string }).value || "") !== opts.removeValue,
  );
  const header = blocks.find((b) => b.type === "section" && !b.accessory);
  const mentionMatch =
    typeof (header?.text as { text?: string } | undefined)?.text === "string"
      ? String((header?.text as { text: string }).text).match(/^<@[A-Z0-9]+>|@\S+/)
      : null;
  const mention = mentionMatch?.[0] || "";
  const vars = { mention, count: String(remaining.length) };

  if (remaining.length === 0) {
    const text = fill(opts.emptyBusyText, vars);
    return {
      text,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text } },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: opts.busyContext }],
        },
      ],
    };
  }

  const headerText = fill(opts.busyHeaderTemplate, vars);
  const itemBlocks = remaining.map((b, i) => {
    const prev = String((b.text as { text?: string } | undefined)?.text || "");
    const withoutNum = prev.replace(/^\d+\.\s*/, "");
    return {
      type: "section",
      text: { type: "mrkdwn", text: `${i + 1}. ${withoutNum}` },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: opts.rowButtonLabel },
        action_id: opts.rowActionId,
        value: String((b.accessory as { value?: string }).value || ""),
        style: "danger",
      },
    };
  });

  const out: SlackBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: headerText } },
    ...itemBlocks,
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: opts.busyContext }],
    },
  ];
  return {
    text: headerText + "\n" + itemBlocks.map((b) => String(b.text.text)).join("\n"),
    blocks: out,
  };
}

function workingBlocks(text: string): SlackBlock[] {
  return [{ type: "section", text: { type: "mrkdwn", text } }];
}

export interface InstallBlockActionsOpts {
  app: App;
  web: WebClient;
  workspace: string;
  allowedUserIds: Set<string>;
  config: BlockActionsConfig;
  /** Localhost POST /block-actions-test when true */
  testHook?: boolean;
}

export function installBlockActions(opts: InstallBlockActionsOpts): {
  actionIds: Set<string>;
  handle: (input: {
    actionId: string;
    value: string;
    channel: string;
    messageTs: string;
    messageBlocks: unknown;
    client: WebClient;
    userId?: string;
  }) => Promise<{ ok: boolean; ignored?: string }>;
} {
  const { app, web, workspace, allowedUserIds, config } = opts;
  const byAction = new Map<string, { group: BlockActionGroup; role: "secondary" | "primary" }>();
  for (const group of config.groups) {
    byAction.set(group.secondaryActionId, { group, role: "secondary" });
    byAction.set(group.primaryActionId, { group, role: "primary" });
  }
  const actionIds = new Set(byAction.keys());

  type QueueState = {
    chain: Promise<void>;
    inFlight: number;
    secondaryPending: number;
    lastChannel: string;
    lastTs: string;
    lastRole: "secondary" | "primary";
    client: WebClient | null;
  };
  const queues = new Map<string, QueueState>();

  function queueFor(groupId: string): QueueState {
    let q = queues.get(groupId);
    if (!q) {
      q = {
        chain: Promise.resolve(),
        inFlight: 0,
        secondaryPending: 0,
        lastChannel: "",
        lastTs: "",
        lastRole: "secondary",
        client: null,
      };
      queues.set(groupId, q);
    }
    return q;
  }

  function runScript(group: BlockActionGroup, args: string[]): Promise<number> {
    const script = isAbsolute(group.script) ? group.script : resolve(workspace, group.script);
    return new Promise((resolvePromise) => {
      console.log(`[block-actions:${group.id}] spawn ${[script, ...args].join(" ")}`);
      const child = spawn("bash", [script, ...args], {
        cwd: workspace,
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
        console.log(
          `[block-actions:${group.id}] exit=${code ?? 1}${snip ? ` :: ${snip}` : ""}`,
        );
        resolvePromise(code ?? 1);
      });
      child.on("error", (err) => {
        console.warn(`[block-actions:${group.id}] spawn error: ${String(err)}`);
        resolvePromise(1);
      });
    });
  }

  function enqueue(
    group: BlockActionGroup,
    role: "secondary" | "primary",
    args: string[],
    channel: string,
    messageTs: string,
    client: WebClient,
  ): void {
    const q = queueFor(group.id);
    if (channel) q.lastChannel = channel;
    if (messageTs) q.lastTs = messageTs;
    q.lastRole = role;
    q.client = client;
    q.inFlight += 1;
    if (role === "secondary") q.secondaryPending += 1;

    q.chain = q.chain
      .then(async () => {
        await runScript(group, args);
      })
      .catch((err) => {
        console.warn(`[block-actions:${group.id}] chain error: ${String(err)}`);
      })
      .then(async () => {
        q.inFlight -= 1;
        if (role === "secondary") q.secondaryPending = Math.max(0, q.secondaryPending - 1);
        if (q.inFlight !== 0) return;
        if (role === "primary" || q.lastRole === "primary") return;
        const refresh = group.idleRefreshArgs;
        if (!refresh?.length) return;
        const ch = q.lastChannel;
        const ts = q.lastTs;
        if (!ch || !ts) return;
        const refreshArgs = fillArgs(refresh, { channel: ch, message_ts: ts, value: "" });
        if (!refreshArgs.includes("--channel")) refreshArgs.push("--channel", ch);
        if (!refreshArgs.includes("--message-ts")) refreshArgs.push("--message-ts", ts);
        await runScript(group, refreshArgs);
      });
  }

  async function applyOptimistic(
    group: BlockActionGroup,
    role: "secondary" | "primary",
    value: string,
    channel: string,
    messageTs: string,
    messageBlocks: unknown,
    client: WebClient,
  ): Promise<void> {
    const strategy =
      role === "secondary"
        ? group.optimisticSecondary || "drop_row_hide_primary"
        : group.optimisticPrimary || "replace_working";
    if (strategy === "none" || !channel || !messageTs) return;

    if (strategy === "replace_working") {
      const text =
        group.workingText ||
        ":hourglass_flowing_sand: *Working…* — hang tight (do not click again).";
      await client.chat.update({
        channel,
        ts: messageTs,
        text: "Working… hang tight (do not click again).",
        blocks: workingBlocks(text) as never,
      });
      return;
    }

    if (strategy === "drop_row_hide_primary") {
      const optimistic = dropRowHidePrimary(messageBlocks, {
        rowActionId: group.secondaryActionId,
        removeValue: value,
        busyHeaderTemplate:
          group.busyHeaderTemplate || "{{mention}} Awaiting confirm ({{count}})",
        busyContext:
          group.busyContext ||
          "_Working…_ — secondary actions still available. Primary returns when idle.",
        emptyBusyText:
          group.emptyBusyText ||
          "{{mention}} Discarding last item… primary stays hidden until idle.",
        rowButtonLabel: group.rowButtonLabel || "Trash",
      });
      if (!optimistic) return;
      await client.chat.update({
        channel,
        ts: messageTs,
        text: optimistic.text,
        blocks: optimistic.blocks as never,
      });
    }
  }

  async function handle(input: {
    actionId: string;
    value: string;
    channel: string;
    messageTs: string;
    messageBlocks: unknown;
    client: WebClient;
    userId?: string;
  }): Promise<{ ok: boolean; ignored?: string }> {
    const hit = byAction.get(input.actionId);
    if (!hit) return { ok: false, ignored: "unknown_action" };

    if (
      allowedUserIds.size > 0 &&
      input.userId &&
      !allowedUserIds.has(input.userId)
    ) {
      console.warn(
        `[block-actions:${hit.group.id}] ignore action from non-allowlisted user=${input.userId}`,
      );
      return { ok: false, ignored: "allowlist" };
    }

    const q = queueFor(hit.group.id);
    if (hit.role === "primary" && q.secondaryPending > 0) {
      console.warn(
        `[block-actions:${hit.group.id}] ignore primary while secondary_pending=${q.secondaryPending}`,
      );
      return { ok: false, ignored: "secondary_pending" };
    }

    const vars = {
      value: input.value,
      channel: input.channel,
      message_ts: input.messageTs,
    };
    const args = fillArgs(
      hit.role === "secondary" ? hit.group.secondaryArgs : hit.group.primaryArgs,
      vars,
    );
    if (input.channel && !args.includes("--channel")) {
      args.push("--channel", input.channel);
    }
    if (input.messageTs && !args.includes("--message-ts")) {
      args.push("--message-ts", input.messageTs);
    }

    try {
      await applyOptimistic(
        hit.group,
        hit.role,
        input.value,
        input.channel,
        input.messageTs,
        input.messageBlocks,
        input.client,
      );
    } catch (err) {
      console.warn(`[block-actions:${hit.group.id}] optimistic update failed: ${String(err)}`);
    }

    enqueue(hit.group, hit.role, args, input.channel, input.messageTs, input.client);
    return { ok: true };
  }

  app.action(/.*/, async ({ ack, body, action, client }) => {
    await ack();
    const actionId =
      action && typeof action === "object" && "action_id" in action
        ? String((action as { action_id?: string }).action_id || "")
        : "";
    if (!actionIds.has(actionId)) return;

    const userId =
      body && typeof body === "object" && "user" in body
        ? String((body as { user?: { id?: string } }).user?.id || "")
        : "";
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

    await handle({
      actionId,
      value,
      channel,
      messageTs,
      messageBlocks,
      client,
      userId,
    });
  });

  if (opts.testHook) {
    const hook = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/block-actions-test") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        void (async () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              action_id?: string;
              value?: string;
              channel?: string;
              message_ts?: string;
              blocks?: unknown;
              user_id?: string;
            };
            const result = await handle({
              actionId: String(payload.action_id || ""),
              value: String(payload.value || ""),
              channel: String(payload.channel || ""),
              messageTs: String(payload.message_ts || ""),
              messageBlocks: payload.blocks,
              client: web,
              userId: payload.user_id,
            });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
          }
        })();
      });
    });
    hook.listen(8791, "127.0.0.1", () => {
      console.log("[boot] block-actions test hook on 127.0.0.1:8791");
    });
  }

  return { actionIds, handle };
}
