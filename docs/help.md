# Help and troubleshooting

In Slack, send `help` (or `?`) to the bot — no Cursor run.

## Smoke

| Check | Expect |
|-------|--------|
| `ping` | `Pong!` + `WORKSPACE` path |
| `help` | Commands + DM/channel policy |
| Short DM | ⏳ then a reply from that workspace |
| `journalctl --user -u cursor-slack@main -n 80` | Bolt connected; no token dumps |

## Socket Mode

Symptom: `Socket Mode is not turned on` in logs, or the bot never reacts.

Fix: Slack app settings → Socket Mode **enabled**. An `xapp-` token is not enough if the toggle is off. Restart the unit.

## Bot ignores me

- Not on `ALLOWED_USER_IDS` (canonical `U…`, not a display name).
- Channel not in `ALERT_CHANNELS` / `OPEN_CHANNELS` while `CHANNEL_POLICY=configured`.
- Channel message without `@mention` in a thread the bot has never participated in.
- Event subtype filtered (bot messages, joins).

## Agent never starts

- `CURSOR_API_KEY` missing or not a **personal** key.
- `AGENT_BIN` not on `PATH` for the systemd user (`Environment=PATH=%h/.local/bin:…`).
- `WORKSPACE` path missing or not readable by the service user.

## Long job looks dead

You should see ⏳ immediately. If you sent a second message, you should see the queued notice. If neither appears, the process is not receiving events (Socket Mode / allowlist). Send `stop` in that DM/thread if a run is stuck; wait for `SESSION_TIMEOUT_SECONDS` otherwise.

## Tick thread needs an @mention

Outbound `chat.postMessage` is invisible to Socket Mode. Hub tick scripts must run `scripts/mark-participated.mjs` on the session DB. See [scheduling.md](scheduling.md).

## Two bots, leaked token

Upgrade: agent child env strips `SLACK_*`. Confirm you are on a build that includes that change. Separate Slack apps per instance anyway.

## Still stuck

Open a [deploy issue](https://github.com/cianwhalley/cursor-slack-bridge/issues/new?template=deploy.yml). Redact tokens.
