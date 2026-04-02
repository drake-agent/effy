#!/bin/bash
# check-effy-prefix.sh — pre-commit hook
# 슬래시 커맨드에 effy_ 접두어가 빠졌는지 검사합니다.
#
# 사용법:
#   .husky/pre-commit에 추가:  bash .test/check-effy-prefix.sh
#   또는 수동 실행:            bash .test/check-effy-prefix.sh

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

TARGET="src/gateway/adapters/slack.js"

if [ ! -f "$TARGET" ]; then
  echo -e "${RED}[effy-prefix] $TARGET not found${NC}"
  exit 1
fi

# app.command('/xxx' 에서 /effy_ 로 시작하지 않는 것 검출
# /effy 단독 (observer 통합)은 허용
VIOLATIONS=$(grep -nE "app\.command\('/[a-z]" "$TARGET" | grep -v "effy_" | grep -v "'/effy'" || true)

if [ -n "$VIOLATIONS" ]; then
  echo -e "${RED}[effy-prefix] 슬래시 커맨드에 effy_ 접두어가 누락되었습니다!${NC}"
  echo ""
  echo "위반 항목:"
  echo "$VIOLATIONS" | while IFS= read -r line; do
    echo -e "  ${RED}$line${NC}"
  done
  echo ""
  echo "모든 슬래시 커맨드는 /effy_ 접두어를 포함해야 합니다."
  echo "예: app.command('/effy_kpi', ...) (O)"
  echo "    app.command('/kpi', ...)      (X)"
  echo ""
  echo -e "수정 후 다시 커밋해주세요."
  exit 1
else
  echo -e "${GREEN}[effy-prefix] 슬래시 커맨드 접두어 검사 통과 ✅${NC}"
  exit 0
fi
