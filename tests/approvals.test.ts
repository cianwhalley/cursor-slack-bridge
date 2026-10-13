import { describe, expect, it } from "vitest";
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  approvalBlocks,
  splitApprovalRequest,
} from "../src/approvals.js";

describe("approval trailer", () => {
  it("parses a valid trailer and strips it", () => {
    const parsed = splitApprovalRequest(
      'Please confirm.\nAPPROVAL_REQUEST: {"approver":"U0A31JRRAGN","summary":"wipe user ada"}\n',
    );
    expect(parsed.text).toBe("Please confirm.");
    expect(parsed.request).toEqual({ approver: "U0A31JRRAGN", summary: "wipe user ada" });
  });

  it("ignores a name that is not a Slack user id", () => {
    const parsed = splitApprovalRequest('APPROVAL_REQUEST: {"approver":"cian","summary":"wipe"}');
    expect(parsed.request).toBeUndefined();
    expect(parsed.text).toBe("");
  });

  it("puts the request id on both buttons", () => {
    const blocks = approvalBlocks("req-1", "wipe user ada") as Array<{
      elements?: Array<{ action_id?: string; value?: string }>;
    }>;
    const buttons = blocks[1]?.elements ?? [];
    expect(buttons.map((b) => b.action_id)).toEqual([APPROVE_ACTION_ID, DENY_ACTION_ID]);
    expect(buttons.every((b) => b.value === "req-1")).toBe(true);
  });
});
