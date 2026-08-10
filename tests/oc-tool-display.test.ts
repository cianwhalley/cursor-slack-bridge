import { describe, expect, it } from "vitest";
import {
  formatOcToolProgressLine,
  stripShellPreamble,
  truncateProgressLine,
} from "../src/oc-tool-display.js";

describe("oc-tool-display", () => {
  it("strips cd/export preamble like OpenClaw", () => {
    expect(
      stripShellPreamble(
        "cd /home/cursor-agent/workspaces/cleo-agent && export FOO=bar; hostname",
      ),
    ).toBe("hostname");
  });

  it("prefers Cursor description in explain mode (shell = emoji + detail)", () => {
    const line = formatOcToolProgressLine(
      "shellToolCall",
      {
        args: {
          command: "ls -la schedules/registry.yaml && head -n 5 schedules/registry.yaml",
          description: "List registry.yaml and show first 5 lines",
        },
      },
      { detailMode: "explain" },
    );
    expect(line).toBe("🛠️ List registry.yaml and show first 5 lines");
  });

  it("commandText=status hides shell detail", () => {
    const line = formatOcToolProgressLine(
      "shellToolCall",
      { args: { command: "hostname", description: "Get hostname" } },
      { commandText: "status" },
    );
    expect(line).toBe("🛠️ Bash");
  });

  it("formats read paths OpenClaw-style", () => {
    const line = formatOcToolProgressLine(
      "readToolCall",
      { args: { path: "/home/cursor-agent/workspaces/cleo-agent/schedules/registry.yaml" } },
      { detailMode: "explain" },
    );
    expect(line).toBe("📖 Read: from ~/workspaces/cleo-agent/schedules/registry.yaml");
  });

  it("truncates long lines with middle ellipsis", () => {
    const long = "a".repeat(200);
    const t = truncateProgressLine(long, 20);
    expect(t.length).toBe(20);
    expect(t).toContain("…");
  });
});
