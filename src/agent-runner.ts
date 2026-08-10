import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

type ActiveChild = ChildProcess & { __markStopped?: () => void };

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

function runCapture(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutSeconds: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer =
      timeoutSeconds > 0
        ? setTimeout(() => {
            child.kill("SIGTERM");
          }, timeoutSeconds * 1000)
        : undefined;
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

function extractAssistantText(streamJsonLines: string[]): string {
  const parts: string[] = [];
  for (const line of streamJsonLines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed) as {
        type?: string;
        message?: { role?: string; content?: unknown };
        content?: string;
        text?: string;
        result?: string;
      };
      if (obj.type === "assistant" && obj.message?.content) {
        const c = obj.message.content;
        if (typeof c === "string") parts.push(c);
        else if (Array.isArray(c)) {
          for (const block of c) {
            if (block && typeof block === "object" && "text" in block) {
              parts.push(String((block as { text: string }).text));
            }
          }
        }
      } else if (obj.type === "result" && typeof obj.result === "string") {
        parts.push(obj.result);
      } else if (typeof obj.text === "string" && obj.type === "assistant") {
        parts.push(obj.text);
      }
    } catch {
      // ignore non-json
    }
  }
  // Prefer last substantial assistant aggregation
  const joined = parts.join("").trim();
  if (joined) return joined;
  // Fallback: last non-empty plain lines that aren't json
  const plain = streamJsonLines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("{"))
    .join("\n")
    .trim();
  return plain;
}

export class CursorAgentRunner implements AgentRunner {
  private readonly active = new Map<string, ActiveChild>();

  async createChat(agentBin: string, workspace: string, cursorApiKey?: string): Promise<string> {
    const env = { ...process.env };
    if (cursorApiKey) env.CURSOR_API_KEY = cursorApiKey;
    const { stdout, stderr, code } = await runCapture(
      agentBin,
      ["create-chat", "--workspace", workspace, "--trust", "--force"],
      env,
      60,
    );
    const chatId = stdout.trim().split(/\s+/)[0];
    if (code !== 0 || !chatId) {
      throw new Error(`create-chat failed: ${stderr || stdout || `exit ${code}`}`);
    }
    return chatId;
  }

  async runPrompt(opts: RunPromptOptions): Promise<RunPromptResult> {
    const key = opts.chatId ?? "new";
    const env = { ...process.env };
    if (opts.cursorApiKey) env.CURSOR_API_KEY = opts.cursorApiKey;

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
      const child = spawn(opts.agentBin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
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
