import { describe, expect, it } from "vitest";
import {
  dropRowHidePrimary,
  parseBlockActionsConfig,
} from "../src/block-actions.js";

describe("parseBlockActionsConfig", () => {
  it("requires groups", () => {
    expect(() => parseBlockActionsConfig({})).toThrow(/groups/);
  });

  it("parses a minimal group", () => {
    const cfg = parseBlockActionsConfig({
      groups: [
        {
          id: "g1",
          script: "skills/x/run.sh",
          secondaryActionId: "discard",
          primaryActionId: "send_all",
          secondaryArgs: ["--id", "{{value}}"],
          primaryArgs: ["--action", "send_all"],
        },
      ],
    });
    expect(cfg.groups).toHaveLength(1);
    expect(cfg.groups[0].optimisticSecondary).toBe("drop_row_hide_primary");
  });
});

describe("dropRowHidePrimary", () => {
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: "<@U1> Items (2)" } },
    {
      type: "section",
      text: { type: "mrkdwn", text: "1. Alpha" },
      accessory: {
        type: "button",
        action_id: "discard",
        value: "a",
        text: { type: "plain_text", text: "Trash" },
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "2. Beta" },
      accessory: {
        type: "button",
        action_id: "discard",
        value: "b",
        text: { type: "plain_text", text: "Trash" },
      },
    },
    {
      type: "actions",
      elements: [{ type: "button", action_id: "send_all", value: "all" }],
    },
  ];

  it("removes the row and hides primary", () => {
    const out = dropRowHidePrimary(blocks, {
      rowActionId: "discard",
      removeValue: "a",
      busyHeaderTemplate: "{{mention}} Items ({{count}})",
      busyContext: "_Working…_",
      emptyBusyText: "{{mention}} empty",
      rowButtonLabel: "Trash",
    });
    expect(out).not.toBeNull();
    expect(out!.text).toContain("Items (1)");
    const aids: string[] = [];
    for (const b of out!.blocks) {
      if (b.type === "actions") aids.push("actions");
      const acc = b.accessory as { action_id?: string; value?: string } | undefined;
      if (acc?.action_id) aids.push(`${acc.action_id}:${acc.value}`);
    }
    expect(aids).toEqual(["discard:b"]);
    expect(out!.blocks.some((b) => b.type === "context")).toBe(true);
  });

  it("handles last row", () => {
    const one = [blocks[0], blocks[1], blocks[3]];
    const out = dropRowHidePrimary(one, {
      rowActionId: "discard",
      removeValue: "a",
      busyHeaderTemplate: "{{mention}} Items ({{count}})",
      busyContext: "_Working…_",
      emptyBusyText: "{{mention}} discarding last",
      rowButtonLabel: "Trash",
    });
    expect(out!.text).toContain("discarding last");
    expect(out!.blocks.every((b) => b.type !== "actions")).toBe(true);
  });
});
