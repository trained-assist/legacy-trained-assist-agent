#!/usr/bin/env bash
# Agent process hardening, stage T0 (issue #1649) — host setup.
#
# Prints every step by default (dry run). Nothing changes unless --apply is given,
# and --apply must run as root. The service is never restarted by this script:
# the drop-in only takes effect on the next restart, which the operator does.
#
# What it sets up (see docs/agent-process-isolation.md):
#   1. group + N unprivileged "slot" users the engines run as
#   2. sudoers drop-in: the service user may run commands as the slots only
#   3. permissions: service home / secrets / tokens / data not readable by slots;
#      stale per-profile MCP config files (they carried server env) removed;
#      engine binaries installed under the service home made reachable
#   4. firewall: slots cannot reach the cloud metadata endpoint or local service ports
#   5. systemd drop-in enabling the runtime switches (AGENT_RUN_AS_USERS …)
#   6. read-only review of what the VM service account can access
#   --verify runs negative checks as a slot user after --apply.
set -euo pipefail

APPLY=0
VERIFY=0
SERVICE_USER=""
SERVICE_HOME=""
SLOTS=10
PREFIX="ta-agent-"
GROUP="ta-agents"
UNIT="assist-agent"
MODE="run-as"                 # run-as | allowlist
UMASK_VALUE="0027"
LOOPBACK_POLICY="blocklist"   # blocklist | deny
BLOCK_PORTS="2053,3000,5900,6080,7070,8080,8081,8888,9090,9222:9299,20241"
ENGINE_BINS="claude codex opencode gh node git"
USERS_DIR_OPT=""
TOKENS_DIR_OPT=""
DATA_DIR_OPT=""
SECRETS_FILE_OPT=""
SKIP_USERS=0 SKIP_SUDOERS=0 SKIP_PERMS=0 SKIP_ENGINES=0 SKIP_FIREWALL=0 SKIP_SYSTEMD=0 SKIP_SA_REVIEW=0

usage() {
  cat <<'EOF'
Usage: agent-isolation-setup.sh --service-user USER [options]

  --apply                 actually change the host (default: dry run, print only)
  --verify                after setup, run negative checks as the first slot user
  --service-user USER     unix user the agent service runs as (required)
  --service-home DIR      its home (default: from getent passwd)
  --users-dir DIR         profile workspaces root   (default: <home>/users)
  --tokens-dir DIR        profile token files root  (default: <home>/agent-tokens)
  --data-dir DIR          server data root          (default: <home>/agent-data)
  --secrets-file FILE     server env file           (default: <home>/secrets.env)
  --slots N               number of slot users (>= MAX_CONCURRENT_TASKS + nested runs; default 10)
  --prefix P              slot user name prefix (default ta-agent-)
  --group G               slot group (default ta-agents)
  --unit NAME             systemd unit of the agent service (default assist-agent)
  --mode run-as|allowlist run-as: switch users + env allowlist; allowlist: env allowlist + MCP bridge only
  --umask MASK            UMask for the service (default 0027)
  --loopback-policy P     blocklist (default): reject listed local ports; deny: reject all TCP to this host
  --block-ports LIST      local ports slots may not connect to, on ANY address of this host
                          (default 2053,3000,5900,6080,7070,8080,8081,8888,9090,9222:9299,20241;
                          ranges as a:b). List what listens here: ss -ltnp
  --engine-bins LIST      binaries to make reachable for slots when installed under the service home
  --skip-users --skip-sudoers --skip-perms --skip-engines --skip-firewall --skip-systemd --skip-sa-review
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --verify) VERIFY=1 ;;
    --service-user) SERVICE_USER="$2"; shift ;;
    --service-home) SERVICE_HOME="$2"; shift ;;
    --users-dir) USERS_DIR_OPT="$2"; shift ;;
    --tokens-dir) TOKENS_DIR_OPT="$2"; shift ;;
    --data-dir) DATA_DIR_OPT="$2"; shift ;;
    --secrets-file) SECRETS_FILE_OPT="$2"; shift ;;
    --slots) SLOTS="$2"; shift ;;
    --prefix) PREFIX="$2"; shift ;;
    --group) GROUP="$2"; shift ;;
    --unit) UNIT="$2"; shift ;;
    --mode) MODE="$2"; shift ;;
    --umask) UMASK_VALUE="$2"; shift ;;
    --loopback-policy) LOOPBACK_POLICY="$2"; shift ;;
    --block-ports) BLOCK_PORTS="$2"; shift ;;
    --engine-bins) ENGINE_BINS="$2"; shift ;;
    --skip-users) SKIP_USERS=1 ;;
    --skip-sudoers) SKIP_SUDOERS=1 ;;
    --skip-perms) SKIP_PERMS=1 ;;
    --skip-engines) SKIP_ENGINES=1 ;;
    --skip-firewall) SKIP_FIREWALL=1 ;;
    --skip-systemd) SKIP_SYSTEMD=1 ;;
    --skip-sa-review) SKIP_SA_REVIEW=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo; echo "== $*"; }

