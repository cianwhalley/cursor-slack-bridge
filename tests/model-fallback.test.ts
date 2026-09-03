import { describe, expect, it } from "vitest";
import {
  AUTO_MODEL,
  agentErrorText,
  fallbackReplyPrefix,
  isUsageLimitError,
  isTransientModelError,
  shouldRetryWithFallback,
  usageLimitReason,
} from "../src/model-fallback.js";

describe("model-fallback", () => {
  it("detects Cursor fast usage limit errors", () => {
    const msg =
      "ActionRequiredError: Increase limits for faster responses You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue.";
    expect(isUsageLimitError(msg)).toBe(true);
    expect(usageLimitReason(msg)).toContain("out of usage");
  });

  it("retries a usage limit with the configured fallback", () => {
    expect(
      shouldRetryWithFallback({
        primaryModel: "cursor-grok-4.5-high-fast",
        fallbackModel: "gpt-5.6-sol-medium",
        errorText: "ActionRequiredError: out of usage",
        status: "error",
      }),
    ).toBe(true);
  });

  it("does not retry when already on auto", () => {
    expect(
      shouldRetryWithFallback({
        primaryModel: AUTO_MODEL,
        fallbackModel: AUTO_MODEL,
        errorText: "ActionRequiredError: out of usage",
        status: "error",
      }),
    ).toBe(false);
  });

  it("does not retry unrelated errors", () => {
    expect(
      shouldRetryWithFallback({
        primaryModel: "cursor-grok-4.5-high-fast",
        fallbackModel: AUTO_MODEL,
        errorText: "ENOENT workspace missing",
        status: "error",
      }),
    ).toBe(false);
  });

  it("retries when usage limit appears as ok assistant text", () => {
    expect(
      shouldRetryWithFallback({
        primaryModel: "cursor-grok-4.5-high-fast",
        fallbackModel: AUTO_MODEL,
        errorText: "ActionRequiredError: out of usage",
        status: "ok",
      }),
    ).toBe(true);
  });

  it("retries transient provider degradation", () => {
    expect(isTransientModelError("Model is temporarily unavailable")).toBe(true);
    expect(
      shouldRetryWithFallback({
        primaryModel: "cursor-grok-4.5-high-fast",
        fallbackModel: "gpt-5.6-sol-medium",
        errorText: "The model is temporarily unavailable",
        status: "error",
      }),
    ).toBe(true);
  });

  it("names a configured fallback in Slack", () => {
    expect(fallbackReplyPrefix("provider degraded", "gpt-5.6-sol-medium")).toContain(
      "Reply via GPT-5.6 Sol",
    );
    expect(fallbackReplyPrefix("out of usage", AUTO_MODEL)).toContain("Reply via Auto");
  });

  it("agentErrorText merges stderr and text", () => {
    expect(
      agentErrorText({ status: "error", text: "ActionRequiredError: out of usage", stderr: "" }),
    ).toContain("out of usage");
  });
});
