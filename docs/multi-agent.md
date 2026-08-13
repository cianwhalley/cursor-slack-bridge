# Multi-agent

One Node binary. N processes. N Slack apps. N hubs.

```bash
# after ops/install-bridge.sh
cp ~/.config/cursor-slack/main.env ~/.config/cursor-slack/family.env
# WORKSPACE, tokens, ALLOWED_USER_IDS, SESSION_DB
systemctl --user enable --now cursor-slack@family
```

`%i` in `cursor-slack@.service` is the env file stem: `~/.config/cursor-slack/%i.env`.

## Isolation

| Axis | Per instance |
|------|----------------|
| Slack identity | Own app, `xoxb-` + `xapp-` (one Socket Mode consumer per app) |
| Hub | Own `WORKSPACE` git checkout |
| Sessions | Own `SESSION_DB` |
| Access | Own `ALLOWED_USER_IDS`, `DM_POLICY`, `CHANNEL_POLICY` |
| Cursor | `CURSOR_API_KEY` may be shared; Slack tokens must not be |

The agent child environment **deletes** `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` before spawn. That matters when two bots share a Unix user: a prompt that dumps `env` must not exfiltrate the sibling bot.

## What is *not* isolated by the bridge

Persona, skills, and sibling repos live **in the hub**, not in this process. If two instances point `WORKSPACE` at the same path, they are two Slack faces of the same brain. Point them at different hubs for ops vs family (see [workspaces.md](workspaces.md)).

My Machines can use one worker name and select the hub with `repo=` (the worker directory’s git remote). Or run two workers. The Slack side does not know or care.
