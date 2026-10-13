import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ThreadParticipationStore } from "./policy.js";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface PendingApproval {
  id: string;
  originChannelId: string;
  originThreadTs: string;
  requesterUserId: string;
  approverUserId: string;
  summary: string;
  status: ApprovalStatus;
  approvalChannelId: string | undefined;
  approvalMessageTs: string | undefined;
  createdAt: string;
  expiresAt: string;
}

export type ConsumeApprovalResult =
  | { ok: true; row: PendingApproval }
  | { ok: false; reason: "unknown" | "consumed" | "expired" | "not_approver"; row?: PendingApproval };

export interface SessionRow {
  channelId: string;
  threadKey: string;
  cursorChatId: string;
  label: string;
  createdAt: string;
  lastActiveAt: string;
}

export class SessionStore implements ThreadParticipationStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        channel_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        cursor_chat_id TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, thread_key)
      );
      CREATE TABLE IF NOT EXISTS participation (
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        PRIMARY KEY (channel_id, thread_ts)
      );
      CREATE TABLE IF NOT EXISTS pending_approvals (
        id TEXT PRIMARY KEY,
        origin_channel_id TEXT NOT NULL,
        origin_thread_ts TEXT NOT NULL,
        requester_user_id TEXT NOT NULL,
        approver_user_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        approval_channel_id TEXT,
        approval_message_ts TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** One Cursor chat per Slack thread (DMs and channels). */
  sessionKey(_isDm: boolean, channelId: string, threadTs: string): { channelId: string; threadKey: string } {
    return { channelId, threadKey: threadTs };
  }

  get(channelId: string, threadKey: string): SessionRow | undefined {
    const row = this.db
      .prepare(
        `SELECT channel_id, thread_key, cursor_chat_id, label, created_at, last_active_at
         FROM sessions WHERE channel_id = ? AND thread_key = ?`,
      )
      .get(channelId, threadKey) as
      | {
          channel_id: string;
          thread_key: string;
          cursor_chat_id: string;
          label: string;
          created_at: string;
          last_active_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      channelId: row.channel_id,
      threadKey: row.thread_key,
      cursorChatId: row.cursor_chat_id,
      label: row.label,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    };
  }

  upsert(channelId: string, threadKey: string, cursorChatId: string, label: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions(channel_id, thread_key, cursor_chat_id, label, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, thread_key) DO UPDATE SET
           cursor_chat_id = excluded.cursor_chat_id,
           label = excluded.label,
           last_active_at = excluded.last_active_at`,
      )
      .run(channelId, threadKey, cursorChatId, label, now, now);
  }

  touch(channelId: string, threadKey: string): void {
    this.db
      .prepare(`UPDATE sessions SET last_active_at = ? WHERE channel_id = ? AND thread_key = ?`)
      .run(new Date().toISOString(), channelId, threadKey);
  }

  hasParticipated(channelId: string, threadTs: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS ok FROM participation WHERE channel_id = ? AND thread_ts = ?`)
      .get(channelId, threadTs) as { ok: number } | undefined;
    return Boolean(row);
  }

  markParticipated(channelId: string, threadTs: string): void {
    this.db
      .prepare(
        `INSERT INTO participation(channel_id, thread_ts) VALUES (?, ?)
         ON CONFLICT(channel_id, thread_ts) DO NOTHING`,
      )
      .run(channelId, threadTs);
  }

  createPendingApproval(input: {
    originChannelId: string;
    originThreadTs: string;
    requesterUserId: string;
    approverUserId: string;
    summary: string;
    expiresAt?: string;
  }): PendingApproval {
    const now = new Date();
    const row: PendingApproval = {
      id: randomBytes(9).toString("base64url"),
      originChannelId: input.originChannelId,
      originThreadTs: input.originThreadTs,
      requesterUserId: input.requesterUserId,
      approverUserId: input.approverUserId,
      summary: input.summary,
      status: "pending",
      approvalChannelId: undefined,
      approvalMessageTs: undefined,
      createdAt: now.toISOString(),
      expiresAt: input.expiresAt ?? new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO pending_approvals(
           id, origin_channel_id, origin_thread_ts, requester_user_id, approver_user_id,
           summary, status, approval_channel_id, approval_message_ts, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.originChannelId,
        row.originThreadTs,
        row.requesterUserId,
        row.approverUserId,
        row.summary,
        row.status,
        null,
        null,
        row.createdAt,
        row.expiresAt,
      );
    return row;
  }

  getPendingApproval(id: string): PendingApproval | undefined {
    const row = this.db
      .prepare(
        `SELECT id, origin_channel_id, origin_thread_ts, requester_user_id, approver_user_id,
                summary, status, approval_channel_id, approval_message_ts, created_at, expires_at
         FROM pending_approvals WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          origin_channel_id: string;
          origin_thread_ts: string;
          requester_user_id: string;
          approver_user_id: string;
          summary: string;
          status: ApprovalStatus;
          approval_channel_id: string | null;
          approval_message_ts: string | null;
          created_at: string;
          expires_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      originChannelId: row.origin_channel_id,
      originThreadTs: row.origin_thread_ts,
      requesterUserId: row.requester_user_id,
      approverUserId: row.approver_user_id,
      summary: row.summary,
      status: row.status,
      approvalChannelId: row.approval_channel_id ?? undefined,
      approvalMessageTs: row.approval_message_ts ?? undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  attachApprovalMessage(id: string, channelId: string, messageTs: string): void {
    this.db
      .prepare(
        `UPDATE pending_approvals SET approval_channel_id = ?, approval_message_ts = ? WHERE id = ?`,
      )
      .run(channelId, messageTs, id);
  }

  consumePendingApproval(
    id: string,
    clickerId: string,
    status: "approved" | "denied",
  ): ConsumeApprovalResult {
    const row = this.getPendingApproval(id);
    if (!row) return { ok: false, reason: "unknown" };
    if (row.status !== "pending") return { ok: false, reason: "consumed", row };
    if (Date.parse(row.expiresAt) <= Date.now()) {
      this.db
        .prepare(`UPDATE pending_approvals SET status = 'expired' WHERE id = ? AND status = 'pending'`)
        .run(id);
      return { ok: false, reason: "expired", row: { ...row, status: "expired" } };
    }
    if (clickerId !== row.approverUserId) return { ok: false, reason: "not_approver", row };
    this.db
      .prepare(`UPDATE pending_approvals SET status = ? WHERE id = ? AND status = 'pending'`)
      .run(status, id);
    const updated = this.getPendingApproval(id);
    if (!updated || updated.status !== status) return { ok: false, reason: "consumed", row };
    return { ok: true, row: updated };
  }
}
