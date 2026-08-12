/**
 * OpenClaw-style Slack progress:
 * - ack reaction on the user message
 * - assistant.threads.setStatus when a reply thread exists (not top-level DMs)
 * - one editable draft preview (never a stack of "still working" posts)
 * - final answer replaces the draft in place when possible
 */

export interface SlackReactions {
  add(channel: string, timestamp: string, name: string): Promise<void>;
  remove(channel: string, timestamp: string, name: string): Promise<void>;
}

export interface SlackPoster {
  /** Returns message ts when available. */
  post(channel: string, text: string, threadTs?: string): Promise<string | undefined>;
  update?(channel: string, ts: string, text: string): Promise<void>;
  delete?(channel: string, ts: string): Promise<void>;
}

export interface SlackAssistantStatus {
  setStatus(channel: string, threadTs: string, status: string): Promise<void>;
}

export type StreamingMode = "off" | "progress";

export interface ProgressTrackerOptions {
  reactions: SlackReactions;
  poster: SlackPoster;
  assistantStatus?: SlackAssistantStatus;
  channelId: string;
  messageTs: string;
  /** Where replies / drafts go. Undefined = top-level DM (draft-only, no setStatus). */
  replyThreadTs: string | undefined;
  typingReaction: string;
  streamingMode: StreamingMode;
  /** Delay before creating the draft (OpenClaw default ~1.5s). */
  draftDelaySeconds: number;
  /** Refresh setStatus while running (Slack TTL ~2 min; NanoClaw uses 90s). */
  statusKeepaliveSeconds: number;
  maxProgressLines: number;
  /** OpenClaw streaming.progress.maxLineChars (default 120). */
  maxLineChars: number;
  /** OpenClaw draft label — shown above tool lines. */
  progressLabel: string;
  textChunkLimit: number;
}

function formatStatusPhrase(title: string): string {
  const t = title.trim();
  if (!t) return "is thinking…";
  if (/^is\s+/i.test(t)) return t;
  return `is ${t.charAt(0).toLowerCase()}${t.slice(1)}`;
}

export class ProgressTracker {
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private finished = false;
  private draftTs: string | undefined;
  private progressLines: string[] = [];
  private lastStatusTitle = "";
  private readonly canStatus: boolean;

  constructor(private readonly opts: ProgressTrackerOptions) {
    // OpenClaw: top-level DMs stay off-thread — no native status; use draft preview.
    this.canStatus = Boolean(opts.assistantStatus && opts.replyThreadTs);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await this.opts.reactions.add(
        this.opts.channelId,
        this.opts.messageTs,
        this.opts.typingReaction,
      );
    } catch (err) {
      console.warn(
        "[progress] reaction add failed:",
        err instanceof Error ? err.message : String(err),
      );
    }

    if (this.canStatus) {
      await this.refreshStatus("");
      if (this.opts.statusKeepaliveSeconds > 0) {
        this.keepaliveTimer = setInterval(() => {
          if (this.finished) return;
          void this.refreshStatus(this.lastStatusTitle);
        }, this.opts.statusKeepaliveSeconds * 1000);
      }
    }

    if (this.opts.streamingMode === "progress" && this.opts.draftDelaySeconds >= 0) {
      this.draftTimer = setTimeout(() => {
        void this.ensureDraft();
      }, this.opts.draftDelaySeconds * 1000);
    }
  }

  /** OpenClaw progress line → edit the single draft; update status phrase when threaded. */
  async noteProgress(line: string, statusPhrase?: string): Promise<void> {
    if (this.finished || this.opts.streamingMode !== "progress") return;
    const trimmed = line.trim();
    if (!trimmed) return;
    if (this.progressLines[this.progressLines.length - 1] === trimmed) return;
    this.progressLines.push(trimmed);
    while (this.progressLines.length > this.opts.maxProgressLines) {
      this.progressLines.shift();
    }
    if (statusPhrase) {
      this.lastStatusTitle = statusPhrase.replace(/^is\s+/i, "");
      await this.refreshStatus(this.lastStatusTitle);
    }
    await this.ensureDraft();
    await this.renderDraft();
  }

  async succeed(finalText: string, postChunks: (text: string) => Promise<void>): Promise<void> {
    await this.finish("white_check_mark", finalText, postChunks, false);
  }

  async fail(errorText: string, postChunks: (text: string) => Promise<void>): Promise<void> {
    await this.finish("x", errorText, postChunks, true);
  }

  private async finish(
    finalReaction: string,
    text: string,
    postChunks: (text: string) => Promise<void>,
    isError: boolean,
  ): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.draftTimer) clearTimeout(this.draftTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);

    const body = text.trim() || (isError ? "Error." : "_No text response._");

    try {
      if (this.draftTs && this.opts.poster.update && body.length <= this.opts.textChunkLimit) {
        await this.opts.poster.update(this.opts.channelId, this.draftTs, body);
      } else {
        if (this.draftTs && this.opts.poster.delete) {
          try {
            await this.opts.poster.delete(this.opts.channelId, this.draftTs);
          } catch {
            // keep draft if delete fails; still post final
          }
        }
        await postChunks(body);
      }
    } catch {
      await postChunks(body);
    }

    if (this.canStatus) {
      try {
        await this.opts.assistantStatus!.setStatus(
          this.opts.channelId,
          this.opts.replyThreadTs!,
          "",
        );
      } catch {
        // cleared automatically on reply in many clients
      }
    }

    try {
      await this.opts.reactions.remove(
        this.opts.channelId,
        this.opts.messageTs,
        this.opts.typingReaction,
      );
    } catch {
      // ignore
    }
    try {
      await this.opts.reactions.add(this.opts.channelId, this.opts.messageTs, finalReaction);
    } catch {
      // ignore
    }
  }

  private async refreshStatus(title: string): Promise<void> {
    if (!this.canStatus || this.finished) return;
    try {
      await this.opts.assistantStatus!.setStatus(
        this.opts.channelId,
        this.opts.replyThreadTs!,
        formatStatusPhrase(title),
      );
    } catch {
      // missing_scope / not supported — draft still works
    }
  }

  private async ensureDraft(): Promise<void> {
    if (this.finished || this.draftTs || this.opts.streamingMode !== "progress") return;
    try {
      const ts = await this.opts.poster.post(
        this.opts.channelId,
        this.draftBody(),
        this.opts.replyThreadTs,
      );
      this.draftTs = ts;
    } catch (err) {
      console.warn(
        "[progress] draft post failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async renderDraft(): Promise<void> {
    if (!this.draftTs || !this.opts.poster.update || this.finished) return;
    try {
      await this.opts.poster.update(this.opts.channelId, this.draftTs, this.draftBody());
    } catch {
      // ignore
    }
  }

  private draftBody(): string {
    const label = this.opts.progressLabel.trim() || "Working";
    if (this.progressLines.length === 0) {
      return `${label}…\n_Send \`stop\` to cancel._`;
    }
    // OpenClaw: label on top, rolling tool lines below (truncated per maxLineChars upstream).
    return [label, ...this.progressLines].join("\n");
  }
}