[ -n "$SERVICE_USER" ] || { usage >&2; die "--service-user is required"; }
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "bad --service-user"
[[ "$PREFIX" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "bad --prefix"
[[ "$GROUP" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "bad --group"
[[ "$SLOTS" =~ ^[0-9]+$ ]] && [ "$SLOTS" -ge 1 ] && [ "$SLOTS" -le 64 ] || die "--slots must be 1..64"
[[ "$BLOCK_PORTS" =~ ^[0-9,:]*$ ]] || die "bad --block-ports"
case "$MODE" in run-as|allowlist) ;; *) die "--mode must be run-as or allowlist" ;; esac
case "$LOOPBACK_POLICY" in blocklist|deny) ;; *) die "--loopback-policy must be blocklist or deny" ;; esac
[ "$APPLY" = 0 ] || [ "$(id -u)" = 0 ] || die "--apply must run as root"

if [ -z "$SERVICE_HOME" ]; then
  SERVICE_HOME="$(getent passwd "$SERVICE_USER" 2>/dev/null | cut -d: -f6 || true)"
  [ -n "$SERVICE_HOME" ] || SERVICE_HOME="/home/$SERVICE_USER"
fi
USERS_DIR="${USERS_DIR_OPT:-$SERVICE_HOME/users}"
TOKENS_DIR="${TOKENS_DIR_OPT:-$SERVICE_HOME/agent-tokens}"
DATA_DIR="${DATA_DIR_OPT:-$SERVICE_HOME/agent-data}"
SECRETS_FILE="${SECRETS_FILE_OPT:-$SERVICE_HOME/secrets.env}"
BRIDGE_DIR="$DATA_DIR/agent-bridge"
SLOT_LOCK_DIR="$DATA_DIR/agent-slots"

SLOT_USERS=()
for i in $(seq 1 "$SLOTS"); do SLOT_USERS+=("${PREFIX}${i}"); done
SLOT_CSV="$(IFS=,; echo "${SLOT_USERS[*]}")"

# run CMD… — execute with --apply, print otherwise
run() {
  if [ "$APPLY" = 1 ]; then "$@"; else printf '[dry-run]'; printf ' %q' "$@"; echo; fi
}
# write_file PATH MODE — content from stdin
write_file() {
  local dest="$1" mode="$2" content
  content="$(cat)"
  if [ "$APPLY" = 1 ]; then
    install -d -m 0755 "$(dirname "$dest")"
    printf '%s\n' "$content" > "$dest.tmp.$$"
    chmod "$mode" "$dest.tmp.$$"
    mv -f "$dest.tmp.$$" "$dest"
  else
    echo "[dry-run] write $dest (mode $mode):"
    printf '%s\n' "$content" | sed 's/^/    | /'
  fi
}
exists() { [ -e "$1" ]; }
systemctl_run() {
  if command -v systemctl >/dev/null 2>&1 || [ "$APPLY" = 0 ]; then run systemctl "$@"
  else echo "WARN: systemctl not found — run later: systemctl $*"; fi
}

