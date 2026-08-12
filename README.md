# cursor-slack-bridge

Thin [Bolt](https://docs.slack.dev/tools/bolt-js/) Socket Mode bridge: Slack DM / `@mention` → headless Cursor [`agent`](https://cursor.com/docs/cli/using) CLI on a local workspace.

One install, N instances (Cleo / Silas / kids). Not an LLM framework — Cursor is the brain.

## Quick start (dev)

```bash
pnpm install
cp ops/env.example .env   # fill tokens + WORKSPACE
pnpm test
pnpm typecheck
pnpm build
CURSOR_SLACK_ENV=.env pnpm start
```

## Slack UX (OpenClaw-aligned)

- Ack reaction on the user message (⏳) → ✅ / ❌
- `STREAMING_MODE=progress` (default): one editable draft (`Working…` + tool lines); final replaces it in place
- If you send another message while a run is in progress: immediate “still working… send `stop` to cancel” (do not assume silence means the bot is dead)
- `stop` in that DM/thread kills the active agent run
- Tool lines use OpenClaw explain formatting (Cursor `description` / human labels — not raw `cd && export …`)
- Defaults: `TOOL_PROGRESS_DETAIL=explain`, `PROGRESS_COMMENTARY=false` (no thinking/preamble in draft)
- Threaded replies: also refresh `assistant.threads.setStatus` (top-level DMs stay draft-only)
- Final text = last Cursor assistant bubble (not concatenated `result`, not thinking)

## Docs

- Slack app manifest: [`manifest.socket.json`](manifest.socket.json)
- VPS / service user: [`ops/README.md`](ops/README.md)

## License

Private use.
