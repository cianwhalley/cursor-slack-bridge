import { describe, expect, it, vi } from "vitest";
import { ProgressTracker } from "../src/progress.js";

function baseOpts(overrides: Partial<ConstructorParameters<typeof ProgressTracker>[0]> = {}) {
  const posts: Array<{ text: string; ts?: string }> = [];
  const updates: Array<{ ts: string; text: string }> = [];
  const deletes: string[] = [];
  const statuses: string[] = [];
  const adds: string[] = [];
  const removes: string[] = [];
  let postN = 0;

  const opts = {
    reactions: {
      add: vi.fn(async (_c: string, _t: string, name: string) => {
        adds.push(name);
      }),
      remove: vi.fn(async (_c: string, _t: string, name: string) => {
        removes.push(name);
      }),
    },
    poster: {
      post: vi.fn(async (_c: string, text: string) => {
        postN += 1;
        const ts = `ts${postN}`;
        posts.push({ text, ts });
        return ts;
      }),
      update: vi.fn(async (_c: string, ts: string, text: string) => {
        updates.push({ ts, text });
      }),
      delete: vi.fn(async (_c: string, ts: string) => {
        deletes.push(ts);
      }),
    },
    assistantStatus: {
      setStatus: vi.fn(async (_c: string, _t: string, status: string) => {
        statuses.push(status);
      }),
    },
    channelId: "C1",
    messageTs: "1.0",
    replyThreadTs: "1.0",
    typingReaction: "hourglass_flowing_sand",
    streamingMode: "progress" as const,
    draftDelaySeconds: 0,
    statusKeepaliveSeconds: 0,
    maxProgressLines: 8,
    maxLineChars: 120,
    progressLabel: "Working",
    textChunkLimit: 3500,
    ...overrides,
  };

  return { opts, posts, updates, deletes, statuses, adds, removes };
}

describe("ProgressTracker (OpenClaw-style)", () => {
  it("adds typing reaction on start and swaps on succeed", async () => {
    const { opts, adds, removes, updates } = baseOpts({ draftDelaySeconds: -1, streamingMode: "off" });
    const p = new ProgressTracker(opts);
    await p.start();
    expect(adds).toEqual(["hourglass_flowing_sand"]);
    await p.succeed("hello", async () => {
      await opts.poster.post("C1", "hello");
    });
    expect(removes).toEqual(["hourglass_flowing_sand"]);
    expect(adds).toContain("white_check_mark");
    // streaming off: no draft edit path required
    void updates;
  });

  it("fails with x reaction", async () => {
    const { opts, adds } = baseOpts({ streamingMode: "off", draftDelaySeconds: -1 });
    const p = new ProgressTracker(opts);
    await p.start();
    await p.fail("boom", async (t) => {
      await opts.poster.post("C1", t);
    });
    expect(adds).toContain("x");
  });

  it("never posts still-working keepalive bubbles", async () => {
    vi.useFakeTimers();
    const { opts, posts } = baseOpts({
      draftDelaySeconds: 10,
      statusKeepaliveSeconds: 1,
      replyThreadTs: "1.0",
    });
    const p = new ProgressTracker(opts);
    await p.start();
    await vi.advanceTimersByTimeAsync(2500);
    expect(posts.every((p) => !/still working/i.test(p.text))).toBe(true);
    await p.succeed("done", async () => {});
    vi.useRealTimers();
  });

  it("edits one draft with progress then replaces with final", async () => {
    vi.useFakeTimers();
    const { opts, posts, updates } = baseOpts({
      draftDelaySeconds: 1,
      statusKeepaliveSeconds: 0,
      replyThreadTs: undefined, // top-level DM: draft only
    });
    const p = new ProgressTracker(opts);
    await p.start();
    await vi.advanceTimersByTimeAsync(1100);
    expect(posts.length).toBe(1);
    expect(posts[0].text).toBe("Working");

    await p.noteProgress("🛠️ hostname");
    expect(updates.some((u) => u.text.startsWith("Working\n") && u.text.includes("hostname"))).toBe(
      true,
    );

    await p.succeed("nanoclaw", async () => {
      throw new Error("should edit in place, not postChunks");
    });
    expect(updates.at(-1)?.text).toBe("nanoclaw");
    vi.useRealTimers();
  });

  it("sets assistant status when reply thread exists", async () => {
    const { opts, statuses } = baseOpts({
      replyThreadTs: "9.9",
      draftDelaySeconds: -1,
      streamingMode: "off",
    });
    const p = new ProgressTracker(opts);
    await p.start();
    expect(statuses[0]).toMatch(/thinking/);
    await p.succeed("ok", async (t) => {
      await opts.poster.post("C1", t);
    });
    expect(statuses.at(-1)).toBe("");
  });
});
