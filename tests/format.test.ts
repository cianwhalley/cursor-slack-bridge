import { describe, expect, it } from "vitest";
import { buildPrompt, chunkText, stripBotMention } from "../src/format.js";

describe("format", () => {
  it("chunks under limit on newlines", () => {
    const text = ("line\n").repeat(80) + "end";
    const chunks = chunkText(text, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(120);
    }
    expect(chunks.join("\n")).toContain("end");
  });

  it("strips bot mention", () => {
    expect(stripBotMention("<@UBOT> hi", "UBOT")).toBe("hi");
  });

  it("buildPrompt prefixes", () => {
    expect(buildPrompt("[slack dm]", "hello")).toContain("[slack dm]");
    expect(buildPrompt("[slack dm]", "hello")).toContain("hello");
  });
});
