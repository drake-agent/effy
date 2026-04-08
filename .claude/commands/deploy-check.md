# Effy 배포 체크 및 자동 패치

## 1. 원격 변경 확인
```bash
git fetch origin main --quiet
```
`git log HEAD..origin/main --oneline`으로 새 커밋이 있는지 확인.
- 새 커밋이 없으면 "최신 상태 — 변경 없음"만 출력하고 종료.

## 2. 새 커밋이 있으면 배포 진행

### 2-1. 로컬 변경 처리
- `git status`로 로컬 변경 확인
- 변경이 있으면 `git stash`

### 2-2. Pull
```bash
git pull
```
- 충돌 시: .env, docker-compose.yml, effy.config.yaml은 로컬 설정 보존 필요
  - 서버(upstream) 기준으로 충돌 해결
  - 이후 로컬 전용 설정 재적용:
    - `docker-compose.yml`: 포트 `0.0.0.0:5435`
    - `effy.config.yaml`: `channels.slack.enabled: true`

### 2-3. 의존성 설치
```bash
npm install --legacy-peer-deps
```

### 2-4. DB 마이그레이션
```bash
DATABASE_URL=postgres://effy:effy_local_dev@localhost:5435/effy node src/db/migrate-cli.js
```

### 2-5. PG 컨테이너 확인
```bash
docker ps --filter name=effy-postgres --format "{{.Status}}"
```
- 실행 중이 아니면 `docker compose up -d effy-postgres`

### 2-6. pm2 재시작
```bash
pm2 restart effy --update-env
```

### 2-7. 검증
4초 대기 후:
```bash
pm2 logs effy --lines 30 --nostream
curl -s http://localhost:3100/health
```

확인 항목:
- DB: PostgreSQL
- Channels에 slack 포함
- health OK
- FATAL/crash 에러 없음

### 2-8. Slack 배포 알림
MCP를 통해 `work-effy-ops` 채널(C0AMBBLD0RM)에 배포 결과를 전송한다.
`mcp__fnf-slack-mcp__slack_send_message` 도구를 사용하며, 메시지 형식:

```
🚀 Effy 배포 완료
- 버전: (package.json version)
- 커밋: (새로 반영된 커밋 목록, 각 한줄)
- DB: PostgreSQL
- Health: OK / FAIL
- 에러: 없음 / (에러 내용 요약)
- 해결된 이슈: #XX, #YY (있을 경우)
```

배포 실패 시에도 알림을 보내되, 실패 내용을 명시한다.

### 2-9. GitHub 이슈 자동 매칭 및 클로즈
배포된 커밋들의 변경 파일과 내용을 분석하여 GitHub 오픈 이슈와 매칭한다.

1. `gh issue list --state open --limit 30`으로 오픈 이슈 목록 확인
2. `.docs/ops-status.md`의 반복 에러 테이블 참조
3. 각 이슈에 대해:
   - 이슈에 언급된 파일(예: `manager.js:495`, `gateway.js:710`)이 이번 커밋에서 수정됐는지 확인
   - 수정된 경우, 해당 코드를 읽어서 이슈의 원인이 실제로 해결됐는지 분석
   - **해결 확인 시**: 이슈에 코멘트 + 클로즈
     ```bash
     gh issue comment <번호> --body "이 커밋에서 수정됨: <커밋 hash> — <수정 내용 요약>"
     gh issue close <번호>
     ```
   - **부분 해결 시**: 이슈에 코멘트만 (클로즈 안 함)
     ```bash
     gh issue comment <번호> --body "부분 수정: <커밋 hash> — <수정된 부분> / 남은 문제: <미해결 부분>"
     ```
   - **미해결 시**: 스킵

4. 클로즈한 이슈가 있으면 `.docs/ops-status.md`에서 해당 항목 제거
5. Slack 알림에 클로즈한 이슈 목록 추가

### 2-10. 결과 보고
변경된 커밋 목록과 배포 결과를 간결하게 보고.
에러가 있으면 상세히 보고하고 롤백하지 말고 대기.
