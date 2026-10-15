import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clipMemoryIndex, loadTurnMemory } from "../src/memory-context.js";

describe("loadTurnMemory", () => {
  it("loads the team index and only this speaker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-"));
    await mkdir(join(dir, "people"), { recursive: true });
    await writeFile(join(dir, "MEMORY.md"), "- Preview branch — rustam/development (topics/preview.md)\n");
    await writeFile(join(dir, "people", "U0A2X8KUGG3.md"), "Bart likes short replies.\n");
    await writeFile(join(dir, "people", "U0A31JRRAGN.md"), "Cian approves merges.\n");

    const text = await loadTurnMemory(dir, "U0A2X8KUGG3");
    expect(text).toContain("never override policies/authorization.md");
    expect(text).toContain("rustam/development");
    expect(text).toContain("Bart likes short replies.");
    expect(text).not.toContain("Cian approves merges.");
  });

  it("clips the index at 200 lines and 25KB", () => {
    const lines = Array.from({ length: 250 }, (_, i) => `- fact ${i}`);
    const clipped = clipMemoryIndex(lines.join("\n"));
    expect(clipped.split("\n")).toHaveLength(200);

    const wide = "x".repeat(30_000);
    const byBytes = clipMemoryIndex(wide, 200, 25 * 1024);
    expect(Buffer.byteLength(byBytes, "utf8")).toBeLessThanOrEqual(25 * 1024);
  });

  it("still reminds about policy when the directory is missing", async () => {
    const text = await loadTurnMemory(join(tmpdir(), "missing-ethan-memory"), "not a slack id");
    expect(text).toContain("[memory]");
    expect(text).not.toContain("Speaker notes");
    expect(text).not.toContain("Team index");
  });
});
