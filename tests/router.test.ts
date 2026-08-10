import { describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../src/agent-runner.js";
import type { BridgeConfig } from "../src/config.js";
import { MessageRouter } from "../src/router.js";
import { SessionStore } from "../src/sessions.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bot = "UBOT";

function cfg(): BridgeConfig {
  return {
    slackBotToken: "x",
    slackAppToken: "y",
    cursorApiKey: "k",
    agentBin: "agent",
    workspace: "/ws",
    sessionDb: join(mkdtempSync(join(tmpdir(), "r-")), "s.db"),
    dmPolicy: "allowlist",
    allowedUserIds: new Set(["U1"]),
    alertChannels: new Set(["C_SYSOPS"]),
    openChannels: new Set(),
    typingReaction: "hourglass_flowing_sand",
    textChunkLimit: 3500,
    keepaliveSeconds: 45,
    keepaliveThresholdSeconds: 0,
    sessionTimeoutSeconds: 900,
    botUserId: bot,
  };
}

function mockSlack() {
  const posts: Array<{ channel: string; text: string; thread?: string }> = [];
  const reactions: Array<{ op: string; name: string }> = [];
  return {
    posts,
    reactions,
    client: {
      authBotUserId: bot,
      reactions: {
        add: vi.fn(async (_c: string, _t: string, name: string) => {
          reactions.push({ op: "add", name });
        }),
        remove: vi.fn(async (_c: string, _t: string, name: string) => {
          reactions.push({ op: "remove", name });
        }),
      },
      poster: {
        post: vi.fn(async (channel: string, text: string, threadTs?: string) => {
          posts.push({ channel, text, thread: threadTs });
        }),
      },
    },
  };
}

describe("MessageRouter", () => {
  it("full DM turn: reaction → runner → post → clear", async () => {
    const slack = mockSlack();
    const runPrompt = vi.fn(async () => ({
      status: "ok" as const,
      chatId: "chat-1",
      text: "hello from agent",
      exitCode: 0,
      stderr: "",
    }));
    const runner: AgentRunner = {
      createChat: vi.fn(async () => "chat-1"),
      runPrompt,
      stop: vi.fn(() => false),
    };
    const sessions = new SessionStore(cfg().sessionDb);
    const router = new MessageRouter({
      config: cfg(),
      sessions,
      runner,
      slack: slack.client,
    });

    await router.process({
      channel: "D1",
      channel_type: "im",
      user: "U1",
      text: "hi",
      ts: "1.0",
    });

    expect(runPrompt).toHaveBeenCalled();
    expect(runPrompt.mock.calls[0][0].workspace).toBe("/ws");
    expect(runPrompt.mock.calls[0][0].prompt).toContain("[slack dm]");
    expect(slack.posts.some((p) => p.text.includes("hello from agent"))).toBe(true);
    expect(slack.reactions.some((r) => r.name === "hourglass_flowing_sand" && r.op === "add")).toBe(
      true,
    );
    expect(slack.reactions.some((r) => r.name === "white_check_mark")).toBe(true);
    sessions.close();
  });

  it("sysops mention replies in thread", async () => {
    const slack = mockSlack();
    const runner: AgentRunner = {
      createChat: vi.fn(async () => "c2"),
      runPrompt: vi.fn(async () => ({
        status: "ok" as const,
        chatId: "c2",
        text: "ok",
        exitCode: 0,
        stderr: "",
      })),
      stop: vi.fn(() => false),
    };
    const c = cfg();
    const sessions = new SessionStore(c.sessionDb);
    const router = new MessageRouter({ config: c, sessions, runner, slack: slack.client });

    await router.process({
      channel: "C_SYSOPS",
      user: "U1",
      text: `<@${bot}> help`,
      ts: "50.0",
    });

    expect(slack.posts.some((p) => p.thread === "50.0")).toBe(true);
    sessions.close();
  });

  it("ignored events never call runner", async () => {
    const slack = mockSlack();
    const runner: AgentRunner = {
      createChat: vi.fn(),
      runPrompt: vi.fn(),
      stop: vi.fn(() => false),
    };
    const c = cfg();
    const sessions = new SessionStore(c.sessionDb);
    const router = new MessageRouter({ config: c, sessions, runner, slack: slack.client });
    await router.process({
      channel: "C_SYSOPS",
      user: "U1",
      text: "no mention",
      ts: "1",
    });
    expect(runner.runPrompt).not.toHaveBeenCalled();
    sessions.close();
  });

  it("ping / stop never spawn agent", async () => {
    const slack = mockSlack();
    const runner: AgentRunner = {
      createChat: vi.fn(),
      runPrompt: vi.fn(),
      stop: vi.fn(() => false),
    };
    const c = cfg();
    const sessions = new SessionStore(c.sessionDb);
    const router = new MessageRouter({ config: c, sessions, runner, slack: slack.client });
    await router.process({
      channel: "D1",
      user: "U1",
      text: "ping",
      ts: "1",
    });
    expect(runner.runPrompt).not.toHaveBeenCalled();
    expect(slack.posts[0]?.text).toMatch(/Pong/i);
    await router.process({
      channel: "D1",
      user: "U1",
      text: "stop",
      ts: "2",
    });
    expect(runner.runPrompt).not.toHaveBeenCalled();
    sessions.close();
  });

  it("queues concurrent messages for same thread", async () => {
    const slack = mockSlack();
    let concurrent = 0;
    let maxConcurrent = 0;
    const runner: AgentRunner = {
      createChat: vi.fn(async () => "c"),
      runPrompt: vi.fn(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 30));
        concurrent--;
        return { status: "ok" as const, chatId: "c", text: "x", exitCode: 0, stderr: "" };
      }),
      stop: vi.fn(() => false),
    };
    const c = cfg();
    const sessions = new SessionStore(c.sessionDb);
    const router = new MessageRouter({ config: c, sessions, runner, slack: slack.client });
    await Promise.all([
      router.process({ channel: "D1", user: "U1", text: "a", ts: "1" }),
      router.process({ channel: "D1", user: "U1", text: "b", ts: "2" }),
    ]);
    expect(maxConcurrent).toBe(1);
    expect(runner.runPrompt).toHaveBeenCalledTimes(2);
    sessions.close();
  });
});
