#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# push-all.sh — Effy 3-remote commit & push utility
#
# Usage:
#   ./scripts/push-all.sh                     # push only (no commit)
#   ./scripts/push-all.sh -m "commit message" # commit + push
#   ./scripts/push-all.sh --status            # show status only
#
# Remotes:
#   drake  → drake-agent/effy          (main)
#   origin → fnco-ax/ax-svc-effy       (feature/v4.0-migration)
#   fnf    → fnf-ea/effy               (feature/v4.0-migration)
# ═══════════════════════════════════════════════════════════
set -euo pipefail

# ─── Config ───
LOCAL_BRANCH="drake-main"
DRAKE_REMOTE="drake"
DRAKE_BRANCH="main"
ORIGIN_REMOTE="origin"
ORIGIN_BRANCH="feature/v4.0-migration"
FNF_REMOTE="fnf"
FNF_BRANCH="feature/v4.0-migration"

# ─── Colors ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; }
info() { echo -e "  ${CYAN}ℹ  $1${NC}"; }

# ─── Status only ───
if [[ "${1:-}" == "--status" ]]; then
  echo -e "\n${YELLOW}═══ Effy Git Status ═══${NC}\n"
  echo -e "${CYAN}Branch:${NC} $(git branch --show-current)"
  echo -e "${CYAN}Commit:${NC} $(git log --oneline -1)"
  echo ""
  git status --short
  echo -e "\n${CYAN}Remotes:${NC}"
  git remote -v | sed 's/ghp_[^@]*@/***@/g'
  exit 0
fi

echo -e "\n${YELLOW}═══════════════════════════════════════════════${NC}"
echo -e "${YELLOW}  Effy Push-All — 3 Remote Deploy${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════${NC}\n"

# ─── Commit (optional) ───
if [[ "${1:-}" == "-m" && -n "${2:-}" ]]; then
  COMMIT_MSG="$2"
  echo -e "${CYAN}[1/4] Committing...${NC}"

  # Stage modified + new files (exclude .env, credentials)
  git add -A -- ':!.env' ':!.env.*' ':!credentials*' ':!*.pem' ':!*.key'

  STAGED=$(git diff --cached --stat | tail -1)
  if [[ -z "$STAGED" ]]; then
    info "Nothing to commit — skipping to push"
  else
    git commit -m "$COMMIT_MSG

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
    ok "Committed: $(git log --oneline -1)"
  fi
else
  echo -e "${CYAN}[1/4] No commit requested (push only)${NC}"
  info "Use -m \"message\" to commit first"
fi

# ─── Syntax check ───
echo -e "\n${CYAN}[2/4] Syntax check...${NC}"
ERRORS=0
for f in $(git diff --name-only HEAD~1..HEAD 2>/dev/null | grep '\.js$'); do
  if [[ -f "$f" ]]; then
    if ! node -c "$f" 2>/dev/null; then
      fail "$f has syntax errors!"
      ERRORS=$((ERRORS + 1))
    fi
  fi
done
if [[ $ERRORS -gt 0 ]]; then
  fail "Aborting push — $ERRORS file(s) have syntax errors"
  exit 1
fi
ok "All JS files pass syntax check"

# ─── Push ───
echo -e "\n${CYAN}[3/4] Pushing to 3 remotes...${NC}\n"

push_remote() {
  local REMOTE=$1
  local REMOTE_BRANCH=$2
  local LABEL=$3

  if git push "$REMOTE" "${LOCAL_BRANCH}:${REMOTE_BRANCH}" 2>&1 | grep -q "->"; then
    ok "$LABEL → $REMOTE/$REMOTE_BRANCH"
  else
    # Already up to date
    info "$LABEL → $REMOTE/$REMOTE_BRANCH (already up to date)"
  fi
}

push_remote "$DRAKE_REMOTE"  "$DRAKE_BRANCH"  "drake-agent/effy"
push_remote "$ORIGIN_REMOTE" "$ORIGIN_BRANCH" "fnco-ax/ax-svc-effy"
push_remote "$FNF_REMOTE"    "$FNF_BRANCH"    "fnf-ea/effy"

# ─── Summary ───
echo -e "\n${CYAN}[4/4] Summary${NC}"
echo -e "  ${GREEN}Commit:${NC} $(git log --oneline -1)"
echo -e "  ${GREEN}Branch:${NC} $LOCAL_BRANCH"
echo -e "  ${GREEN}Pushed:${NC} $DRAKE_REMOTE/$DRAKE_BRANCH, $ORIGIN_REMOTE/$ORIGIN_BRANCH, $FNF_REMOTE/$FNF_BRANCH"
echo -e "\n${GREEN}═══ Done ═══${NC}\n"
