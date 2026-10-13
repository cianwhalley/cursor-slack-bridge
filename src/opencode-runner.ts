import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { extractAssistantText } from "./stream-events.js";
import {
  isOpenCodeSessionId,
  OPENCODE_NEW_SESSION,
  opencodeEventToCursorLine,
  redactSecrets,
} from "./opencode-events.js";
import type { AgentRunner, RunPromptOptions, RunPromptResult } from "./agent-runner.js";

type ActiveChild = ChildProcess & { __markStopped?: () => void };

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.SLACK_BOT_TOKEN;
  delete env.SLACK_APP_TOKEN;
  delete env.CURSOR_API_KEY;
  if (!env.XAI_API_KEY?.trim()) env.XAI_API_KEY = "dummy";
  return env;
}

/**
 * OpenCode harness. Slack session ids are `ses_…` values from `opencode run`.
 * A missing id starts a new session; the real id is returned for the thread store.
 * The process keeps HTTPS_PROXY so a vault can inject the model key.
 */
export class OpenCodeAgentRunner implements AgentRunner {
  private readonly active = new Map<string, ActiveChild>();

  async createChat(): Promise<string> {
    return OPENCODE_NEW_SESSION;
  }

  async runPrompt(opts: RunPromptOptions): Promise<RunPromptResult> {
    const resume = isOpenCodeSessionId(opts.chatId) ? opts.chatId : undefined;
    const key = resume ?? "new";
    const args = ["run", "--dir", opts.workspace, "--pure", "--format", "json"];
    if (opts.model) args.push("--model", opts.model);
    if (resume) args.push("--session", resume);
    args.push(opts.prompt);

    return new Promise((resolve) => {
      const child = spawn(opts.agentBin, args, {
        env: childEnv(),
        cwd: opts.workspace,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.active.set(key, child);
      if (resume) this.active.set(resume, child);

      const cursorLines: string[] = [];
      let sessionId = resume;
      let stderr = "";
      let stopped = false;
      let timedOut = false;

      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        const mapped = opencodeEventToCursorLine(line);
        if (isOpenCodeSessionId(mapped.sessionId)) {
          sessionId = mapped.sessionId;
          this.active.set(mapped.sessionId, child);
        }
        for (const cursorLine of mapped.cursorLines) {
          cursorLines.push(cursorLine);
          opts.onStdoutLine?.(cursorLine);
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += redactSecrets(d.toString());
      });

      const timer =
        opts.timeoutSeconds > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGTERM");
            }, opts.timeoutSeconds * 1000)
          : undefined;

      const finish = (status: RunPromptResult["status"], text: string, code: number | null) => {
        if (timer) clearTimeout(timer);
        this.active.delete(key);
        if (resume) this.active.delete(resume);
        if (sessionId) this.active.delete(sessionId);
        resolve({ status, chatId: sessionId, text, exitCode: code, stderr });
      };

      child.on("close", (code) => {
        const text = extractAssistantText(cursorLines);
        if (stopped) {
          finish("stopped", text, code);
          return;
        }
        if (timedOut) {
          finish("timeout", text, code);
          return;
        }
        if (code !== 0 && !text) {
          finish("error", stderr.trim() || `opencode exited ${code}`, code);
          return;
        }
        finish("ok", text, code);
      });

      child.on("error", (err) => {
        finish("error", redactSecrets(String(err)), null);
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
