# Install

Production path: Ubuntu (or similar) VPS, systemd user unit, Slack Socket Mode, Cursor CLI, a **hub** git checkout as `WORKSPACE`.

For a starter hub (persona, sibling repos, hygiene, optional tick) use [agent-hub-template](https://github.com/cianwhalley/agent-hub-template). You can also point `WORKSPACE` at any Cursor project.

## Prerequisites

- Node 22+
- pnpm 9+ (or npm)
- [Cursor CLI](https://cursor.com/docs/cli/using): `curl https://cursor.com/install -fsS | bash`
- A personal Cursor API key ([Dashboard → API Keys](https://cursor.com/dashboard/api)) — not a team service-account key
- A Slack workspace where you can create apps

## 1. Slack app

1. [api.slack.com](https://api.slack.com/apps) → Create from manifest → paste [`manifest.socket.json`](../manifest.socket.json).
2. **Enable Socket Mode** in the app settings (required even if an `xapp-` token exists). Create an app-level token with `connections:write`.
3. Install the app to the workspace. Copy the bot token (`xoxb-`) and app-level token (`xapp-`).
4. **Do not** enable Slack Agents / `agent_view`. This is a classic bot.

Bolt may log `Socket Mode is not turned on` if the UI toggle is off — flip it and restart.

## 2. Service user (once, with sudo)

From a clone of this repo:

```bash
sudo ADMIN_USER="$USER" bash ops/bootstrap-service-user.sh
```

Default service user is `cursor-agent` (no sudo). Linger is enabled so user systemd survives logout.

```bash
ssh cursor-agent@your-host
```

## 3. Hub checkout

As the service user:

```bash
git clone https://github.com/cianwhalley/agent-hub-template.git ~/workspaces/your-hub
# then: fill SOUL.md, config/repos.json — see the template README
```

Install the Cursor CLI for this user too (`~/.local/bin/agent`).

## 4. Bridge

```bash
bash ops/install-bridge.sh          # INSTANCE=main by default
# edit ~/.config/cursor-slack/main.env
#   SLACK_BOT_TOKEN, SLACK_APP_TOKEN, CURSOR_API_KEY
#   WORKSPACE=/home/cursor-agent/workspaces/your-hub
#   ALLOWED_USER_IDS=U…   (your Slack user id)
systemctl --user enable --now cursor-slack@main
```

Find your Slack user id in the profile pane (or from a message permalink). Canonical `U…` IDs only — names are rejected.

## 5. Smoke

1. DM the bot: `ping` → Pong + workspace path.
2. `help` → commands and policy.
3. A short real ask → ⏳, progress draft, ✅.
4. In a channel: invite the bot, `@mention` it.

Logs: `journalctl --user -u cursor-slack@main -f`

## Next

- Same path in Cursor UI: [my-machines.md](my-machines.md)
- More than one bot: [multi-agent.md](multi-agent.md)
- Scheduled jobs: [scheduling.md](scheduling.md)

Dev-only (your laptop, no systemd): see the [README](../README.md) quick start.
