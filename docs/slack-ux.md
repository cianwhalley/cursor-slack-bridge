# Slack UX

The chat surface is meant to feel like a serious operator bot, not a stack of “still working” posts. Several of these exist because earlier Slack faces (including a NanoClaw / OpenClaw-style stack) were noisy, silent, or too easy to drive by the wrong person.

## User-facing

| Behavior | Why |
|----------|-----|
| ⏳ on your message, then ✅ / ❌ | Non-verbal ack. Silence used to mean “maybe dead.” |
| One editable `Working…` draft + rolling tool lines | Never a pile of keepalive bubbles. |
| Follow-up while busy: “Still working… send `stop`” | Queued DMs used to sit with no ack. Same-ts `message`+`app_mention` is deduped (not a fake queue). |
| `stop` / `exit` kills the child | Escape hatch; no LLM. |
| `ping` / `help` | Liveness and rules; no Cursor. |
| Channel replies stay in the thread | Keep the channel tidy. DMs stay top-level unless you are already in a thread UI. |
| `@mention` to start; later replies in that thread need no mention | Same rule as a human teammate who was already in the thread. |
| Tool lines from Cursor `description` / explain labels | Raw `cd && export …` is unreadable in Slack. |
| Final text = last assistant bubble | Concatenated `result` and thinking leaked duplicates. |
| `assistant.threads.setStatus` keepalive (~90s) | Slack status TTL is short; long jobs looked idle. |
| Messages chunked ~3500 chars | Slack post limits. |

## Operator-facing

| Behavior | Why |
|----------|-----|
| Allowlist on DMs **and** channel mentions **and** thread follow-ups | A participated thread used to be driveable by anyone in the channel. |
| `CHANNEL_POLICY=configured` vs `any` | Tight alert channels vs “bot is in the room.” |
| Fire-and-forget Bolt handler | Slack retries events if you block the ack for a 10-minute agent run. |
| Slack tokens stripped from the agent env | Two bots on one Unix user must not leak each other’s tokens into Cursor. |
| `SESSION_TIMEOUT_SECONDS` (default 900) | Hung CLI should not hold Slack forever. |
| Early SIGTERM after `create-chat` prints a UUID | Cursor CLI sometimes prints the id then hangs. |
| Ignore `bot_id` / most subtypes | Feedback loops. |
| Socket Mode, **not** Slack Agents API | Classic `@mention` + DM; no `agent_view` product coupling. |

## Commands

Send as the full message (after mention strip):

- `ping` — Pong + `WORKSPACE`
- `stop` / `exit` — kill active run in this session
- `help` / `?` — this surface, policy, commands

## Not in v1

- Slash commands
- Thread history backfill (NanoClaw had API/MCP history; the prompt only gets a `[slack dm]` / `[slack C…]` prefix)
- Live token streaming (draft edits only)
- Rich bridge commands (git, screenshot, queue depth)

Those belong in a hub skill or a future PR — not as a second framework inside this process.
