#!/usr/bin/env bash
# Run as the dedicated service user (not root) after bootstrap-service-user.sh.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/cianwhalley/cursor-slack-bridge.git}"
HOME_DIR="${HOME}"
BRIDGE_DIR="${BRIDGE_DIR:-$HOME_DIR/cursor-slack-bridge}"
INSTANCE="${INSTANCE:-main}"

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Refuse to install the bridge as root — use a dedicated service user (see ops/bootstrap-service-user.sh)." >&2
  exit 1
fi

if [[ ! -d "$BRIDGE_DIR/.git" ]]; then
  git clone "$REPO_URL" "$BRIDGE_DIR"
else
  git -C "$BRIDGE_DIR" pull --ff-only || true
fi

cd "$BRIDGE_DIR"
if command -v pnpm >/dev/null; then
  pnpm install --frozen-lockfile || pnpm install
  pnpm run build
else
  npm install
  npm run build
fi

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR" "$HOME/.config/cursor-slack" "$HOME/.local/share/cursor-slack"
cp ops/cursor-slack@.service "$UNIT_DIR/cursor-slack@.service"
systemctl --user daemon-reload

ENV_FILE="$HOME/.config/cursor-slack/${INSTANCE}.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cp ops/env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Wrote $ENV_FILE — fill tokens + WORKSPACE before starting"
else
  echo "Keeping $ENV_FILE"
fi

echo "Enable with: systemctl --user enable --now cursor-slack@${INSTANCE}.service"
echo "See docs/install.md"
