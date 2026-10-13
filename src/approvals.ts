import { SLACK_USER_ID_RE } from "./slack-id.js";
import type { SessionStore } from "./sessions.js";

export const APPROVE_ACTION_ID = "approval_approve";
export const DENY_ACTION_ID = "approval_deny";

export interface ApprovalRequest {
  approver: string;
  summary: string;
}

export function splitApprovalRequest(text: string): { text: string; request?: ApprovalRequest } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let request: ApprovalRequest | undefined;
  for (const line of lines) {
    const match = /^APPROVAL_REQUEST:\s*(\{.*\})\s*$/.exec(line);
    if (!match) {
      kept.push(line);
      continue;
    }
    try {
      const parsed = JSON.parse(match[1]) as { approver?: unknown; summary?: unknown };
      const approver = typeof parsed.approver === "string" ? parsed.approver.trim() : "";
      const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
      if (!SLACK_USER_ID_RE.test(approver) || !summary) continue;
      request = { approver, summary: summary.slice(0, 300) };
    } catch {
      kept.push(line);
    }
  }
  return { text: kept.join("\n").trim(), request };
}

export function approvalBlocks(id: string, summary: string): unknown[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Approval needed*\n${summary}` },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: APPROVE_ACTION_ID,
          value: id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Deny" },
          style: "danger",
          action_id: DENY_ACTION_ID,
          value: id,
        },
      ],
    },
  ];
}

export function approvalResultBlocks(text: string): unknown[] {
  return [{ type: "section", text: { type: "mrkdwn", text } }];
}

export function approvalEventText(input: {
  status: "approved" | "denied";
  approver: string;
  requestId: string;
  summary: string;
}): string {
  return [
    "[approval event]",
    `status: ${input.status}`,
    `approver: ${input.approver}`,
    `request_id: ${input.requestId}`,
    `summary: ${input.summary}`,
  ].join("\n");
}

type ApprovalClickArgs = {
  ack: () => Promise<void>;
  body: unknown;
  action: unknown;
};

export function installApprovalActions(opts: {
  app: { action: (id: string, fn: (args: ApprovalClickArgs) => Promise<void>) => void };
  web: {
    chat: {
      update: (args: {
        channel: string;
        ts: string;
        text: string;
        blocks: unknown[];
      }) => Promise<unknown>;
      postEphemeral: (args: { channel: string; user: string; text: string }) => Promise<unknown>;
    };
  };
  sessions: SessionStore;
  boundApproverId?: string;
  onDecision: (input: {
    originChannelId: string;
    originThreadTs: string;
    approverUserId: string;
    status: "approved" | "denied";
    requestId: string;
    summary: string;
  }) => Promise<void>;
}): void {
  const onClick = async ({ ack, body, action }: ApprovalClickArgs) => {
    await ack();
    const actionId =
      action && typeof action === "object" && "action_id" in action
        ? String((action as { action_id?: string }).action_id || "")
        : "";
    const status =
      actionId === APPROVE_ACTION_ID ? "approved" : actionId === DENY_ACTION_ID ? "denied" : null;
    if (!status) return;
    const clicker =
      body && typeof body === "object" && "user" in body
        ? String((body as { user?: { id?: string } }).user?.id || "")
        : "";
    const requestId =
      action && typeof action === "object" && "value" in action
        ? String((action as { value?: string }).value || "")
        : "";
    const channel =
      body && typeof body === "object" && "channel" in body
        ? String((body as { channel?: { id?: string } }).channel?.id || "")
        : "";
    if (!clicker || !requestId) return;
    if (opts.boundApproverId && clicker !== opts.boundApproverId) {
      if (channel) {
        await opts.web.chat.postEphemeral({
          channel,
          user: clicker,
          text: "You are not the approver for this request.",
        });
      }
      return;
    }
    const result = opts.sessions.consumePendingApproval(requestId, clicker, status);
    if (!result.ok) {
      if (result.reason === "not_approver" && channel) {
        await opts.web.chat.postEphemeral({
          channel,
          user: clicker,
          text: "You are not the approver for this request.",
        });
      }
      return;
    }
    const text =
      status === "approved" ? `Approved by <@${clicker}>.` : `Denied by <@${clicker}>.`;
    if (result.row.approvalChannelId && result.row.approvalMessageTs) {
      await opts.web.chat.update({
        channel: result.row.approvalChannelId,
        ts: result.row.approvalMessageTs,
        text,
        blocks: approvalResultBlocks(text),
      });
    }
    await opts.onDecision({
      originChannelId: result.row.originChannelId,
      originThreadTs: result.row.originThreadTs,
      approverUserId: clicker,
      status,
      requestId: result.row.id,
      summary: result.row.summary,
    });
  };
  opts.app.action(APPROVE_ACTION_ID, onClick);
  opts.app.action(DENY_ACTION_ID, onClick);
}