echo "agent isolation setup — $([ "$APPLY" = 1 ] && echo APPLY || echo DRY RUN)"
echo "service user: $SERVICE_USER ($SERVICE_HOME), mode: $MODE, slots: $SLOTS (${PREFIX}1..${PREFIX}${SLOTS}), group: $GROUP"

say "0. preflight"
for c in setfacl getfacl sudo pkill; do
  command -v "$c" >/dev/null 2>&1 || echo "WARN: '$c' not found (install: acl / sudo / procps)"
done
[ "$SKIP_FIREWALL" = 1 ] || command -v iptables >/dev/null 2>&1 || echo "WARN: iptables not found"
id "$SERVICE_USER" >/dev/null 2>&1 || echo "WARN: service user $SERVICE_USER does not exist on this host"
if [ "$MODE" = run-as ] && command -v systemctl >/dev/null 2>&1; then
  if systemctl show -p NoNewPrivileges "$UNIT" 2>/dev/null | grep -q '=yes'; then
    echo "WARN: $UNIT has NoNewPrivileges=yes — sudo to the slot users cannot work under it"
  fi
fi

# ── 1. group + slot users ─────────────────────────────────────────────────────
if [ "$SKIP_USERS" = 0 ] && [ "$MODE" = run-as ]; then
  say "1. group $GROUP and slot users"
  getent group "$GROUP" >/dev/null 2>&1 || run groupadd --system "$GROUP"
  for u in "${SLOT_USERS[@]}"; do
    if id "$u" >/dev/null 2>&1; then echo "exists: $u"; continue; fi
    # No home (HOME is set per run to <profile>/.agent-home) and a locked password,
    # so no login. The shell must be real: sudo sets SHELL from passwd, and the
    # engines' Bash tool runs it.
    run useradd --system --gid "$GROUP" --no-create-home --home-dir /nonexistent \
      --shell /bin/bash --comment "trained-assist agent slot" "$u"
  done
fi

# ── 2. sudoers ────────────────────────────────────────────────────────────────
if [ "$SKIP_SUDOERS" = 0 ] && [ "$MODE" = run-as ]; then
  say "2. sudoers: $SERVICE_USER may run commands as the slot users (and nobody else)"
  SUDOERS_FILE="/etc/sudoers.d/${GROUP}"
  SUDOERS_CONTENT="# managed by scripts/ops/agent-isolation-setup.sh (issue #1649)
Runas_Alias TA_AGENT_SLOTS = ${SLOT_CSV}
# The runner builds the engine env itself (allowlist) and passes it through the
# process environment — never argv (so HOME/PATH are the runner's, not sudo's).
# No tty, no password. !syslog: sudo would otherwise log the full command line —
# that is the agent prompt, i.e. user data — to the system journal on every run.
Defaults>TA_AGENT_SLOTS !syslog, !env_reset, !always_set_home, !secure_path, !requiretty, !use_pty
${SERVICE_USER} ALL=(TA_AGENT_SLOTS) NOPASSWD: ALL"
  if [ "$APPLY" = 1 ]; then
    tmp="$(mktemp)"; printf '%s\n' "$SUDOERS_CONTENT" > "$tmp"
    visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; die "sudoers drop-in failed validation"; }
    install -m 0440 -o root -g root "$tmp" "$SUDOERS_FILE"; rm -f "$tmp"
  else
    printf '%s\n' "$SUDOERS_CONTENT" | write_file "$SUDOERS_FILE" 0440
  fi
fi

