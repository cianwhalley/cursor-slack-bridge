# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.1] - 2026-08-15

### Fixed

- Channel `@mention` no longer triggers a fake “Still working on your last message…” queue. Slack delivers the same event as both `message` and `app_mention`; the router dedupes by `channel:messageTs` (~120s).

### Changed

- Docs note the dedupe in architecture / Slack UX.

## [0.1.0] - 2026-08

### Added

- Bolt Socket Mode bridge: Slack DM / `@mention` → headless Cursor `agent` CLI.
- Multi-instance systemd template (`cursor-slack@.service`).
- Engage policy: DM/channel allowlists, mention-to-start, thread participation.
- OpenClaw-aligned Slack UX: ack reactions, one editable progress draft, explain-mode tool lines, last-assistant-bubble replies.
- Queued-message visible ack and `stop` / `ping` commands.
- Channel allowlist on mentions and thread follow-ups.
- Slack tokens stripped from the agent child environment.
- Public docs, MIT license, and community health files.
- In-Slack `help` command (no Cursor run).
- `scripts/mark-participated.mjs` so hub tick posts subscribe threads for mention-free follow-ups.

### Changed

- Ops scripts and `env.example` are generic (no host-specific IDs). NanoClaw cutover moved to `ops/legacy/`.
