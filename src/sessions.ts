import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ThreadParticipationStore } from "./policy.js";

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
    `);
  }

  close(): void {
    this.db.close();
  }

  static dmThreadKey(): string {
    return "main";
  }

  sessionKey(isDm: boolean, channelId: string, threadTs: string): { channelId: string; threadKey: string } {
    if (isDm) {
      return { channelId, threadKey: SessionStore.dmThreadKey() };
    }
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
}
