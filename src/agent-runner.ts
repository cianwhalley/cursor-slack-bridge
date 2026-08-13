import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { extractAssistantText } from "./stream-events.js";

type ActiveChild = ChildProcess & { __markStopped?: () => void };

export { extractAssistantText };

export interface RunPromptOptions {
  agentBin: string;
  workspace: string;
  chatId: string | undefined;
  prompt: string;
  cursorApiKey?: string;
  timeoutSeconds: number;
  onStdoutLine?: (line: string) => void;
}

export interface RunPromptResult {
  status: "ok" | "error" | "timeout" | "stopped";
  chatId: string | undefined;
  text: string;
  exitCode: number | null;
  stderr: string;
}

export interface AgentRunner {
  createChat(agentBin: string, workspace: string, cursorApiKey?: string): Promise<string>;
  runPrompt(opts: RunPromptOptions): Promise<RunPromptResult>;
  stop(key: string): boolean;
}

function childEnv(cursorApiKey?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.SLACK_BOT_TOKEN;
  delete env.SLACK_APP_TOKEN;
  if (cursorApiKey) env.CURSOR_API_KEY = cursorApiKey;
  return env;
}

function runCapture(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutSeconds: number,
  opts?: { cwd?: string; earlyResolveWhen?: (stdout: string) => boolean },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, cwd: opts?.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code });
    };
    const timer =
      timeoutSeconds > 0
        ? setTimeout(() => {
            child.kill("SIGTERM");
          }, timeoutSeconds * 1000)
        : undefined;
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (opts?.earlyResolveWhen?.(stdout)) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on("close", (code) => {
      finish(code);
    });
  });
}

const CHAT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseChatId(stdout: string): string | undefined {
  const first = stdout.trim().split(/\s+/)[0];
  return first && CHAT_ID_RE.test(first) ? first : undefined;
}

export class CursorAgentRunner implements AgentRunner {
  private readonly active = new Map<string, ActiveChild>();

  async createChat(agentBin: string, workspace: string, cursorApiKey?: string): Promise<string> {
    const env = childEnv(cursorApiKey);
    // agent create-chat often prints the UUID then hangs; kill early and accept UUID on non-zero exit.
    const { stdout, stderr, code } = await runCapture(
      agentBin,
      ["create-chat", "--workspace", workspace, "--trust", "--force"],
      env,
      25,
      { cwd: workspace, earlyResolveWhen: (out) => Boolean(parseChatId(out)) },
    );
    const chatId = parseChatId(stdout);
    if (chatId) {
      return chatId;
    }
    throw new Error(`create-chat failed: ${stderr || stdout || `exit ${code}`}`);
  }

  async runPrompt(opts: RunPromptOptions): Promise<RunPromptResult> {
    const key = opts.chatId ?? "new";
    const env = childEnv(opts.cursorApiKey);

    let chatId = opts.chatId;
    if (!chatId) {
      chatId = await this.createChat(opts.agentBin, opts.workspace, opts.cursorApiKey);
    }

    const args = [
      "--resume",
      chatId,
      "--print",
      "--output-format",
      "stream-json",
      "--workspace",
      opts.workspace,
      "--trust",
      "--force",
      opts.prompt,
    ];

    return new Promise((resolve) => {
      const child = spawn(opts.agentBin, args, {
        env,
        cwd: opts.workspace,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.active.set(key, child);
      // Also index by chat id for stop
      this.active.set(chatId!, child);

      const lines: string[] = [];
      let stderr = "";
      let stopped = false;
      let timedOut = false;

      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        lines.push(line);
        opts.onStdoutLine?.(line);
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });

      const timer =
        opts.timeoutSeconds > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGTERM");
            }, opts.timeoutSeconds * 1000)
          : undefined;

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        this.active.delete(key);
        this.active.delete(chatId!);
        if (stopped) {
          resolve({ status: "stopped", chatId, text: extractAssistantText(lines), exitCode: code, stderr });
          return;
        }
        if (timedOut) {
          resolve({ status: "timeout", chatId, text: extractAssistantText(lines), exitCode: code, stderr });
          return;
        }
        const text = extractAssistantText(lines);
        if (code !== 0 && !text) {
          resolve({ status: "error", chatId, text: stderr.trim() || `agent exited ${code}`, exitCode: code, stderr });
          return;
        }
        resolve({ status: "ok", chatId, text, exitCode: code, stderr });
      });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        this.active.delete(key);
        this.active.delete(chatId!);
        resolve({ status: "error", chatId, text: String(err), exitCode: null, stderr });
      });

      (child as ActiveChild).__markStopped = () => {
        stopped = true;
      };
    });
  }

  stop(key: string): boolean {
    const child = this.active.get(key);
    if (!child) return false;
    child.__markStopped?.();
    child.kill("SIGTERM");
    return true;
  }
}