# ── 3. permissions ────────────────────────────────────────────────────────────
if [ "$SKIP_PERMS" = 0 ]; then
  say "3. permissions"
  # Slots get traverse (x) on the path to a profile only while a run holds it
  # (the runner adds and removes that ACL). Nothing here is readable by "other".
  run chmod o-rwx "$SERVICE_HOME"
  exists "$SECRETS_FILE" && run chmod 0600 "$SECRETS_FILE"
  for d in "$TOKENS_DIR" "$DATA_DIR" "$USERS_DIR" \
           "$SERVICE_HOME/.claude" "$SERVICE_HOME/.codex" "$SERVICE_HOME/.config" \
           "$SERVICE_HOME/.local/share" "$SERVICE_HOME/.ssh" "$SERVICE_HOME/.config/gcloud"; do
    exists "$d" && run chmod -R o-rwx "$d"
  done
  exists "$SERVICE_HOME/.claude.json" && run chmod 0600 "$SERVICE_HOME/.claude.json"
  # Per-profile MCP config files are regenerated every run. Old ones carried
  # server-side env for the MCP servers — remove them so none lingers in a
  # directory a slot will be able to read.
  if exists "$USERS_DIR"; then
    if [ "$APPLY" = 1 ]; then
      find "$USERS_DIR" -maxdepth 4 -type f \( -name .mcp.json -o -name .opencode-mcp.json \) -print -delete
    else
      echo "[dry-run] find $USERS_DIR -maxdepth 4 -type f ( -name .mcp.json -o -name .opencode-mcp.json ) -delete"
      find "$USERS_DIR" -maxdepth 4 -type f \( -name .mcp.json -o -name .opencode-mcp.json \) 2>/dev/null | sed 's/^/    would delete: /' || true
    fi
  fi
  # MCP bridge socket dir: slots may traverse it (the runner grants x on its
  # ancestors per run); the socket name is random and the run token is the auth.
  exists "$DATA_DIR" || run install -d -m 0750 -o "$SERVICE_USER" "$DATA_DIR"
  run install -d -m 0711 -o "$SERVICE_USER" "$BRIDGE_DIR"
  run install -d -m 0700 -o "$SERVICE_USER" "$SLOT_LOCK_DIR"
fi

# ── 3a. prepare profile gates ahead of time ───────────────────────────────────
# The runner prepares a gate on its first isolated run (src/agent-isolation.js,
# gatePrepareCommands) — synchronously, which for a big profile (browser caches)
# would stall the service. Do it here once, with the SAME commands, for every
# existing profile workspace and engineering workspace.
if [ "$SKIP_PERMS" = 0 ] && [ "$MODE" = run-as ]; then
  say "3a. prepare profile gates (group ACLs inside, none on the gate itself)"
  for gate in "$USERS_DIR"/*/ "$DATA_DIR"/engineering-workspaces/*/*/; do
    [ -d "$gate" ] || continue
    gate="${gate%/}"
    if [ -e "$gate/.agent-acl-v1" ]; then echo "prepared: $gate"; continue; fi
    run chmod o-rwx "$gate"
    run setfacl -R -P -m "g:${GROUP}:rwX,d:g:${GROUP}:rwX,d:u:${SERVICE_USER}:rwX,m::rwx,d:m::rwx" "$gate"
    run setfacl -x "g:${GROUP}" "$gate"
    if [ "$APPLY" = 1 ]; then date -u +%FT%TZ > "$gate/.agent-acl-v1"; chown "$SERVICE_USER" "$gate/.agent-acl-v1"
    else echo "[dry-run] mark $gate/.agent-acl-v1"; fi
  done
fi

# ── 3b. engine binaries under the service home ────────────────────────────────
if [ "$SKIP_ENGINES" = 0 ] && [ "$MODE" = run-as ]; then
  say "3b. engine binaries reachable by $GROUP (read+exec only)"
  for b in $ENGINE_BINS; do
    p="$(sudo -n -u "$SERVICE_USER" -H bash -lc "command -v $b" 2>/dev/null || true)"
    [ -n "$p" ] || { echo "not found for $SERVICE_USER: $b"; continue; }
    real="$(readlink -f "$p")"
    case "$real" in
      "$SERVICE_HOME"/*) ;;
      *) echo "system-wide, nothing to do: $b -> $real"; continue ;;
    esac
    # package root: the node_modules/<pkg> (or @scope/pkg) dir, else the bin's dir
    root="$(dirname "$real")"
    if [[ "$real" =~ ^(.*/node_modules/(@[^/]+/)?[^/]+)/ ]]; then root="${BASH_REMATCH[1]}"; fi
    if [[ "$real" =~ ^(.*/\.nvm/versions/node/[^/]+)/ ]]; then root="${BASH_REMATCH[1]}"; fi
    echo "$b -> $real (grant rX on $root)"
    run setfacl -R -m "g:${GROUP}:rX" "$root"
    [ "$p" = "$real" ] || run setfacl -m "g:${GROUP}:rX" "$(dirname "$p")"
    d="$(dirname "$root")"
    while [ "$d" != "$SERVICE_HOME" ] && [ "$d" != "/" ]; do
      run setfacl -m "g:${GROUP}:x" "$d"; d="$(dirname "$d")"
    done
    run setfacl -m "g:${GROUP}:x" "$SERVICE_HOME"
  done
  echo "note: installing engines system-wide (e.g. /usr/local) avoids any ACL on the service home."
