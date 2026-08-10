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

## Docs

- Slack app manifest: [`manifest.socket.json`](manifest.socket.json)
- VPS / service user: [`ops/README.md`](ops/README.md)

## License

Private use.
