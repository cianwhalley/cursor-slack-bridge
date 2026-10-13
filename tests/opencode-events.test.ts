import { describe, expect, it } from "vitest";
import {
  isOpenCodeSessionId,
  opencodeEventToCursorLine,
  redactSecrets,
} from "../src/opencode-events.js";
import { extractAssistantText, progressFromStreamLine } from "../src/stream-events.js";

describe("opencode events", () => {
  it("keeps the last assistant text", () => {
    const first = opencodeEventToCursorLine(
      JSON.stringify({
        type: "text",
        sessionID: "ses_abc123",
        part: { type: "text", text: "pong" },
      }),
    );
    expect(first.sessionId).toBe("ses_abc123");
    expect(isOpenCodeSessionId(first.sessionId)).toBe(true);
    expect(isOpenCodeSessionId("pending")).toBe(false);
    const assistant = first.cursorLines.find((line) => line.includes('"assistant"')) ?? "";
    expect(extractAssistantText([assistant])).toBe("pong");
    const progress = progressFromStreamLine(first.cursorLines[1] ?? "");
    expect(progress?.line).toBe("💬 pong");
    expect(progress?.statusPhrase).toBe("is working…");
  });

  it("turns a running bash tool into a progress line", () => {
    const mapped = opencodeEventToCursorLine(
      JSON.stringify({
        type: "tool",
        sessionID: "ses_abc123",
        part: {
          type: "tool",
          tool: "bash",
          state: { status: "running", input: { command: "ls /tmp" } },
        },
      }),
    );
    const progress = progressFromStreamLine(mapped.cursorLines[0] ?? "");
    expect(progress?.kind).toBe("tool");
    expect(progress?.line).toContain("list files");
  });

  it("shows a finished tool by its OpenCode title", () => {
    const mapped = opencodeEventToCursorLine(
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_abc123",
        part: {
          type: "tool",
          tool: "bash",
          state: { status: "completed", title: "hostname", input: { command: "hostname" } },
        },
      }),
    );
    const progress = progressFromStreamLine(mapped.cursorLines[0] ?? "");
    expect(progress?.line).toBe("🛠️ hostname");
    expect(progress?.statusPhrase).toBe("is running hostname");
  });

  it("keeps reasoning out of the reply and shows a short summary", () => {
    const mapped = opencodeEventToCursorLine(
      JSON.stringify({
        type: "reasoning",
        part: { type: "reasoning", text: "Check the host first.\nThen answer." },
      }),
    );
    expect(extractAssistantText(mapped.cursorLines)).toBe("");
    const progress = progressFromStreamLine(mapped.cursorLines[0] ?? "");
    expect(progress?.line).toBe("💭 Check the host first.");
    expect(progress?.statusPhrase).toBe("is thinking…");
  });

  it("strips proxy urls", () => {
    expect(redactSecrets("failed https://user:secret@vault:14322/x")).toBe("failed [url]");
  });
});
