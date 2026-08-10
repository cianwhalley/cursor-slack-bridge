import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessions.js";

const stores: SessionStore[] = [];

afterEach(() => {
  while (stores.length) stores.pop()?.close();
});

function open(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), "csb-"));
  const s = new SessionStore(join(dir, "t.db"));
  stores.push(s);
  return s;
}

describe("SessionStore", () => {
  it("shares one Cursor chat for DM main key", () => {
    const s = open();
    const { channelId, threadKey } = s.sessionKey(true, "D1", "1.0");
    expect(threadKey).toBe("main");
    s.upsert(channelId, threadKey, "chat-a", "slack:dm");
    const again = s.sessionKey(true, "D1", "2.0");
    expect(s.get(again.channelId, again.threadKey)?.cursorChatId).toBe("chat-a");
  });

  it("gives distinct chats per channel thread", () => {
    const s = open();
    s.upsert("C1", "10.0", "chat-1", "l1");
    s.upsert("C1", "20.0", "chat-2", "l2");
    expect(s.get("C1", "10.0")?.cursorChatId).toBe("chat-1");
    expect(s.get("C1", "20.0")?.cursorChatId).toBe("chat-2");
  });

  it("resumes same chat for same channel+thread", () => {
    const s = open();
    const k = s.sessionKey(false, "C_SYSOPS", "99.1");
    s.upsert(k.channelId, k.threadKey, "chat-x", "slack:C_SYSOPS:99.1");
    expect(s.get("C_SYSOPS", "99.1")?.cursorChatId).toBe("chat-x");
  });

  it("tracks participation for thread continue", () => {
    const s = open();
    expect(s.hasParticipated("C1", "1")).toBe(false);
    s.markParticipated("C1", "1");
    expect(s.hasParticipated("C1", "1")).toBe(true);
  });
});
