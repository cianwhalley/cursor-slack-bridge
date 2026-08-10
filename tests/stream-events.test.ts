import { describe, expect, it } from "vitest";
import {
  extractAssistantText,
  progressFromStreamLine,
} from "../src/stream-events.js";

describe("extractAssistantText", () => {
  it("uses last assistant bubble, not concatenated result", () => {
    const lines = [
      JSON.stringify({
        type: "thinking",
        subtype: "delta",
        text: "private chain of thought",
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Running hostname now." }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "nanoclaw" }] },
      }),
      JSON.stringify({
        type: "result",
        result: "Running hostname now.nanoclaw",
      }),
    ];
    expect(extractAssistantText(lines)).toBe("nanoclaw");
  });

  it("ignores thinking-only streams", () => {
    expect(
      extractAssistantText([
        JSON.stringify({ type: "thinking", subtype: "delta", text: "hmm" }),
      ]),
    ).toBe("");
  });
});

describe("progressFromStreamLine", () => {
  it("formats shell starts with Cursor description (OC explain)", () => {
    const line = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      tool_call: {
        shellToolCall: {
          args: {
            command: "cd /tmp && export X=1; hostname",
            description: "Get hostname",
          },
        },
      },
    });
    const ev = progressFromStreamLine(line, { detailMode: "explain" });
    expect(ev?.line).toBe("🛠️ Get hostname");
  });

  it("does not surface assistant preamble by default", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "I'll check the registry next." }] },
    });
    expect(progressFromStreamLine(line)).toBeUndefined();
  });
});
