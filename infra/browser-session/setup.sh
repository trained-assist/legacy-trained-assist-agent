#!/usr/bin/env bash
# Setup remote browser session on GCP VM (Ubuntu 22.04)
# Run as root or with sudo: bash setup.sh
set -euo pipefail

AGENT_DIR="/home/vova/trained-assist-agent"
SCRIPTS_DIR="/home/vova/browser-session"

echo "=== Installing packages ==="
apt-get install -y xvfb x11vnc novnc websockify

echo "=== Creating browser-session scripts ==="
mkdir -p "$SCRIPTS_DIR"
cp "$(dirname "$0")/capture-cookies.js" "$SCRIPTS_DIR/"
cp "$(dirname "$0")/navigate.js" "$SCRIPTS_DIR/"
# login.js / login-server.js are NOT copied: both run straight from the release (#1866, #1875).
# Delete any hand copy left behind — it can only drift and reintroduce the false-success bug.
rm -f "$SCRIPTS_DIR/login.js" "$SCRIPTS_DIR/login.js.bak" "$SCRIPTS_DIR/login.js.bak2" \
      "$SCRIPTS_DIR/login-server.js"
chown -R vova:vova "$SCRIPTS_DIR"

echo "=== Installing systemd services ==="
cp "$(dirname "$0")/../systemd/"*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable xvfb-browser chrome-browser vnc-browser novnc-browser login-server

echo "=== Starting services ==="
systemctl start xvfb-browser
sleep 3
systemctl start chrome-browser
sleep 5
systemctl start vnc-browser
sleep 4
systemctl start novnc-browser
systemctl restart login-server

echo "=== Status ==="
systemctl is-active xvfb-browser chrome-browser vnc-browser novnc-browser login-server

echo ""
echo "=== nginx ==="
echo "Add /browser/ and /websockify locations from infra/nginx/relay.conf"
echo "Then: nginx -t && systemctl reload nginx"
