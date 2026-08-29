#!/usr/bin/env bash
# Start the Slack bridge for systemd instance %i (cleo | silas | …).
# Loads instance env + hub vault-env (token for one-shot STT). Never prints secrets.
# Do not wrap Node in agent-vault run — that proxies Cursor HTTP/2 and fails ALPN.
set -euo pipefail

INSTANCE="${1:-}"
if [[ -z "$INSTANCE" ]]; then
  echo "usage: run-bridge.sh <instance>" >&2
  exit 2
fi

ENV_FILE="${CURSOR_SLACK_ENV:-$HOME/.config/cursor-slack/${INSTANCE}.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "run-bridge: missing $ENV_FILE" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
export CURSOR_SLACK_ENV="$ENV_FILE"
export DOTENV_CONFIG_PATH="$ENV_FILE"

HUB="${WORKSPACE:-$HOME/slack-workspace/${INSTANCE}-agent}"
if [[ -f "$HUB/scripts/hub-root.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HUB/scripts/hub-root.sh"
fi
if [[ -f "$HUB/scripts/vault-env.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HUB/scripts/vault-env.sh"
fi

load_key_file() {
  local dest="$1"
  shift
  if [[ -n "${!dest:-}" ]]; then
    return 0
  fi
  local f val
  for f in "$@"; do
    [[ -n "$f" && -f "$f" ]] || continue
    val="$(tr -d '\r\n' <"$f")"
    printf -v "$dest" '%s' "$val"
    export "$dest"
    return 0
  done
}

load_key_file OPENROUTER_API_KEY \
  "${OPENROUTER_API_KEY_FILE:-}" \
  "$HOME/.config/${INSTANCE}-agent/credentials/services/openrouter"

load_key_file OPENAI_API_KEY \
  "${OPENAI_API_KEY_FILE:-}"

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BRIDGE_DIR"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"

# Do NOT wrap this Node process in `agent-vault run`. MITM HTTPS_PROXY breaks
# Cursor agent HTTP/2 (SSL alert 120 / no application protocol) and can
# interfere with Slack. STT uses a one-shot vault curl from Node when needed.
exec "$NODE_BIN" "$BRIDGE_DIR/dist/index.js"
