import { describe, expect, it, vi } from "vitest";
import { ProgressTracker } from "../src/progress.js";

describe("ProgressTracker", () => {
  it("adds typing reaction on start and swaps on succeed", async () => {
    const adds: string[] = [];
    const removes: string[] = [];
    const reactions = {
      add: vi.fn(async (_c: string, _t: string, name: string) => {
        adds.push(name);
      }),
      remove: vi.fn(async (_c: string, _t: string, name: string) => {
        removes.push(name);
      }),
    };
    const poster = { post: vi.fn(async () => {}) };
    const p = new ProgressTracker(reactions, poster, "C1", "1.0", "1.0", "hourglass_flowing_sand", 0, 0);
    await p.start();
    expect(adds).toEqual(["hourglass_flowing_sand"]);
    await p.succeed();
    expect(removes).toEqual(["hourglass_flowing_sand"]);
    expect(adds).toContain("white_check_mark");
  });

  it("fails with x reaction", async () => {
    const adds: string[] = [];
    const reactions = {
      add: vi.fn(async (_c: string, _t: string, name: string) => {
        adds.push(name);
      }),
      remove: vi.fn(async () => {}),
    };
    const p = new ProgressTracker(
      reactions,
      { post: vi.fn(async () => {}) },
      "C1",
      "1.0",
      undefined,
      "hourglass_flowing_sand",
      0,
      0,
    );
    await p.start();
    await p.fail();
    expect(adds).toContain("x");
  });

  it("keepalive posts after threshold", async () => {
    vi.useFakeTimers();
    const posts: string[] = [];
    const p = new ProgressTracker(
      { add: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      {
        post: vi.fn(async (_c, text) => {
          posts.push(text);
        }),
      },
      "C1",
      "1.0",
      "1.0",
      "hourglass_flowing_sand",
      1,
      1,
    );
    await p.start();
    await vi.advanceTimersByTimeAsync(1100);
    expect(posts.some((t) => t.includes("still working"))).toBe(true);
    await p.succeed();
    vi.useRealTimers();
  });
});
