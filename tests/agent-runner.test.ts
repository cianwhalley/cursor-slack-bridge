import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { CursorAgentRunner } from "../src/agent-runner.js";

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

afterEach(() => {
  mockedSpawn.mockReset();
});

describe("CursorAgentRunner", () => {
  it("create-chat uses workspace trust force", async () => {
    mockedSpawn.mockImplementation((bin, args) => {
      expect(bin).toBe("agent");
      expect(args).toEqual(["create-chat", "--workspace", "/ws", "--trust", "--force"]);
      return fakeChild({ stdoutText: "chat-123\n" }) as never;
    });
    const r = new CursorAgentRunner();
    await expect(r.createChat("agent", "/ws")).resolves.toBe("chat-123");
  });

  it("runPrompt includes --resume when chat exists", async () => {
    mockedSpawn.mockImplementation((_bin, args) => {
      const a = args as string[];
      expect(a).toContain("--resume");
      expect(a).toContain("chat-existing");
      expect(a).toContain("--workspace");
      expect(a).toContain("--trust");
      expect(a).toContain("--force");
      expect(a).toContain("--print");
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
        return fakeChild({ stdoutText: "created-1\n" }) as never;
      }
      expect(a).toContain("created-1");
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
    expect(result.chatId).toBe("created-1");
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
