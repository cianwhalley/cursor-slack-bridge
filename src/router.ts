import type { BridgeConfig } from "./config.js";
import type { AgentRunner } from "./agent-runner.js";
import { buildPrompt, chunkText } from "./format.js";
import {
  bridgeHelpText,
  eventHasFiles,
  isBridgeCommand,
  shouldEngage,
  slackPromptPrefix,
  type SlackEventLike,
} from "./policy.js";
import { ingestSlackFiles, VOICE_REPLY_INSTRUCTION, type IngestResult } from "./slack-files.js";
import { isAllowedVoicePath, splitVoiceReply, unlinkVoiceFile } from "./voice-reply.js";
import {
  ProgressTracker,
  type SlackAssistantStatus,
  type SlackPoster,
  type SlackReactions,
} from "./progress.js";
import { progressFromStreamLine } from "./stream-events.js";
import type { SessionStore } from "./sessions.js";
import {
  autoModeReplyPrefix,
  shouldRetryWithAuto,
  usageLimitReason,
  agentErrorText,
} from "./model-fallback.js";
import type { RunPromptResult } from "./agent-runner.js";

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
  ingestFiles?: (event: SlackEventLike) => Promise<IngestResult>;
}

type QueueItem = () => Promise<void>;

export class MessageRouter {
  private readonly queues = new Map<string, QueueItem[]>();
  private readonly running = new Set<string>();
  private readonly activeRunKeys = new Map<string, string>(); // sessionKey -> runner stop key
  /** Slack often delivers the same @mention as both `message` and `app_mention`. */
  private readonly seenMessageTs = new Map<string, number>();
  private static readonly DEDUPE_TTL_MS = 120_000;

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

    // Drop duplicate deliveries of the same Slack message (message + app_mention, retries).
    const dedupeKey = `${decision.channelId}:${decision.messageTs}`;
    const now = Date.now();
    for (const [k, at] of this.seenMessageTs) {
      if (now - at > MessageRouter.DEDUPE_TTL_MS) this.seenMessageTs.delete(k);
    }
    if (this.seenMessageTs.has(dedupeKey)) {
      return;
    }
    this.seenMessageTs.set(dedupeKey, now);

    const cmd = isBridgeCommand(decision.text);
    const replyThreadTs = decision.threadTs;

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

    const task = () =>
      this.runAgentTurn(event, decision, replyThreadTs, sessionKey, channelId, threadKey);
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
    event: SlackEventLike,
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
      const primaryModel = config.agentModel;
      const fallbackModel = config.agentModelFallback;
      let forcedModel: string | undefined;
      let createAutoReason: string | undefined;

      if (!chatId) {
        const created = await this.createChatWithFallback(
          runner,
          config,
          fallbackModel,
          primaryModel,
          async (reason) => {
            createAutoReason = reason;
          },
        );
        chatId = created.chatId;
        forcedModel = created.forcedModel;
        sessions.upsert(channelId, threadKey, chatId, decision.label);
      } else {
        sessions.touch(channelId, threadKey);
      }

      if (!decision.isDm) {
        sessions.markParticipated(decision.channelId, decision.threadTs);
      }

      const prefix = slackPromptPrefix(decision.isDm, decision.channelId, decision.threadTs);
      const ingest = eventHasFiles(event)
        ? await this.ingestEvent(event)
        : { promptAddon: "", inboundVoice: false };
      const promptParts = [
        buildPrompt(prefix, decision.text),
        ingest.promptAddon,
        ingest.inboundVoice ? VOICE_REPLY_INSTRUCTION : "",
      ].filter((p) => p.trim());
      const prompt = promptParts.join("\n\n");

      this.activeRunKeys.set(sessionKey, chatId);
      const { result, autoReason } = await this.runPromptWithFallback({
        runner,
        config,
        chatId,
        prompt,
        primaryModel: forcedModel ?? primaryModel,
        fallbackModel,
        skipFallbackRetry: Boolean(forcedModel),
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
        onSwitchingToAuto: async (_reason) => {
          // Final reply is prefixed with Auto mode — no extra Slack post or draft line.
        },
        knownAutoReason: createAutoReason,
      });
      this.activeRunKeys.delete(sessionKey);

      const finalAutoReason = autoReason ?? createAutoReason;

      if (result.chatId && result.chatId !== chatId) {
        sessions.upsert(channelId, threadKey, result.chatId, decision.label);
      }

