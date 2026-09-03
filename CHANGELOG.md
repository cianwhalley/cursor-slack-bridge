# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Slack **voice notes + file ingest**: download attachments (`files:read`), transcribe audio in the bridge (OpenRouter / Whisper) as `[Voice message]: …`, stage other files under `$WORKSPACE/.slack-inbox/`. Empty-caption voice notes engage. When inbound was voice, the agent is instructed to reply with `VOICE_REPLY: /path.mp3`; the bridge uploads and deletes the file.
- `ops/run-bridge.sh` loads instance env + hub vault token. STT uses a one-shot vault curl when no OpenRouter key is in env.

### Fixed

- Do **not** wrap the long-lived Node process in `agent-vault run`. MITM `HTTPS_PROXY` made Cursor agent HTTP/2 fail (`SSL routines:tlsv1 alert no application protocol`). Agent children also strip proxy env.

### Changed

- **DMs reply in a thread** under the user's message (one Cursor chat per thread). Top-level composer = new topic; several DM topics can run in parallel. Prompt prefix is `[slack dm thread <ts>]`.
- Model fallback now handles transient provider degradation as well as usage limits, and Slack names the configured fallback instead of always saying “Auto mode.”

### Added (earlier)

- Config-driven **Block Kit actions** (`BLOCK_ACTIONS_CONFIG` / `BLOCK_ACTIONS_JSON`): secondary/primary button → hub script, optimistic UI, serialized queue, optional localhost test hook. See `docs/block-actions.md`.
- **Auto model fallback** when the pinned Slack model hits fast usage limits (`ActionRequiredError` / “out of usage”): retries with `agent --model auto`. Final reply is prefixed `⚡ *Reply via Auto mode*`. Configure with `AGENT_MODEL_FALLBACK` (default `auto`; set `off` to disable).

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
