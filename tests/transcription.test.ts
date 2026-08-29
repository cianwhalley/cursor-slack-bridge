import { describe, expect, it, vi } from "vitest";
import { isTranscribableAudio, transcribeAudioBuffer } from "../src/transcription.js";

describe("isTranscribableAudio", () => {
  it("treats Slack voice and audio mime as transcribable", () => {
    expect(isTranscribableAudio({ mimetype: "audio/webm", name: "audio_message.webm" })).toBe(true);
    expect(isTranscribableAudio({ subtype: "slack_audio", name: "voice" })).toBe(true);
    expect(isTranscribableAudio({ mimetype: "application/pdf", name: "a.pdf" })).toBe(false);
  });
});

describe("transcribeAudioBuffer", () => {
  it("prepends [Voice message] from OpenRouter", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ text: "  hello from a note  " }),
    })) as unknown as typeof fetch;

    const text = await transcribeAudioBuffer(Buffer.from("abc"), {
      openRouterApiKey: "test-key",
      filename: "clip.m4a",
      fetchImpl,
    });
    expect(text).toBe("[Voice message]: hello from a note");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("openrouter.ai");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer test-key",
    });
  });

  it("returns unavailable when no key and no vault proxy", async () => {
    const prevOr = process.env.OPENROUTER_API_KEY;
    const prevOa = process.env.OPENAI_API_KEY;
    const prevProxy = process.env.HTTPS_PROXY;
    const prevTok = process.env.AGENT_VAULT_TOKEN;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.HTTPS_PROXY;
    delete process.env.AGENT_VAULT_TOKEN;
    try {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const text = await transcribeAudioBuffer(Buffer.from("abc"), { fetchImpl });
      expect(text).toMatch(/transcription unavailable/);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (prevOr !== undefined) process.env.OPENROUTER_API_KEY = prevOr;
      if (prevOa !== undefined) process.env.OPENAI_API_KEY = prevOa;
      if (prevProxy !== undefined) process.env.HTTPS_PROXY = prevProxy;
      if (prevTok !== undefined) process.env.AGENT_VAULT_TOKEN = prevTok;
    }
  });
});
