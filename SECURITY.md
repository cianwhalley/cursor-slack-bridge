# Security policy

## Supported versions

The `main` branch is the only supported line until tagged releases exist.

## Reporting a vulnerability

Use [GitHub Private Vulnerability Reporting](https://github.com/cianwhalley/cursor-slack-bridge/security/advisories/new) on this repository.

Do **not** file a public issue for security problems.

We aim to acknowledge reports within 7 days and to ship a fix or mitigation on a coordinated timeline.

## In scope

- Slack token handling (bot and app-level tokens leaking into the Cursor `agent` child, logs, or session DB)
- Allowlist / engage-policy bypass (non-allowlisted users spawning an agent)
- Path or env injection via `WORKSPACE`, `AGENT_BIN`, or session keys
- Socket Mode event handling that causes unintended agent runs

## Out of scope

- Compromising a misconfigured Slack workspace (tokens in a world-readable env file)
- Cursor CLI / Cloud Agent bugs upstream
- Social engineering of allowlisted users

## Operator notes

- Per-instance env files should be mode `600`.
- Run the bridge as a dedicated non-sudo user.
- The agent child must not inherit `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` (see `src/agent-runner.ts`).
