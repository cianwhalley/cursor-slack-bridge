#!/usr/bin/env bash
# Run as cursor-agent on the VPS after bootstrap-service-user.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/zenmindhacker/cursor-slack-bridge.git}"
HOME_DIR="${HOME}"
BRIDGE_DIR="${BRIDGE_DIR:-$HOME_DIR/cursor-slack-bridge}"
INSTANCE="${INSTANCE:-cleo}"

if [[ "$(id -un)" == "cian" ]]; then
  echo "Refuse to install bridge as cian — use cursor-agent" >&2
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
mkdir -p "$UNIT_DIR"
cp ops/cursor-slack@.service "$UNIT_DIR/cursor-slack@.service"
systemctl --user daemon-reload

ENV_FILE="$HOME/.config/cursor-slack/${INSTANCE}.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cp ops/env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Wrote $ENV_FILE — fill tokens before starting"
else
  echo "Keeping $ENV_FILE"
fi

echo "Enable with: systemctl --user enable --now cursor-slack@${INSTANCE}.service"
