#!/usr/bin/env bash
# Cleo hard-cut: stop cian nanoclaw, start cursor-slack@cleo as cursor-agent.
# Parts that need sudo/cian are printed if not available.
set -euo pipefail

INSTANCE="${INSTANCE:-cleo}"
SERVICE_USER="${SERVICE_USER:-cursor-agent}"

echo "==> Ensure bridge unit is installed (as $SERVICE_USER)"
if [[ "$(id -un)" != "$SERVICE_USER" ]]; then
  echo "Run install/start as $SERVICE_USER. As cian you can:"
  echo "  sudo systemctl --user -M ${SERVICE_USER}@ stop nanoclaw.service 2>/dev/null || true"
  echo "  # or: sudo -u cian XDG_RUNTIME_DIR=/run/user/\$(id -u cian) systemctl --user stop nanoclaw"
fi

if [[ "$(id -un)" == "cian" ]]; then
  echo "Stopping nanoclaw (cian)…"
  systemctl --user stop nanoclaw.service 2>/dev/null || true
  systemctl --user disable nanoclaw.service 2>/dev/null || true
  echo "Start bridge as cursor-agent:"
  echo "  sudo -u $SERVICE_USER XDG_RUNTIME_DIR=/run/user/\$(id -u $SERVICE_USER) systemctl --user enable --now cursor-slack@${INSTANCE}"
  exit 0
fi

if [[ "$(id -un)" != "$SERVICE_USER" ]]; then
  echo "Run as cian (to stop nanoclaw) or $SERVICE_USER (to start bridge)" >&2
  exit 1
fi

systemctl --user daemon-reload
systemctl --user enable --now "cursor-slack@${INSTANCE}.service"
sleep 2
systemctl --user --no-pager status "cursor-slack@${INSTANCE}.service" || true
journalctl --user -u "cursor-slack@${INSTANCE}.service" -n 40 --no-pager || true
echo
echo "Smoke: DM the bot 'ping', then a short ask. @mention in #sysops alert thread."
