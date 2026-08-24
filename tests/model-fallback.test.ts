import { describe, expect, it } from "vitest";
import {
  AUTO_MODEL,
  agentErrorText,
  autoModeReplyPrefix,
  isUsageLimitError,
  shouldRetryWithAuto,
  switchingToAutoNotice,
  usageLimitReason,
} from "../src/model-fallback.js";

describe("model-fallback", () => {
  it("detects Cursor fast usage limit errors", () => {
    const msg =
      "ActionRequiredError: Increase limits for faster responses You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue.";
    expect(isUsageLimitError(msg)).toBe(true);
    expect(usageLimitReason(msg)).toContain("out of usage");
  });

  it("shouldRetryWithAuto when primary is fast and fallback is auto", () => {
    expect(
      shouldRetryWithAuto({
        primaryModel: "cursor-grok-4.5-high-fast",
        fallbackModel: AUTO_MODEL,
        errorText: "ActionRequiredError: out of usage",
        status: "error",
      }),
    ).toBe(true);
  });

  it("does not retry when already on auto", () => {
    expect(
      shouldRetryWithAuto({
        primaryModel: AUTO_MODEL,
        fallbackModel: AUTO_MODEL,
        errorText: "ActionRequiredError: out of usage",
        status: "error",
      }),
    ).toBe(false);
  });

  it("does not retry unrelated errors", () => {
    expect(
      shouldRetryWithAuto({
        primaryModel: "cursor-grok-4.5-high-fast",
        fallbackModel: AUTO_MODEL,
        errorText: "ENOENT workspace missing",
        status: "error",
      }),
    ).toBe(false);
  });

  it("retries when usage limit appears as ok assistant text", () => {
    expect(
      shouldRetryWithAuto({
        primaryModel: "cursor-grok-4.5-high-fast",
        fallbackModel: AUTO_MODEL,
        errorText: "ActionRequiredError: out of usage",
        status: "ok",
      }),
    ).toBe(true);
  });

  it("formats switching notice", () => {
    expect(switchingToAutoNotice("out of usage")).toContain("Switching to Auto mode");
    expect(autoModeReplyPrefix("out of usage")).toContain("Reply via Auto mode");
  });

  it("agentErrorText merges stderr and text", () => {
    expect(
      agentErrorText({ status: "error", text: "ActionRequiredError: out of usage", stderr: "" }),
    ).toContain("out of usage");
  });
});
