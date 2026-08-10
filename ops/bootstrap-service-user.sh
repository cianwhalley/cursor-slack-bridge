#!/usr/bin/env bash
# Run as cian (with sudo) on cleo-lc once.
# Creates non-sudo cursor-agent user, copies SSH keys, enables linger.
set -euo pipefail

SERVICE_USER="${SERVICE_USER:-cursor-agent}"
ADMIN_USER="${ADMIN_USER:-cian}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Re-running with sudo…"
  exec sudo SERVICE_USER="$SERVICE_USER" ADMIN_USER="$ADMIN_USER" bash "$0" "$@"
fi

if ! id "$SERVICE_USER" &>/dev/null; then
  adduser --disabled-password --gecos "Cursor Slack bridge" "$SERVICE_USER"
  echo "Created user $SERVICE_USER"
else
  echo "User $SERVICE_USER already exists"
fi

# Ensure not in sudo
if getent group sudo >/dev/null && id -nG "$SERVICE_USER" | grep -qw sudo; then
  echo "WARNING: $SERVICE_USER is in sudo group — remove manually if unintended" >&2
fi

install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "/home/$SERVICE_USER/.ssh"
if [[ -f "/home/$ADMIN_USER/.ssh/authorized_keys" ]]; then
  cp "/home/$ADMIN_USER/.ssh/authorized_keys" "/home/$SERVICE_USER/.ssh/authorized_keys"
  chown "$SERVICE_USER:$SERVICE_USER" "/home/$SERVICE_USER/.ssh/authorized_keys"
  chmod 600 "/home/$SERVICE_USER/.ssh/authorized_keys"
  echo "Copied authorized_keys from $ADMIN_USER"
else
  echo "WARNING: no /home/$ADMIN_USER/.ssh/authorized_keys" >&2
fi

install -d -m 755 -o "$SERVICE_USER" -g "$SERVICE_USER" \
  "/home/$SERVICE_USER/workspaces" \
  "/home/$SERVICE_USER/.config/cursor-slack" \
  "/home/$SERVICE_USER/.config/agent-vault" \
  "/home/$SERVICE_USER/.local/share/cursor-slack" \
  "/home/$SERVICE_USER/.local/bin"

loginctl enable-linger "$SERVICE_USER"
echo "Linger enabled for $SERVICE_USER"
echo "Next: ssh $SERVICE_USER@cleo and run ops/install-bridge.sh"
