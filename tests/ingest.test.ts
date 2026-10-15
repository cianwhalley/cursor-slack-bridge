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

  it("keeps the bot token on a Slack file redirect and drops it off Slack", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "inbox-"));
    const seen: { url: string; auth: string | null }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(url), auth: headers.get("authorization") });
      if (String(url).endsWith("/audio")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://files-origin.slack.com/files-pri/audio.m4a" },
        });
      }
      if (String(url).includes("files-origin.slack.com")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/signed-audio" },
        });
      }
      return new Response(new Uint8Array([9, 9, 9]));
    }) as unknown as typeof fetch;

    const result = await ingestSlackFiles({
      files: [
        {
          name: "audio_message.m4a",
          mimetype: "audio/mp4",
          url_private_download: "https://files.slack.com/audio",
        },
      ],
      botToken: "xoxb-test",
      workspace,
      messageTs: "12.35",
      fetchImpl,
      transcribe: async () => "[Voice message]: heard",
    });

    expect(result.inboundVoice).toBe(true);
    expect(seen.map((hop) => hop.auth)).toEqual([
      "Bearer xoxb-test",
      "Bearer xoxb-test",
      null,
    ]);
  });
});
