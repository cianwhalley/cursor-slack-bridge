# Contributing

Thanks for helping. This repo is a thin Slack transport around the Cursor `agent` CLI — keep it that way.

## Dev setup

- Node 22+
- [pnpm](https://pnpm.io/) 9+

```bash
pnpm install
cp ops/env.example .env   # tokens stay local; never commit
pnpm test
pnpm typecheck
```

`CURSOR_SLACK_ENV=.env pnpm start` runs the bridge against your env.

## Pull requests

1. Branch from `main`.
2. Match existing TypeScript style. No new framework, no extra Slack product APIs unless the change needs them.
3. Tests for policy, routing, or stream parsing when you touch those paths.
4. Do not commit `.env`, tokens, session databases, or real Slack user/channel IDs.
5. Update `docs/` when behavior or install steps change.

## What belongs here vs the hub

- **This repo:** Bolt, policy, sessions, Slack UX, systemd install.
- **[agent-hub-template](https://github.com/cianwhalley/agent-hub-template):** `SOUL.md`, skills, sibling repos, scheduling.

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
