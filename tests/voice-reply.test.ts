import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isAllowedVoicePath, splitVoiceReply } from "../src/voice-reply.js";

describe("splitVoiceReply", () => {
  it("strips the trailer and keeps the caption", () => {
    const r = splitVoiceReply("Short caption\nVOICE_REPLY: /tmp/cache/voice-note/a.mp3\n");
    expect(r.caption).toBe("Short caption");
    expect(r.voicePath).toBe("/tmp/cache/voice-note/a.mp3");
  });

  it("uses the last VOICE_REPLY line", () => {
    const r = splitVoiceReply("hi\nVOICE_REPLY: /a.mp3\nVOICE_REPLY: /b.mp3");
    expect(r.voicePath).toBe("/b.mp3");
    expect(r.caption).toBe("hi");
  });
});

describe("isAllowedVoicePath", () => {
  it("allows workspace and ~/.cache mp3s only", () => {
    const ws = "/tmp/hub-ws";
    expect(isAllowedVoicePath(join(ws, "out.mp3"), ws, "/home/agent")).toBe(true);
    expect(isAllowedVoicePath("/home/agent/.cache/voice-note/x.mp3", ws, "/home/agent")).toBe(true);
    expect(isAllowedVoicePath("/etc/passwd.mp3", ws, "/home/agent")).toBe(false);
    expect(isAllowedVoicePath(join(ws, "out.wav"), ws, "/home/agent")).toBe(false);
    expect(isAllowedVoicePath(join(ws, "..", "escape.mp3"), ws, homedir())).toBe(false);
  });
});
