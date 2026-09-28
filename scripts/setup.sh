#!/bin/bash
# Initial VM setup for trained-assist-agent (GCP)
set -e

REPO_URL="https://github.com/trained-assist/trained-assist-agent.git"
REPO_DIR="/home/vova/trained-assist-agent"
SERVICE="assist-agent"

echo "==> Cloning repo..."
git clone "$REPO_URL" "$REPO_DIR" || (cd "$REPO_DIR" && git pull)

echo "==> Installing Node.js dependencies..."
cd "$REPO_DIR"
npm ci --omit=dev

echo "==> Creating canonical storage roots..."
# USERS_DIR = profile workspaces (sessions/projects/contexts), AGENT_DATA_DIR =
# server-side operational state, AGENT_TOKENS_DIR = per-profile credentials.
# Do NOT create the deprecated $HOME/agent-data/sessions workspace root.
mkdir -p "$HOME/agent-data" "$HOME/users" "$HOME/agent-tokens"

echo "==> Installing systemd service..."
sudo cp "$REPO_DIR/systemd/assist-agent.service" "/etc/systemd/system/$SERVICE.service"
sudo cp "$REPO_DIR/systemd/assist-agent-notify-failure.service" "/etc/systemd/system/assist-agent-notify-failure.service"
# Host-specific part of the unit (storage roots, documented per-host vars) —
# a new VM boots from code, not from hand-edited /etc state (epic #1789 P1).
DROPIN_SRC="$REPO_DIR/infra/systemd/assist-agent.service.d"
DROPIN_DST="/etc/systemd/system/$SERVICE.service.d"
if [ -d "$DROPIN_SRC" ]; then
  echo "==> Installing systemd drop-ins from $DROPIN_SRC ..."
  sudo mkdir -p "$DROPIN_DST"
  for f in "$DROPIN_SRC"/*.conf; do
    [ -e "$f" ] || continue
    sudo cp "$f" "$DROPIN_DST/$(basename "$f")"
  done
fi
# The service runs from the release symlink; point it at the repo until the
# first release deploy repoints it (scripts/deploy.sh does this on the VM too).
sudo ln -sfn "$REPO_DIR" /home/vova/agent-master
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE"
sudo systemctl start "$SERVICE"
sudo systemctl status "$SERVICE" --no-pager

echo "==> Registering PostToolUse artifact hook in ~/.claude/settings.json..."
node -e "
const fs = require('fs');
const os = require('os');
const p = os.homedir() + '/.claude/settings.json';
let settings = {};
try { settings = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
settings.hooks = settings.hooks || {};
settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];
const hookCmd = 'node $REPO_DIR/src/hooks/post-tool-use-artifacts.js';
if (!settings.hooks.PostToolUse.some(h => h.hooks?.[0]?.command === hookCmd)) {
  settings.hooks.PostToolUse.push({ matcher: '*', hooks: [{ type: 'command', command: hookCmd }] });
  fs.writeFileSync(p, JSON.stringify(settings, null, 2));
  console.log('  Hook registered: ' + hookCmd);
} else {
  console.log('  Hook already registered, skipping.');
}
"

echo "==> Setup complete. Add secrets to GCP Secret Manager:"
echo "  TELEGRAM_BOT_TOKEN"
echo "  ANTHROPIC_API_KEY"
echo "  AGENT_SECRET"
echo "  DEEPGRAM_API_KEY (optional)"
echo "  BOT_SECRET (optional, for Chrome extension)"
