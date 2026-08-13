import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { _testing } from "../src/config.js";
import {
  bridgeHelpText,
  isBridgeCommand,
  shouldEngage,
  stripBotMention,
  type ThreadParticipationStore,
} from "../src/policy.js";

const bot = "U_BOT";

function config(over: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    slackBotToken: "xoxb",
    slackAppToken: "xapp",
    cursorApiKey: undefined,
    agentBin: "agent",
    workspace: "/tmp/ws",
    sessionDb: "/tmp/s.db",
    dmPolicy: "allowlist",
    allowedUserIds: new Set(["U_ALLOW"]),
    channelPolicy: "configured",
    alertChannels: new Set(["C_SYSOPS"]),
    openChannels: new Set(),
    typingReaction: "hourglass_flowing_sand",
    textChunkLimit: 3500,
    streamingMode: "off",
    draftDelaySeconds: 0,
    statusKeepaliveSeconds: 90,
    maxProgressLines: 8,
    maxLineChars: 120,
    progressLabel: "Working",
    toolProgressDetail: "explain",
    progressCommandText: "raw",
    progressCommentary: false,
    sessionTimeoutSeconds: 900,
    botUserId: bot,
    ...over,
  };
}

function memParticipation(initial: Array<[string, string]> = []): ThreadParticipationStore {
  const set = new Set(initial.map(([c, t]) => `${c}:${t}`));
  return {
    hasParticipated: (c, t) => set.has(`${c}:${t}`),
    markParticipated: (c, t) => {
      set.add(`${c}:${t}`);
    },
  };
}

describe("config ID parsing", () => {
  it("rejects name-based allowlist entries", () => {
    expect(() => _testing.parseIdList("cian", "ALLOWED_USER_IDS")).toThrow(/invalid Slack ID/);
  });

  it("accepts canonical IDs", () => {
    const s = _testing.parseIdList("U0123456789,C0123456789", "ALLOWED_USER_IDS");
    expect(s.has("U0123456789")).toBe(true);
    expect(s.has("C0123456789")).toBe(true);
  });
});