fi

# ── 4. firewall ───────────────────────────────────────────────────────────────
if [ "$SKIP_FIREWALL" = 0 ] && [ "$MODE" = run-as ]; then
  say "4. firewall for group $GROUP (metadata endpoint + local service ports)"
  FW_SCRIPT=/usr/local/sbin/ta-agents-firewall.sh
  FW_RULES="#!/bin/sh
# managed by scripts/ops/agent-isolation-setup.sh (issue #1649) — idempotent
set -e
for ipt in iptables ip6tables; do
  command -v \$ipt >/dev/null 2>&1 || continue
  \$ipt -N TA_AGENTS_OUT 2>/dev/null || \$ipt -F TA_AGENTS_OUT
  \$ipt -C OUTPUT -m owner --gid-owner ${GROUP} -j TA_AGENTS_OUT 2>/dev/null || \\
    \$ipt -I OUTPUT 1 -m owner --gid-owner ${GROUP} -j TA_AGENTS_OUT
done
# cloud metadata endpoint (and the whole link-local range)
iptables -A TA_AGENTS_OUT -d 169.254.0.0/16 -j REJECT
# local DNS stub stays reachable
iptables -A TA_AGENTS_OUT -d 127.0.0.53 -p udp --dport 53 -j RETURN
iptables -A TA_AGENTS_OUT -d 127.0.0.53 -p tcp --dport 53 -j RETURN"
  # Destination = any address of THIS host (addrtype LOCAL), not only 127.0.0.0/8:
  # services bound to 0.0.0.0 are otherwise reachable through the host's own IPs.
  if [ "$LOOPBACK_POLICY" = deny ]; then
    FW_RULES="$FW_RULES
