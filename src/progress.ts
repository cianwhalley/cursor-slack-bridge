export interface SlackReactions {
  add(channel: string, timestamp: string, name: string): Promise<void>;
  remove(channel: string, timestamp: string, name: string): Promise<void>;
}

export interface SlackPoster {
  post(channel: string, text: string, threadTs?: string): Promise<void>;
}

export class ProgressTracker {
  private keepaliveTimer: ReturnType<typeof setTimeout> | undefined;
  private keepaliveInterval: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private finished = false;

  constructor(
    private readonly reactions: SlackReactions,
    private readonly poster: SlackPoster,
    private readonly channelId: string,
    private readonly messageTs: string,
    private readonly threadTs: string | undefined,
    private readonly typingReaction: string,
    private readonly keepaliveThresholdSeconds: number,
    private readonly keepaliveSeconds: number,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await this.reactions.add(this.channelId, this.messageTs, this.typingReaction);
    } catch {
      // non-fatal
    }
    if (this.keepaliveThresholdSeconds > 0 && this.keepaliveSeconds > 0) {
      this.keepaliveTimer = setTimeout(() => {
        if (this.finished) return;
        void this.poster.post(this.channelId, "_still working…_", this.threadTs);
        this.keepaliveInterval = setInterval(() => {
          if (this.finished) return;
          void this.poster.post(this.channelId, "_still working…_", this.threadTs);
        }, this.keepaliveSeconds * 1000);
      }, this.keepaliveThresholdSeconds * 1000);
    }
  }

  async succeed(): Promise<void> {
    await this.finish("white_check_mark");
  }

  async fail(): Promise<void> {
    await this.finish("x");
  }

  private async finish(finalReaction: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    if (this.keepaliveInterval) clearInterval(this.keepaliveInterval);
    try {
      await this.reactions.remove(this.channelId, this.messageTs, this.typingReaction);
    } catch {
      // ignore
    }
    try {
      await this.reactions.add(this.channelId, this.messageTs, finalReaction);
    } catch {
      // ignore
    }
  }
}
