#!/usr/bin/env bash
# Explicit environment; validate the complete shared nginx configuration every time.
set -Eeuo pipefail
case "${DEPLOY_ENV:-}" in gcp|ru) ;; *) echo 'DEPLOY_ENV must be gcp or ru' >&2; exit 1;; esac
REPO_DIR=${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
NGINX_ROOT=${NGINX_ROOT:-/etc/nginx}
backup=''
changed=()
restore() {
  if (( ${#changed[@]} )); then
    for name in "${changed[@]}"; do
      sudo rm -f "$NGINX_ROOT/sites-enabled/$name"
      if [[ -e "$backup/$name" || -L "$backup/$name" ]]; then
        sudo cp -a "$backup/$name" "$NGINX_ROOT/sites-enabled/$name"
      fi
    done
    echo "Restored previous nginx sites; backup: $backup" >&2
    sudo nginx -t || true
  fi
}
trap 'restore; exit 1' ERR
sudo nginx -t
sites=()
if [[ "$DEPLOY_ENV" == gcp ]]; then
  sites=(relay agent-trainedassist-store)
elif [[ "${DEPLOY_RECRUITER_APEX:-}" == 1 || -e "$NGINX_ROOT/sites-enabled/recruiter-assistant" ]]; then
  sites=(recruiter-assistant)
  # Exhibition catalogs on <event_key>.sales-manager-assistant.ru. Separate
  # flag and separate gate: this config must never be installed on GCP, and it
  # needs a certificate that covers the wildcard.
  if [[ "${DEPLOY_SALES_APEX:-}" == 1 || -e "$NGINX_ROOT/sites-enabled/sales-manager-assistant" ]]; then
    sites+=(sales-manager-assistant)
  fi
fi
if (( ${#sites[@]} )); then
  # Both public hostnames must accept the same media sizes. The stable tunnel
  # hostname used by the gateway was previously outside deployment management.
  for name in "${sites[@]}"; do
    src="$REPO_DIR/infra/nginx/$name.conf"
    dst="$NGINX_ROOT/sites-enabled/$name"
    if ! sudo cmp -s "$src" "$dst"; then
      if [[ -z "$backup" ]]; then backup=$(sudo mktemp -d "$NGINX_ROOT/relay-backup.XXXXXX"); fi
      if [[ -e "$dst" || -L "$dst" ]]; then sudo cp -a "$dst" "$backup/$name"; fi
      changed+=("$name")
      sudo install -m 644 "$src" "$backup/candidate"
      sudo mv -T "$backup/candidate" "$dst"
    fi
  done
  sudo nginx -t
fi
# RU never installs relay. A broken pre-existing config fails loudly.
if sudo systemctl is-active --quiet nginx; then
  sudo systemctl reload nginx
else
  sudo systemctl start nginx
fi
trap - ERR
