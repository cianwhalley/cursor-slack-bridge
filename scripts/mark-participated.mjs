#!/usr/bin/env node
/**
 * Subscribe a channel thread so allowlisted replies wake the agent without @mention.
 * Used by silas-tick / cleo-tick after chat.postMessage (Socket Mode does not echo our posts).
 *
 *   node scripts/mark-participated.mjs <session.db> <channel_id> <thread_ts>
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [dbPath, channelId, threadTs] = process.argv.slice(2);
if (!dbPath || !channelId || !threadTs) {
  console.error("usage: mark-participated.mjs <session.db> <channel_id> <thread_ts>");
  process.exit(2);
}
if (channelId.startsWith("D")) {
  process.exit(0);
}

mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS participation (
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    PRIMARY KEY (channel_id, thread_ts)
  );
`);
db.prepare(
  `INSERT INTO participation(channel_id, thread_ts) VALUES (?, ?)
   ON CONFLICT(channel_id, thread_ts) DO NOTHING`,
).run(channelId, threadTs);
db.close();