      if (result.status === "ok" || (result.text && result.status !== "error")) {
        let text = result.text || "_No text response._";
        if (finalAutoReason) {
          text = autoModeReplyPrefix(finalAutoReason) + text;
        }
        await this.deliverReply(text, decision.channelId, replyThreadTs, progress, postChunks, {
          forcePost: Boolean(finalAutoReason),
        });
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

  private async ingestEvent(event: SlackEventLike): Promise<IngestResult> {
    if (this.deps.ingestFiles) {
      return this.deps.ingestFiles(event);
    }
    return ingestSlackFiles({
      files: event.files ?? [],
      botToken: this.deps.config.slackBotToken,
      workspace: this.deps.config.workspace,
      messageTs: event.ts ?? "",
    });
  }

  private async deliverReply(
    text: string,
    channelId: string,
    replyThreadTs: string | undefined,
    progress: ProgressTracker,
    postChunks: (text: string) => Promise<void>,
    opts: { forcePost?: boolean },
  ): Promise<void> {
    const { caption, voicePath } = splitVoiceReply(text);
    const visible = caption || (voicePath ? "Voice note" : "_No text response._");
    await progress.succeed(visible, postChunks, { forcePost: opts.forcePost });

    if (!voicePath) return;

    const allowed = isAllowedVoicePath(voicePath, this.deps.config.workspace);
    if (!allowed) {
      console.warn("[router] VOICE_REPLY path rejected");
      await this.deps.slack.poster.post(
        channelId,
        "Voice file path was not allowed (must be under the workspace or `~/.cache`).",
        replyThreadTs,
      );
      return;
    }

    const upload = this.deps.slack.poster.uploadFile;
    if (!upload) {
      await this.deps.slack.poster.post(
        channelId,
        "Voice note was generated but this bridge cannot upload files.",
        replyThreadTs,
      );
      return;
    }

    try {
      await upload(channelId, voicePath, {
        filename: "voice-note.mp3",
        title: "Voice note",
        threadTs: replyThreadTs,
      });
      await unlinkVoiceFile(voicePath);
    } catch (err) {
      console.error(
        "[router] voice upload failed:",
        err instanceof Error ? err.message : String(err),
      );
      await this.deps.slack.poster.post(
        channelId,
        "Voice note upload failed; the text reply is above.",
        replyThreadTs,
      );
    }
  }

  private async createChatWithFallback(
    runner: AgentRunner,
    config: BridgeConfig,
    fallbackModel: string | undefined,
    primaryModel: string | undefined,
    onSwitchingToAuto: (reason: string) => Promise<void>,
  ): Promise<{ chatId: string; forcedModel?: string }> {
    try {
      const chatId = await runner.createChat(
        config.agentBin,
        config.workspace,
        config.cursorApiKey,
        primaryModel,
      );
      return { chatId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        shouldRetryWithAuto({
          primaryModel,
          fallbackModel,
          errorText: msg,
          status: "error",
        })
      ) {
        const reason = usageLimitReason(msg);
        await onSwitchingToAuto(reason);
        const chatId = await runner.createChat(
          config.agentBin,
          config.workspace,
          config.cursorApiKey,
          fallbackModel,
        );
        return { chatId, forcedModel: fallbackModel };
      }
      throw err;
    }
  }

  private async runPromptWithFallback(opts: {
    runner: AgentRunner;
    config: BridgeConfig;
    chatId: string;
    prompt: string;
    primaryModel: string | undefined;
    fallbackModel: string | undefined;
    skipFallbackRetry?: boolean;
    knownAutoReason?: string;
    onStdoutLine: (line: string) => void;
    onSwitchingToAuto: (reason: string) => Promise<void>;
  }): Promise<{ result: RunPromptResult; autoReason?: string }> {
    const {
      runner,
      config,
      chatId,
      prompt,
      primaryModel,
      fallbackModel,
      skipFallbackRetry,
      knownAutoReason,
      onStdoutLine,
      onSwitchingToAuto,
    } = opts;

    const run = (model: string | undefined) =>
      runner.runPrompt({
        agentBin: config.agentBin,
        workspace: config.workspace,
        chatId,
        prompt,
        cursorApiKey: config.cursorApiKey,
        model,
        timeoutSeconds: config.sessionTimeoutSeconds,
        onStdoutLine,
      });

    let result = await run(primaryModel);
    let autoReason = knownAutoReason;

    if (skipFallbackRetry) {
      return { result, autoReason };
    }

    const errText = agentErrorText(result);
    if (
      shouldRetryWithAuto({
        primaryModel,
        fallbackModel,
        errorText: errText,
        status: result.status,
      })
    ) {
      autoReason = usageLimitReason(errText);
      console.warn(
        `[router] fast model limit — switching to ${fallbackModel}: ${autoReason}`,
      );
      await onSwitchingToAuto(autoReason);
      result = await run(fallbackModel);
    }

    return { result, autoReason };
  }
}
