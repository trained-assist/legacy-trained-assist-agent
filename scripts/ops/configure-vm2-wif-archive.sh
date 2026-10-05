#!/usr/bin/env bash
# Install the non-secret ADC external-account config used by VM2's GCS session archive.
# The WIF issuer's RSA private key stays root-only; this file only describes token exchange.
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run as root" >&2
  exit 1
fi

readonly WIF_DIR="${WIF_DIR:-/opt/wif}"
readonly CONFIG="${WIF_DIR}/credentials.json"
readonly SERVICE_GROUP="${SERVICE_GROUP:-vova}"
readonly PROJECT_NUMBER="731388616698"
readonly POOL="ta-vm2"
readonly PROVIDER="ta-vm2-public"
readonly SERVICE_ACCOUNT="session-archive-vm2@alesa-personal-assistent.iam.gserviceaccount.com"

test -r "${WIF_DIR}/oidc-server.js" || { echo "Missing VM2 OIDC issuer under ${WIF_DIR}" >&2; exit 1; }
getent group "${SERVICE_GROUP}" >/dev/null || { echo "Missing service group ${SERVICE_GROUP}" >&2; exit 1; }

tmp="${WIF_DIR}/.credentials.$$.json"
trap 'rm -f "${tmp}"' EXIT
umask 077
cat >"${tmp}" <<EOF
{
  "type": "external_account",
  "audience": "//iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}",
  "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
  "token_url": "https://sts.googleapis.com/v1/token",
  "service_account_impersonation_url": "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SERVICE_ACCOUNT}:generateAccessToken",
  "credential_source": {
    "url": "http://127.0.0.1:18080/token",
    "format": {
      "type": "json",
      "subject_token_field_name": "access_token"
    }
  }
}
EOF

chown "root:${SERVICE_GROUP}" "${tmp}"
chmod 0640 "${tmp}"
mv -f "${tmp}" "${CONFIG}"
trap - EXIT
echo "Installed external-account config at ${CONFIG} (root:${SERVICE_GROUP}, 0640)."
echo "Apply infra/systemd/host/contabo-vm2.conf, then verify ADC from the assist-agent service user."
