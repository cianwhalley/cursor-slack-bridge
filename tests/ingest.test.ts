import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { ingestSlackFiles } from "../src/slack-files.js";

describe("ingestSlackFiles", () => {
  it("transcribes audio and stages other files", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "inbox-"));
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("audio")) {
        return {
          ok: true,
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        };
      }
      return {
        ok: true,
        arrayBuffer: async () => Buffer.from("%PDF-1.4 mock"),
      };
    }) as unknown as typeof fetch;

    const transcribe = vi.fn(async () => "[Voice message]: lunch at noon");

    const result = await ingestSlackFiles({
      files: [
        {
          name: "audio_message.webm",
          mimetype: "audio/webm",
          url_private: "https://files.slack.com/audio",
        },
        {
          name: "brief.pdf",
          mimetype: "application/pdf",
          url_private: "https://files.slack.com/pdf",
        },
      ],
      botToken: "xoxb-test",
      workspace,
      messageTs: "12.34",
      fetchImpl,
      transcribe,
    });

    expect(result.inboundVoice).toBe(true);
    expect(result.promptAddon).toContain("[Voice message]: lunch at noon");
    expect(result.promptAddon).toMatch(/\[Slack file] name=brief\.pdf path=/);
    const staged = /path=(\S+)/.exec(result.promptAddon)?.[1];
    expect(staged).toBeTruthy();
    expect(await readFile(staged!, "utf8")).toContain("%PDF-1.4");
    expect(transcribe).toHaveBeenCalledOnce();
  });
});
