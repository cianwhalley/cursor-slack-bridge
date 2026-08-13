import type { BridgeConfig } from "./config.js";
import type { AgentRunner } from "./agent-runner.js";
import { buildPrompt, chunkText } from "./format.js";
import {
  bridgeHelpText,
  isBridgeCommand,
  shouldEngage,
  slackPromptPrefix,
  type SlackEventLike,
} from "./policy.js";
import {
  ProgressTracker,
  type SlackAssistantStatus,
  type SlackPoster,
  type SlackReactions,
} from "./progress.js";
import { progressFromStreamLine } from "./stream-events.js";
import type { SessionStore } from "./sessions.js";

export interface SlackClient {
  reactions: SlackReactions;
  poster: SlackPoster;
  assistantStatus?: SlackAssistantStatus;
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

    if (cmd === "help") {
      await slack.poster.post(
        decision.channelId,
        bridgeHelpText({
          workspace: cfg.workspace,
          dmPolicy: cfg.dmPolicy,
          channelPolicy: cfg.channelPolicy,
        }),
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
    if (this.running.has(sessionKey)) {
      await this.ackQueued(decision, replyThreadTs);
    }
    await this.enqueue(sessionKey, task);
  }

  /** Visible ack while another turn is still running (otherwise Slack looks dead). */
  private async ackQueued(
    decision: Extract<ReturnType<typeof shouldEngage>, { engage: true }>,
    replyThreadTs: string | undefined,
  ): Promise<void> {
    const { config, slack } = this.deps;
    try {
      await slack.reactions.add(
        decision.channelId,
        decision.messageTs,
        config.typingReaction,
      );
    } catch (err) {
      console.warn(
        "[router] queued reaction failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    try {
      await slack.poster.post(
        decision.channelId,
        "Still working on your last message — I'll take this next. Send `stop` to cancel.",
        replyThreadTs,
      );
    } catch (err) {
      console.warn(
        "[router] queued notice failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
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
    const progress = new ProgressTracker({
      reactions: slack.reactions,
      poster: slack.poster,
      assistantStatus: slack.assistantStatus,
      channelId: decision.channelId,
      messageTs: decision.messageTs,
      replyThreadTs,
      typingReaction: config.typingReaction,
      streamingMode: config.streamingMode,
      draftDelaySeconds: config.draftDelaySeconds,
      statusKeepaliveSeconds: config.statusKeepaliveSeconds,
      maxProgressLines: config.maxProgressLines,
      maxLineChars: config.maxLineChars,
      progressLabel: config.progressLabel,
      textChunkLimit: config.textChunkLimit,
    });
    await progress.start();

    const postChunks = async (text: string) => {
      const chunks = chunkText(text, config.textChunkLimit);
      for (const chunk of chunks) {
        await slack.poster.post(decision.channelId, chunk, replyThreadTs);
      }
    };

    try {
      let chatId = sessions.get(channelId, threadKey)?.cursorChatId;

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
        onStdoutLine: (line) => {
          const ev = progressFromStreamLine(line, {
            detailMode: config.toolProgressDetail,
            commandText: config.progressCommandText,
            maxLineChars: config.maxLineChars,
            commentary: config.progressCommentary,
          });
          if (ev) {
            void progress.noteProgress(ev.line, ev.statusPhrase);
          }
        },
      });
      this.activeRunKeys.delete(sessionKey);

      if (result.chatId && result.chatId !== chatId) {
        sessions.upsert(channelId, threadKey, result.chatId, decision.label);
      }

      if (result.status === "ok" || (result.text && result.status !== "error")) {
        await progress.succeed(result.text || "_No text response._", postChunks);
      } else {
        const errText =
          result.status === "timeout"
            ? "Timed out waiting for the agent."
            : result.status === "stopped"
              ? "Stopped."
              : `Agent error: ${result.text || result.stderr || "unknown"}`;
        await progress.fail(errText, postChunks);
      }
    } catch (err) {
      this.activeRunKeys.delete(sessionKey);
      await progress.fail(
        `Bridge error: ${err instanceof Error ? err.message : String(err)}`,
        postChunks,
      );
    }
  }
}
