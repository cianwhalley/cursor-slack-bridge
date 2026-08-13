# Scheduling

The bridge has **no internal cron**. Recurring work belongs in the **hub**, on the VPS, as git.

Cursor Automations on personal plans run in Cursor Cloud. They cannot target a [My Machines](https://cursor.com/docs/cloud-agent/self-hosted-guides/my-machines) worker, so they cannot see your vault, sibling checkouts, or local state. A systemd timer on the box can.

## Pattern (shipped in the hub template)

1. `schedules/registry.yaml` — jobs with cron, skill, Slack policy (`on_fail` / `always` / `never`).
2. Timer every 15 minutes → `schedules/run-tick.sh`.
3. `node schedules/due.mjs` — empty array → **exit, no LLM**.
4. Else `agent -p --force --trust --workspace $HUB` with the due list.
5. Job posts to Slack with the **same bot token** as the interactive face.
6. After `chat.postMessage`, call this repo’s marker:

```bash
node /path/to/cursor-slack-bridge/scripts/mark-participated.mjs \
  "$SESSION_DB" "$channel_id" "$thread_ts"
```

Socket Mode does not echo your outbound messages. Without this, humans must `@mention` to continue in an alert thread. With it, allowlisted replies in that thread wake the agent.

## Why this is better than “ask Slack to remind me”

- The clock is the VPS, next to the disk the agent actually uses.
- Jobs are reviewed in git, not hidden in a SaaS UI.
- Idle ticks cost nothing (no model).
- The same `@YourBot` that you DM is the one that pings you at 09:00 — then you can talk in-thread.

See [agent-hub-template](https://github.com/cianwhalley/agent-hub-template) `schedules/` and `ops/tick/`.
