import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { CursorAgentRunner, extractAssistantText } from "../src/agent-runner.js";

const mockedSpawn = vi.mocked(spawn);

function fakeChild(opts: {
  stdoutText?: string;
  stderrText?: string;
  code?: number;
  stayOpen?: boolean;
}) {
  const ee = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  ee.stdout = new PassThrough();
  ee.stderr = new PassThrough();
  ee.kill = vi.fn(() => {
    ee.emit("close", opts.code ?? 0);
  });

  setImmediate(() => {
    if (opts.stdoutText) ee.stdout.write(opts.stdoutText);
    if (opts.stderrText) ee.stderr.write(opts.stderrText);
    if (!opts.stayOpen) {
      ee.stdout.end();
      ee.stderr.end();
      ee.emit("close", opts.code ?? 0);
    }
  });
  return ee;
}

  it("strips Slack tokens from child env", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-secret";
    process.env.SLACK_APP_TOKEN = "xapp-secret";
    mockedSpawn.mockImplementation((_bin, _args, spawnOpts) => {
      expect(spawnOpts?.cwd).toBe("/ws");
      expect(spawnOpts?.env?.SLACK_BOT_TOKEN).toBeUndefined();
      expect(spawnOpts?.env?.SLACK_APP_TOKEN).toBeUndefined();
      expect(spawnOpts?.env?.CURSOR_API_KEY).toBe("k-test");
      return fakeChild({
        stdoutText: "2ebc41d7-5857-4ebd-9577-092d90e287e8\n",
      }) as never;
    });
    const r = new CursorAgentRunner();
    await r.createChat("agent", "/ws", "k-test");
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
  });

describe("CursorAgentRunner", () => {
  it("create-chat uses workspace trust force", async () => {
    mockedSpawn.mockImplementation((bin, args, spawnOpts) => {
      expect(bin).toBe("agent");
      expect(args).toEqual(["create-chat", "--workspace", "/ws", "--trust", "--force"]);
      expect(spawnOpts).toMatchObject({ cwd: "/ws" });
      expect(spawnOpts?.env).not.toHaveProperty("SLACK_BOT_TOKEN");
      expect(spawnOpts?.env).not.toHaveProperty("SLACK_APP_TOKEN");
      return fakeChild({
        stdoutText: "2ebc41d7-5857-4ebd-9577-092d90e287e8\n",
      }) as never;
    });
    const r = new CursorAgentRunner();
    await expect(r.createChat("agent", "/ws")).resolves.toBe(
      "2ebc41d7-5857-4ebd-9577-092d90e287e8",
    );
  });

  it("create-chat accepts UUID even when process exits non-zero", async () => {
    mockedSpawn.mockImplementation(
      () =>
        fakeChild({
          stdoutText: "9e4e0a64-cd41-4304-9d71-bb43443f2e2c\n",
          code: 15, // SIGTERM after hang
        }) as never,
    );
    const r = new CursorAgentRunner();
    await expect(r.createChat("agent", "/ws")).resolves.toBe(
      "9e4e0a64-cd41-4304-9d71-bb43443f2e2c",
    );
  });

  it("runPrompt includes --resume when chat exists", async () => {
    mockedSpawn.mockImplementation((_bin, args, spawnOpts) => {
      const a = args as string[];
      expect(a).toContain("--resume");
      expect(a).toContain("chat-existing");
      expect(a).toContain("--workspace");
      expect(a).toContain("--trust");
      expect(a).toContain("--force");
      expect(a).toContain("--print");
      expect(a).toContain("--model");
      expect(a).toContain("cursor-grok-4.5-high-fast");
      expect(spawnOpts).toMatchObject({ cwd: "/ws" });
      expect(spawnOpts?.env).not.toHaveProperty("SLACK_BOT_TOKEN");
      expect(spawnOpts?.env).not.toHaveProperty("SLACK_APP_TOKEN");
      expect(spawnOpts?.env?.CURSOR_API_KEY).toBe("k-test");
      const line = JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      });
      return fakeChild({ stdoutText: line + "\n" }) as never;
    });
    const r = new CursorAgentRunner();
    const result = await r.runPrompt({
      agentBin: "agent",
      workspace: "/ws",
      chatId: "chat-existing",
      prompt: "hello",
      cursorApiKey: "k-test",
      model: "cursor-grok-4.5-high-fast",
      timeoutSeconds: 30,
    });
    expect(result.status).toBe("ok");
    expect(result.text).toContain("hi");
  });

  it("create-chat when no session", async () => {
    let calls = 0;
    mockedSpawn.mockImplementation((_bin, args) => {
      calls++;
      const a = args as string[];
      if (a[0] === "create-chat") {
        return fakeChild({
          stdoutText: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n",
        }) as never;
      }
      expect(a).toContain("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      return fakeChild({
        stdoutText: JSON.stringify({ type: "result", result: "done" }) + "\n",
      }) as never;
    });
    const r = new CursorAgentRunner();
    const result = await r.runPrompt({
      agentBin: "agent",
      workspace: "/ws",
      chatId: undefined,
      prompt: "x",
      timeoutSeconds: 30,
    });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result.chatId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("stop kills active pid", async () => {
    let child: ReturnType<typeof fakeChild> | undefined;
    mockedSpawn.mockImplementation(() => {
      child = fakeChild({ stayOpen: true });
      return child as never;
    });

    const r = new CursorAgentRunner();
    const p = r.runPrompt({
      agentBin: "agent",
      workspace: "/ws",
      chatId: "c1",
      prompt: "long",
      timeoutSeconds: 0,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(r.stop("c1")).toBe(true);
    expect(child?.kill).toHaveBeenCalled();
    const result = await p;
    expect(result.status).toBe("stopped");
  });

  it("extractAssistantText prefers last assistant over joined result", () => {
    expect(
      extractAssistantText([
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "preamble" }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "final" }] },
        }),
        JSON.stringify({ type: "result", result: "preamblefinal" }),
      ]),
    ).toBe("final");
  });

  it("propagates non-zero exit without text as error", async () => {
    mockedSpawn.mockImplementation(
      () => fakeChild({ code: 2, stderrText: "boom", stdoutText: "" }) as never,
    );
    const r = new CursorAgentRunner();
    const result = await r.runPrompt({
      agentBin: "agent",
      workspace: "/ws",
      chatId: "c1",
      prompt: "x",
      timeoutSeconds: 30,
    });
    expect(result.status).toBe("error");
    expect(result.text).toMatch(/boom|exited/);
  });
});
