#!/usr/bin/env bash
# Historical: stop a NanoClaw unit and start cursor-slack@<instance>.
# New installs should follow docs/install.md instead.
set -euo pipefail

INSTANCE="${INSTANCE:-main}"
SERVICE_USER="${SERVICE_USER:-cursor-agent}"
ADMIN_USER="${ADMIN_USER:-${SUDO_USER:-$(id -un)}}"

echo "==> Ensure bridge unit is installed (as $SERVICE_USER)"
if [[ "$(id -un)" != "$SERVICE_USER" ]]; then
  echo "Run install/start as $SERVICE_USER. As admin you can:"
  echo "  systemctl --user stop nanoclaw.service 2>/dev/null || true"
fi

if [[ "$(id -un)" == "$ADMIN_USER" && "$(id -un)" != "$SERVICE_USER" ]]; then
  echo "Stopping nanoclaw ($ADMIN_USER)…"
  systemctl --user stop nanoclaw.service 2>/dev/null || true
  systemctl --user disable nanoclaw.service 2>/dev/null || true
  echo "Start bridge as $SERVICE_USER:"
  echo "  sudo -u $SERVICE_USER XDG_RUNTIME_DIR=/run/user/\$(id -u $SERVICE_USER) systemctl --user enable --now cursor-slack@${INSTANCE}"
  exit 0
fi

if [[ "$(id -un)" != "$SERVICE_USER" ]]; then
  echo "Run as $ADMIN_USER (to stop nanoclaw) or $SERVICE_USER (to start bridge)" >&2
  exit 1
fi

systemctl --user daemon-reload
systemctl --user enable --now "cursor-slack@${INSTANCE}.service"
sleep 2
systemctl --user --no-pager status "cursor-slack@${INSTANCE}.service" || true
journalctl --user -u "cursor-slack@${INSTANCE}.service" -n 40 --no-pager || true
echo
echo "Smoke: DM the bot 'ping', then a short ask."