describe("shouldEngage", () => {
  it("engages DM from allowlisted user", () => {
    const d = shouldEngage(
      { channel: "D123", channel_type: "im", user: "U_ALLOW", text: "hello", ts: "1.0" },
      config(),
      memParticipation(),
    );
    expect(d.engage).toBe(true);
    if (d.engage) expect(d.isDm).toBe(true);
  });

  it("ignores DM from non-allowlisted user", () => {
    const d = shouldEngage(
      { channel: "D123", user: "U_OTHER", text: "hello", ts: "1.0" },
      config(),
      memParticipation(),
    );
    expect(d).toEqual({ engage: false, reason: "dm_not_allowlisted" });
  });

  it("ignores bot messages and own bot_id", () => {
    expect(
      shouldEngage(
        { channel: "D123", user: "U_ALLOW", text: "x", ts: "1", bot_id: "B1" },
        config(),
        memParticipation(),
      ).engage,
    ).toBe(false);
    expect(
      shouldEngage(
        { channel: "D123", user: "U_ALLOW", text: "x", ts: "1", subtype: "bot_message" },
        config(),
        memParticipation(),
      ).engage,
    ).toBe(false);
    expect(
      shouldEngage(
        { channel: "D123", user: bot, text: "x", ts: "1" },
        config(),
        memParticipation(),
      ).engage,
    ).toBe(false);
  });

  it("ignores channel message without @bot", () => {
    const d = shouldEngage(
      { channel: "C_SYSOPS", user: "U_ALLOW", text: "hello", ts: "1.0" },
      config(),
      memParticipation(),
    );
    expect(d).toEqual({ engage: false, reason: "mention_required" });
  });

  it("engages channel @mention on root and sets thread_ts to message ts", () => {
    const d = shouldEngage(
      { channel: "C_SYSOPS", user: "U_ALLOW", text: `<@${bot}> fix oauth`, ts: "99.1" },
      config(),
      memParticipation(),
    );
    expect(d.engage).toBe(true);
    if (d.engage) {
      expect(d.threadTs).toBe("99.1");
      expect(d.text).toBe("fix oauth");
    }
  });

  it("engages reply in already-participated thread without mention", () => {
    const d = shouldEngage(
      {
        channel: "C_SYSOPS",
        user: "U_ALLOW",
        text: "follow up",
        ts: "100.1",
        thread_ts: "99.1",
      },
      config(),
      memParticipation([["C_SYSOPS", "99.1"]]),
    );
    expect(d.engage).toBe(true);
  });

  it("ignores reply in never-engaged thread without mention", () => {
    const d = shouldEngage(
      {
        channel: "C_SYSOPS",
        user: "U_ALLOW",
        text: "follow up",
        ts: "100.1",
        thread_ts: "99.1",
      },
      config(),
      memParticipation(),
    );
    expect(d).toEqual({ engage: false, reason: "mention_required" });
  });

  it("ignores unconfigured channels", () => {
    const d = shouldEngage(
      { channel: "C_OTHER", user: "U_ALLOW", text: `<@${bot}> hi`, ts: "1" },
      config(),
      memParticipation(),
    );
    expect(d).toEqual({ engage: false, reason: "channel_not_configured" });
  });

  it("ignores channel @mention from a user not on the allowlist", () => {
    const d = shouldEngage(
      { channel: "C_SYSOPS", user: "U_OTHER", text: `<@${bot}> pwn`, ts: "1" },
      config(),
      memParticipation(),
    );
    expect(d).toEqual({ engage: false, reason: "user_not_allowlisted" });
  });

  it("ignores thread follow-up from a user not on the allowlist", () => {
    const d = shouldEngage(
      {
        channel: "C_SYSOPS",
        user: "U_OTHER",
        text: "follow up",
        ts: "100.1",
        thread_ts: "99.1",
      },
      config(),
      memParticipation([["C_SYSOPS", "99.1"]]),
    );
    expect(d).toEqual({ engage: false, reason: "user_not_allowlisted" });
  });

  it("CHANNEL_POLICY=any engages allowlisted @mention outside ALERT_CHANNELS", () => {
    const d = shouldEngage(
      { channel: "C_RANDOM", user: "U_ALLOW", text: `<@${bot}> hi`, ts: "1" },
      config({ channelPolicy: "any" }),
      memParticipation(),
    );
    expect(d.engage).toBe(true);
  });

  it("CHANNEL_POLICY=any still ignores non-allowlisted users", () => {
    const d = shouldEngage(
      { channel: "C_RANDOM", user: "U_OTHER", text: `<@${bot}> hi`, ts: "1" },
      config({ channelPolicy: "any" }),
      memParticipation(),
    );
    expect(d).toEqual({ engage: false, reason: "user_not_allowlisted" });
  });

  it("ignores empty text / missing channel", () => {
    expect(
      shouldEngage({ channel: "D1", user: "U_ALLOW", text: "  ", ts: "1" }, config(), memParticipation())
        .reason,
    ).toBe("empty_text");
    expect(
      shouldEngage({ user: "U_ALLOW", text: "hi", ts: "1" }, config(), memParticipation()).reason,
    ).toBe("missing_channel_or_ts");
  });
});

describe("helpers", () => {
  it("stripBotMention", () => {
    expect(stripBotMention(`<@${bot}> hello`, bot)).toBe("hello");
  });

  it("isBridgeCommand", () => {
    expect(isBridgeCommand("ping")).toBe("ping");
    expect(isBridgeCommand("stop")).toBe("stop");
    expect(isBridgeCommand("help")).toBe("help");
    expect(isBridgeCommand("?")).toBe("help");
    expect(isBridgeCommand("hello")).toBeNull();
  });

  it("bridgeHelpText names the workspace and commands", () => {
    const text = bridgeHelpText({
      workspace: "/ws",
      dmPolicy: "allowlist",
      channelPolicy: "any",
    });
    expect(text).toContain("`/ws`");
    expect(text).toContain("`ping`");
    expect(text).toContain("`stop`");
    expect(text).toContain("`help`");
  });
});
