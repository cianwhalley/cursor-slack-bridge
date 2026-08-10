import type { BridgeConfig } from "./config.js";
import type { AgentRunner } from "./agent-runner.js";
import { buildPrompt, chunkText } from "./format.js";
import {
  isBridgeCommand,
  shouldEngage,
  slackPromptPrefix,
  type SlackEventLike,
} from "./policy.js";
import { ProgressTracker, type SlackPoster, type SlackReactions } from "./progress.js";
import type { SessionStore } from "./sessions.js";

export interface SlackClient {
  reactions: SlackReactions;
  poster: SlackPoster;
  authBotUserId?: string;
}

export interface RouterDeps {
  config: BridgeConfig;
  sessions: SessionStore;
  runner: AgentRunner;
  slack: SlackClient;
  /** Queue concurrent messages for the same session key. */
  queueSameThread?: boolean;
}

type QueueItem = () => Promise<void>;

export class MessageRouter {
  private readonly queues = new Map<string, QueueItem[]>();
  private readonly running = new Set<string>();
  private readonly activeRunKeys = new Map<string, string>(); // sessionKey -> runner stop key

  constructor(private readonly deps: RouterDeps) {}

  /** Fire-and-forget handler suitable for Bolt (ack already done). */
  handleEvent(event: SlackEventLike): void {
    void this.process(event).catch((err) => {
      console.error("[router] unhandled", err);
    });
  }

  async process(event: SlackEventLike): Promise<void> {
    const { config, sessions, runner, slack } = this.deps;
    const botUserId = config.botUserId ?? slack.authBotUserId;
    const cfg: BridgeConfig = { ...config, botUserId };

    const decision = shouldEngage(event, cfg, sessions);
    if (!decision.engage) {
      return;
    }

    const cmd = isBridgeCommand(decision.text);
    const replyThreadTs = decision.isDm
      ? event.thread_ts || undefined // DM: top-level unless already in a thread UI
      : decision.threadTs;

    if (cmd === "ping") {
      await slack.poster.post(
        decision.channelId,
        `Pong! Bridge alive.\nWorkspace: \`${cfg.workspace}\``,
        replyThreadTs,
      );
      return;
    }

    const { channelId, threadKey } = sessions.sessionKey(
      decision.isDm,
      decision.channelId,
      decision.threadTs,
    );
    const sessionKey = `${channelId}:${threadKey}`;

    if (cmd === "stop") {
      const stopKey = this.activeRunKeys.get(sessionKey) ?? threadKey;
      const stopped = runner.stop(stopKey) || runner.stop(threadKey);
      await slack.poster.post(
        decision.channelId,
        stopped ? "Stopped the active agent run." : "No active agent session to stop.",
        replyThreadTs,
      );
      return;
    }

    const task = () => this.runAgentTurn(decision, replyThreadTs, sessionKey, channelId, threadKey);
    if (this.deps.queueSameThread === false) {
      await task();
      return;
    }
    await this.enqueue(sessionKey, task);
  }

  private async enqueue(sessionKey: string, task: QueueItem): Promise<void> {
    const q = this.queues.get(sessionKey) ?? [];
    q.push(task);
    this.queues.set(sessionKey, q);
    if (this.running.has(sessionKey)) return;
    this.running.add(sessionKey);
    try {
      while (true) {
        const next = this.queues.get(sessionKey)?.shift();
        if (!next) break;
        await next();
      }
    } finally {
      this.running.delete(sessionKey);
      if ((this.queues.get(sessionKey)?.length ?? 0) === 0) {
        this.queues.delete(sessionKey);
      }
    }
  }

  private async runAgentTurn(
    decision: Extract<ReturnType<typeof shouldEngage>, { engage: true }>,
    replyThreadTs: string | undefined,
    sessionKey: string,
    channelId: string,
    threadKey: string,
  ): Promise<void> {
    const { config, sessions, runner, slack } = this.deps;
    const progress = new ProgressTracker(
      slack.reactions,
      slack.poster,
      decision.channelId,
      decision.messageTs,
      replyThreadTs,
      config.typingReaction,
      config.keepaliveThresholdSeconds,
      config.keepaliveSeconds,
    );
    await progress.start();

    try {
      let session = sessions.get(channelId, threadKey);
      let chatId = session?.cursorChatId;
      const isNew = !chatId;

      if (!chatId) {
        chatId = await runner.createChat(config.agentBin, config.workspace, config.cursorApiKey);
        sessions.upsert(channelId, threadKey, chatId, decision.label);
      } else {
        sessions.touch(channelId, threadKey);
      }

      if (!decision.isDm) {
        sessions.markParticipated(decision.channelId, decision.threadTs);
      }

      const prefix = slackPromptPrefix(decision.isDm, decision.channelId);
      const prompt = buildPrompt(prefix, decision.text);

      this.activeRunKeys.set(sessionKey, chatId);
      const result = await runner.runPrompt({
        agentBin: config.agentBin,
        workspace: config.workspace,
        chatId,
        prompt,
        cursorApiKey: config.cursorApiKey,
        timeoutSeconds: config.sessionTimeoutSeconds,
      });
      this.activeRunKeys.delete(sessionKey);

      if (result.chatId && result.chatId !== chatId) {
        sessions.upsert(channelId, threadKey, result.chatId, decision.label);
      }

      if (result.status === "ok" || (result.text && result.status !== "error")) {
        const chunks = chunkText(result.text || "_No text response._", config.textChunkLimit);
        for (const chunk of chunks) {
          await slack.poster.post(decision.channelId, chunk, replyThreadTs);
        }
        await progress.succeed();
      } else {
        const errText =
          result.status === "timeout"
            ? "Timed out waiting for the agent."
            : result.status === "stopped"
              ? "Stopped."
              : `Agent error: ${result.text || result.stderr || "unknown"}`;
        await slack.poster.post(decision.channelId, errText, replyThreadTs);
        await progress.fail();
      }

      // silence unused
      void isNew;
    } catch (err) {
      this.activeRunKeys.delete(sessionKey);
      await slack.poster.post(
        decision.channelId,
        `Bridge error: ${err instanceof Error ? err.message : String(err)}`,
        replyThreadTs,
      );
      await progress.fail();
    }
  }
}
