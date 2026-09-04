import { describe, expect, it } from "vitest";
import {
  AUTO_MODEL,
  agentErrorText,
  fallbackReplyPrefix,
  isUnavailableModelError,
  isUsageLimitError,
  isTransientModelError,
  parseAvailableModels,
  publicAgentError,
  resolveFallbackChain,
  shouldRetryWithFallback,
  usageLimitReason,
} from "../src/model-fallback.js";

const CHRISTINA_ERR = `Cannot use this model: cursor-grok-4.5-high-fast. Available models: auto, gpt-5.3-codex-low, cursor-grok-4.6-high-fast, cursor-grok-4.6-medium, cursor-grok-4.6-high, claude-sonnet-5-thinking-high, claude-sonnet-5-thinking-xhigh, claude-sonnet-5-high, gpt-5.6-sol-high, gpt-5.6-sol-high-fast, gpt-5.6-sol-medium`;

describe("model-fallback", () => {
  it("detects Cursor fast usage limit errors", () => {
    const msg =
      "ActionRequiredError: Increase limits for faster responses You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue.";
    expect(isUsageLimitError(msg)).toBe(true);
    expect(usageLimitReason(msg)).toContain("out of usage");
  });

  it("detects retired / not-on-account model errors", () => {
    expect(isUnavailableModelError(CHRISTINA_ERR)).toBe(true);
    expect(isTransientModelError(CHRISTINA_ERR)).toBe(false);
  });

  it("retries a usage limit with the configured fallback", () => {
    expect(
      shouldRetryWithFallback({
        primaryModel: "cursor-grok-4.6-high-fast",
        fallbackModel: "gpt-5.6-sol-medium",
        errorText: "ActionRequiredError: out of usage",
        status: "error",
      }),
    ).toBe(true);
  });

  it("does not retry when already on auto with auto as the only hop", () => {
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
        primaryModel: "cursor-grok-4.6-high-fast",
        fallbackModel: AUTO_MODEL,
        errorText: "ENOENT workspace missing",
        status: "error",
      }),
    ).toBe(false);
  });

  it("retries when usage limit appears as ok assistant text", () => {
    expect(
      shouldRetryWithFallback({
        primaryModel: "cursor-grok-4.6-high-fast",
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
        primaryModel: "cursor-grok-4.6-high-fast",
        fallbackModel: "gpt-5.6-sol-medium",
        errorText: "The model is temporarily unavailable",
        status: "error",
      }),
    ).toBe(true);
  });

  it("retries cannot-use-this-model as the same class", () => {
    expect(
      shouldRetryWithFallback({
        primaryModel: "cursor-grok-4.5-high-fast",
        fallbackModel: "latest",
        errorText: CHRISTINA_ERR,
        status: "error",
      }),
    ).toBe(true);
  });

  it("picks latest same-options grok, then sonnet 5, then sol from the catalog list", () => {
    expect(
      resolveFallbackChain({
        primaryModel: "cursor-grok-4.5-high-fast",
        fallbackSpecs: ["latest", "sonnet", "sol"],
        errorText: CHRISTINA_ERR,
      }),
    ).toEqual([
      "cursor-grok-4.6-high-fast",
      "claude-sonnet-5-thinking-high",
      "gpt-5.6-sol-high-fast",
    ]);
  });

  it("skips latest when the primary is already the newest same-options grok", () => {
    expect(
      resolveFallbackChain({
        primaryModel: "cursor-grok-4.6-high-fast",
        fallbackSpecs: ["latest", "sonnet", "sol"],
        errorText: CHRISTINA_ERR,
      }),
    ).toEqual(["claude-sonnet-5-thinking-high", "gpt-5.6-sol-high-fast"]);
  });

  it("uses Auto as Latest when the catalog list is missing", () => {
    expect(
      resolveFallbackChain({
        primaryModel: "cursor-grok-4.6-high-fast",
        fallbackSpecs: ["latest", "sonnet", "sol"],
        errorText: "ActionRequiredError: out of usage",
      }),
    ).toEqual([
      AUTO_MODEL,
      "claude-sonnet-5-thinking-high-fast",
      "gpt-5.6-sol-high-fast",
    ]);
  });

  it("matches tick medium options onto sonnet and sol", () => {
    const err = `Cannot use this model: cursor-grok-4.5-medium. Available models: cursor-grok-4.6-medium, claude-sonnet-5-thinking-medium, gpt-5.6-sol-medium, gpt-5.6-sol-high`;
    expect(
      resolveFallbackChain({
        primaryModel: "cursor-grok-4.5-medium",
        fallbackSpecs: ["latest", "sonnet", "sol"],
        errorText: err,
      }),
    ).toEqual([
      "cursor-grok-4.6-medium",
      "claude-sonnet-5-thinking-medium",
      "gpt-5.6-sol-medium",
    ]);
  });

  it("honors an explicit single fallback id", () => {
    expect(
      resolveFallbackChain({
        primaryModel: "cursor-grok-4.6-high-fast",
        fallbackSpecs: ["gpt-5.6-sol-medium"],
        errorText: "The requested model is temporarily unavailable",
      }),
    ).toEqual(["gpt-5.6-sol-medium"]);
  });

  it("returns no hops when fallback is off", () => {
    expect(
      resolveFallbackChain({
        primaryModel: "cursor-grok-4.6-high-fast",
        fallbackSpecs: [],
        errorText: CHRISTINA_ERR,
      }),
    ).toEqual([]);
  });

  it("parses the available-models list", () => {
    expect(parseAvailableModels(CHRISTINA_ERR)).toContain("cursor-grok-4.6-high-fast");
    expect(parseAvailableModels(CHRISTINA_ERR)).toContain("auto");
  });

  it("strips the catalog dump from Slack-facing errors", () => {
    expect(publicAgentError(CHRISTINA_ERR)).toBe(
      "Cannot use this model: cursor-grok-4.5-high-fast (not on this account / retired)",
    );
    expect(publicAgentError(CHRISTINA_ERR)).not.toContain("Available models");
  });

  it("names a configured fallback in Slack", () => {
    expect(fallbackReplyPrefix("provider degraded", "gpt-5.6-sol-medium")).toContain(
      "Reply via GPT Sol",
    );
    expect(fallbackReplyPrefix("out of usage", AUTO_MODEL)).toContain("Reply via Auto");
    expect(fallbackReplyPrefix("pinned model is not available", "cursor-grok-4.6-high-fast")).toContain(
      "Reply via Grok 4.6",
    );
    expect(
      fallbackReplyPrefix("pinned model is not available", "claude-sonnet-5-thinking-high"),
    ).toContain("Reply via Sonnet 5");
  });

  it("agentErrorText merges stderr and text", () => {
    expect(
      agentErrorText({ status: "error", text: "ActionRequiredError: out of usage", stderr: "" }),
    ).toContain("out of usage");
  });
});