iptables -A TA_AGENTS_OUT -m addrtype --dst-type LOCAL -p tcp -j REJECT
ip6tables -A TA_AGENTS_OUT -m addrtype --dst-type LOCAL -p tcp -j REJECT 2>/dev/null || true"
  else
    for port in ${BLOCK_PORTS//,/ }; do
      FW_RULES="$FW_RULES
iptables -A TA_AGENTS_OUT -m addrtype --dst-type LOCAL -p tcp --dport $port -j REJECT
ip6tables -A TA_AGENTS_OUT -m addrtype --dst-type LOCAL -p tcp --dport $port -j REJECT 2>/dev/null || true"
    done
  fi
  printf '%s\n' "$FW_RULES" | write_file "$FW_SCRIPT" 0755
  cat <<EOF | write_file /etc/systemd/system/ta-agents-firewall.service 0644
[Unit]
Description=Firewall rules for trained-assist agent slot users (issue #1649)
After=network-pre.target
Before=${UNIT}.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${FW_SCRIPT}

[Install]
WantedBy=multi-user.target
EOF
  systemctl_run daemon-reload
  systemctl_run enable --now ta-agents-firewall.service
fi

# ── 5. systemd drop-in ────────────────────────────────────────────────────────
if [ "$SKIP_SYSTEMD" = 0 ]; then
  say "5. systemd drop-in for $UNIT (takes effect on the NEXT restart — not restarted here)"
  if [ "$MODE" = run-as ]; then
    SWITCHES="Environment=AGENT_RUN_AS_USERS=${SLOT_CSV}
Environment=AGENT_RUN_AS_GROUP=${GROUP}
Environment=AGENT_SERVICE_USER=${SERVICE_USER}"
  else
    SWITCHES="Environment=AGENT_ENV_ALLOWLIST=1"
  fi
  cat <<EOF | write_file "/etc/systemd/system/${UNIT}.service.d/agent-isolation.conf" 0644
# managed by scripts/ops/agent-isolation-setup.sh (issue #1649)
[Service]
UMask=${UMASK_VALUE}
Environment=AGENT_MCP_BRIDGE_DIR=${BRIDGE_DIR}
Environment=AGENT_SLOT_LOCK_DIR=${SLOT_LOCK_DIR}
${SWITCHES}
EOF
  systemctl_run daemon-reload
  echo "rollback: remove that drop-in, systemctl daemon-reload, restart $UNIT"
fi

# ── 6. service account review (read-only) ─────────────────────────────────────
if [ "$SKIP_SA_REVIEW" = 0 ]; then
  say "6. VM service account review (read-only; never changes IAM)"
  MD="http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default"
  if [ "$APPLY" = 1 ] && command -v curl >/dev/null 2>&1; then
    email="$(curl -s -m 3 -H 'Metadata-Flavor: Google' "$MD/email" || true)"
    scopes="$(curl -s -m 3 -H 'Metadata-Flavor: Google' "$MD/scopes" || true)"
    echo "service account: ${email:-<not on GCE>}"
    echo "access scopes:"; printf '%s\n' "$scopes" | sed 's/^/  /'
    if [ -n "$email" ] && command -v gcloud >/dev/null 2>&1; then
      project="$(curl -s -m 3 -H 'Metadata-Flavor: Google' http://169.254.169.254/computeMetadata/v1/project/project-id || true)"
      echo "project IAM roles of $email:"
      gcloud projects get-iam-policy "$project" --flatten='bindings[].members' \
        --filter="bindings.members:serviceAccount:$email" --format='value(bindings.role)' | sed 's/^/  /' || true
      echo "secret-level bindings are listed by: gcloud secrets get-iam-policy <name>"
    fi
  else
    echo "[dry-run] curl -H 'Metadata-Flavor: Google' $MD/{email,scopes}"
    echo "[dry-run] gcloud projects get-iam-policy <project> --filter=bindings.members:serviceAccount:<email>"
  fi
  echo "review: the service itself needs Secret Manager access; slots must not reach metadata (step 4)."
  echo "consider narrowing the SA to secretmanager.secretAccessor on the specific secrets it loads."
fi

# ── verify ────────────────────────────────────────────────────────────────────
if [ "$VERIFY" = 1 ] && [ "$MODE" = run-as ]; then
  say "verify (negative checks as ${SLOT_USERS[0]})"
  if [ "$APPLY" != 1 ]; then echo "(skipped in dry run)"; else
    s="${SLOT_USERS[0]}"; fail=0
    check_denied() { if sudo -u "$s" -- sh -c "$1" >/dev/null 2>&1; then echo "FAIL: $2"; fail=1; else echo "ok:   $2"; fi; }
    check_denied "cat '$SECRETS_FILE'" "secrets file not readable"
    check_denied "ls '$TOKENS_DIR'" "tokens root not listable"
    check_denied "ls '$USERS_DIR'" "profiles root not listable"
    check_denied "ls '$SERVICE_HOME/.claude'" "service engine credentials not readable"
    if command -v curl >/dev/null 2>&1 && [ "$SKIP_FIREWALL" = 0 ]; then
      check_denied "curl -s -m 3 -H 'Metadata-Flavor: Google' http://169.254.169.254/computeMetadata/v1/" "metadata endpoint blocked"
    fi
    [ "$fail" = 0 ] || die "verification failed"
  fi
fi

echo
[ "$APPLY" = 1 ] && echo "done. restart $UNIT when ready." || echo "dry run only — re-run with --apply (as root) to make these changes."
