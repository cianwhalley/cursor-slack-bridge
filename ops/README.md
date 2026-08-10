# Ops: cursor-slack-bridge on cleo-lc

## Roles

| User | Role |
|------|------|
| `cian` | sudo/host admin; Agent Vault Docker; stop NanoClaw |
| `cursor-agent` | Slack bridge + `agent` CLI; no sudo |

## One-time bootstrap (cian + sudo)

```bash
# from a clone readable by cian, or curl the script
sudo bash ops/bootstrap-service-user.sh
```

Then SSH:

```bash
ssh cursor-agent@cleo   # same authorized_keys as cian
```

## Install bridge (as cursor-agent)

```bash
bash ops/install-bridge.sh
# edit ~/.config/cursor-slack/cleo.env  (tokens from nanoclaw .env + CURSOR_API_KEY)
# clone/move hub:
#   git clone https://github.com/zenmindhacker/cleo-agent.git ~/workspaces/cleo-agent
pnpm test && pnpm typecheck   # in bridge dir
systemctl --user enable --now cursor-slack@cleo
```

## Slack app

1. api.slack.com → Create from manifest → paste [`manifest.socket.json`](../manifest.socket.json)
2. **Enable Socket Mode** in the app settings (required); create app-level token `connections:write`
3. Event Subscriptions: `message.im`, `app_mention`, `message.channels`, `message.groups`
4. Install app; copy `xoxb-` + `xapp-` into `cleo.env`
5. **Do not** enable Agents / `agent_view`
6. Reuse existing Cleo app tokens if cutting over from NanoClaw

Bolt may log `Socket Mode is not turned on` if the toggle is off in the UI even when an `xapp-` token exists — flip Socket Mode on and restart the unit.

## Cutover

```bash
# as cian:
systemctl --user stop nanoclaw.service
systemctl --user disable nanoclaw.service

# as cursor-agent:
systemctl --user enable --now cursor-slack@cleo
```

Or `ops/cutover-cleo.sh` as the appropriate user.

## Multi-instance

Same binary, new env:

```bash
cp ~/.config/cursor-slack/cleo.env ~/.config/cursor-slack/silas.env
# edit WORKSPACE, tokens, ALLOWED_USER_IDS, SESSION_DB
systemctl --user enable --now cursor-slack@silas
```

## Agent Vault

Daemon stays under `cian` (`~/agent-vault`). Client token for this user:

`~/.config/agent-vault/` → `AGENT_VAULT_ADDR=http://127.0.0.1:14321` (proxy role).
