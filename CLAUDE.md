# Effy — Claude Code 지침

## 프로젝트 개요
- Effy: Multi-Agent AI 봇 (Slack + Teams)
- 런타임: Node.js, pm2, PostgreSQL (Docker/OrbStack)
- 맥미니 로컬 운영 (172.20.45.20)

## 배포 절차 (맥미니 패치 배포)

### 1. Pull
```bash
# 로컬 변경이 있으면 stash 먼저
git stash
git pull
```
- 충돌 시 서버(upstream) 기준으로 해결
- 로컬 설정 파일(.env, docker-compose.yml, effy.config.yaml)은 stash에서 필요한 부분만 재적용
- 불필요한 stash는 `git stash drop`

### 2. 의존성 설치
```bash
npm install --legacy-peer-deps
```
- eslint 피어 의존성 충돌이 있어 `--legacy-peer-deps` 필수

### 3. DB 마이그레이션
```bash
DATABASE_URL=postgres://effy:effy_local_dev@localhost:5435/effy node src/db/migrate-cli.js
```
- 새 마이그레이션 파일이 있을 때만 실행됨 (멱등성)

### 4. pm2 재시작
```bash
pm2 restart effy --update-env
```
- `--update-env` 필수: .env 변경사항 반영

### 5. 검증
```bash
# 부팅 로그 확인 (4초 대기 후)
sleep 4 && pm2 logs effy --lines 30 --nostream

# 확인 항목:
# - DB: PostgreSQL
# - Channels: slack (또는 slack, teams)
# - 에러 없이 부팅 완료
# - [github] Webhook server listening on :3100

# Health check
curl -s http://localhost:3100/health
```

### 6. effy_ 슬래시 커맨드 검증 (슬래시 커맨드 변경 시)
```bash
bash .test/check-effy-prefix.sh
```

## 로컬 환경 설정

### 로컬 전용 설정 (git에 커밋하지 않는 항목)
- `.env`: DB 접속 정보, API 키
- `docker-compose.yml`: 포트 바인딩 `0.0.0.0:5435` (사내망 접근용)
- `effy.config.yaml`: `channels.slack.enabled: true`

### PostgreSQL (Docker)
```bash
# 컨테이너 상태 확인
docker ps --filter name=effy-postgres

# 컨테이너 시작 (중지된 경우)
docker compose up -d effy-postgres

# PG 접속 정보
# Host: localhost (사내망: 172.20.45.20)
# Port: 5435
# User: effy
# Password: effy_local_dev
# Database: effy

# 데이터 확인
docker exec effy-postgres psql -U effy -d effy -c "\dt"
```

### PG 뷰어
- Postico 2 설치됨 (localhost:5435)
- 사내망 다른 PC: 172.20.45.20:5435

## 배포 알림 (Slack MCP)
- 배포 완료/실패 시 `work-effy-ops` 채널(C0AMBBLD0RM)에 결과 전송
- `mcp__fnf-slack-mcp__slack_send_message` 도구 사용
- 자동 배포: `/deploy-check` 스킬 (10분 주기, 24시간)

## 운영 현황 (.docs/ops-status.md)
- 서비스 상태, GitHub 오픈 이슈, 반복 에러, 무시 가능 에러를 추적하는 파일
- `/error-check` 실행 시 자동 갱신됨
- 새 세션 시작 시 이 파일을 참조하여 현재 운영 상태를 파악

## 주의사항
- SQLite 완전 제거됨 (v4.0+), PG 전용
- Teams 어댑터: TEAMS_APP_ID/PASSWORD 미설정 시 에러 (정상, 무시 가능)
- `config.db.phase` 설정은 삭제됨 — `postgresUrl` 또는 환경변수로 PG 연결
