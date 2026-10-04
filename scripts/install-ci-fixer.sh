#!/usr/bin/env bash
# Install CI auto-fixer into a target GitHub repository.
#
# Usage:
#   ./scripts/install-ci-fixer.sh <owner/repo> [--ci-jobs "ci,staging-gate"]
#
# What it does:
#   1. Clones the target repo to a temp dir
#   2. Adds autofix job to the CI workflow (calls trained-assist/pr-autofix@v1)
#   3. Copies ci-fix-cleanup.yml
#   4. Creates a branch + commit + PR in the target repo
#
# Required: gh CLI authenticated
# Required secret: LLM_LADDER_TOKEN (org-level in trained-assist, visibility all) — see output

set -euo pipefail

TARGET_REPO="${1:-}"
CI_JOBS="ci"   # comma-separated list of jobs that trigger autofix on failure

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ci-jobs)
      CI_JOBS="$2"
      shift 2
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$TARGET_REPO" ]; then
  echo "Usage: $0 <owner/repo> [--ci-jobs 'ci,staging-gate']"
  echo ""
  echo "Examples:"
  echo "  $0 myorg/my-web-app"
  echo "  $0 myorg/my-web-app --ci-jobs 'ci,staging-gate'"
  exit 1
fi

echo "Installing CI auto-fixer into $TARGET_REPO"
echo "  Jobs that trigger autofix: $CI_JOBS"
echo ""

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

gh repo clone "$TARGET_REPO" "$TMPDIR/repo" -- --depth=1 --quiet
cd "$TMPDIR/repo"

DEFAULT_BRANCH=$(git symbolic-ref --short HEAD)
INSTALL_BRANCH="ci-fixer/install-$(date +%s)"
git checkout -b "$INSTALL_BRANCH"
mkdir -p .github/workflows

# ── Build the needs array and condition ─────────────────────────────────────
NEEDS_ARRAY=$(echo "$CI_JOBS" | tr ',' '\n' | sed 's/^/"/;s/$/"/' | paste -sd ',' -)
NEEDS_CONDITION=$(echo "$CI_JOBS" | tr ',' '\n' | sed "s/.*/needs['&'].result == 'failure'/" | paste -sd ' ||
        ' -)

# ── Append autofix job to the CI workflow ───────────────────────────────────
# Find the main ci.yml (most common name, fall back to other names)
CI_WORKFLOW=""
for name in ci.yml CI.yml main.yml build.yml test.yml; do
  if [ -f ".github/workflows/$name" ]; then
    CI_WORKFLOW=".github/workflows/$name"
    break
  fi
done

if [ -z "$CI_WORKFLOW" ]; then
  echo "⚠️  Could not find a CI workflow file. Creating standalone autofix.yml..."
  CI_WORKFLOW=".github/workflows/autofix.yml"
  cat > "$CI_WORKFLOW" <<WORKFLOW
name: PR Autofix

on:
  pull_request:
    branches: [main]

jobs:
WORKFLOW
fi

# Check if autofix job already exists
if grep -q "^  autofix:" "$CI_WORKFLOW"; then
  echo "⚠️  autofix job already exists in $CI_WORKFLOW — skipping"
else
  cat >> "$CI_WORKFLOW" <<AUTOFIXJOB

  autofix:
    needs: [$NEEDS_ARRAY]
    if: |
      always() &&
      github.event_name == 'pull_request' &&
      !github.event.pull_request.draft &&
      (
        $NEEDS_CONDITION
      ) &&
      !startsWith(github.head_ref, 'fix/ci-')
    permissions:
      contents: write
      pull-requests: write
    uses: trained-assist/pr-autofix/.github/workflows/autofix-callable.yml@v1.7.2
    with:
      pr_number: \${{ github.event.pull_request.number }}
      original_branch: \${{ github.head_ref }}
      run_id: \${{ github.run_id }}
    secrets:
      llm_ladder_token: \${{ secrets.LLM_LADDER_TOKEN }}
      gh_token: \${{ secrets.AUTOFIX_PAT || github.token }}
AUTOFIXJOB
fi

# ── Copy ci-fix-cleanup.yml ──────────────────────────────────────────────────
curl -fsSL \
  https://raw.githubusercontent.com/trained-assist/pr-autofix/main/templates/ci-fix-cleanup.yml \
  -o .github/workflows/ci-fix-cleanup.yml

# ── Commit and push ───────────────────────────────────────────────────────────
git add .github/workflows/
git -c user.name="CI Fixer Installer" \
    -c user.email="autofix@trained-assist.bot" \
    commit -m "ci: add pr-autofix callable workflow

Uses trained-assist/pr-autofix@v1 (https://github.com/trained-assist/pr-autofix).
On CI failure: diagnoses root cause, patches with free OpenRouter models,
creates fix/ci-* branch + PR that auto-merges when CI passes.

Requires LLM_LADDER_TOKEN (org secret in trained-assist; model calls go to the llm-ladder worker)."

git push origin "$INSTALL_BRANCH"

PR_URL=$(gh pr create \
  --repo "$TARGET_REPO" \
  --base "$DEFAULT_BRANCH" \
  --head "$INSTALL_BRANCH" \
  --title "ci: add pr-autofix callable workflow" \
  --body "$(cat <<'EOF'
## CI Auto-Fixer

Connects [trained-assist/pr-autofix](https://github.com/trained-assist/pr-autofix) as a reusable GitHub Action.

### How it works

1. CI fails on a PR → `autofix` job triggers
2. Free OpenRouter models diagnose + patch the issue
3. A `fix/ci-*` branch + PR is created — never touches the original branch
4. The fix PR auto-merges when CI passes
5. `ci-fix-cleanup.yml` closes the original PR after the fix merges

### Required: add one secret

**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
|--------|-------|
| `LLM_LADDER_TOKEN` | trained-assist-llm-ladder worker token (org secret in trained-assist; GCP SM `LLM_LADDER_TOKEN`) |

Optionally add `AUTOFIX_PAT` (Fine-Grained PAT with contents+pull_requests write) if your org restricts workflow write permissions.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)")

echo ""
echo "✅ Done! PR created: $PR_URL"
echo ""
echo "⚠️  Required step:"
echo "   LLM_LADDER_TOKEN is an org secret in trained-assist (visibility all); outside the org add it to $TARGET_REPO secrets:"
echo "   https://github.com/$TARGET_REPO/settings/secrets/actions"
echo "   Value: GCP Secret Manager LLM_LADDER_TOKEN (project alesa-personal-assistent)"
