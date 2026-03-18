# Effy Slack Bot — Mac Mini 설치 가이드

> 소요 시간: ~30분
> 대상: Mac Mini (Apple Silicon 또는 Intel)
> 전제: macOS, 터미널 사용 가능

---

## 0. 사전 준비 체크리스트

```
□ Mac Mini에 macOS 접근 가능 (SSH 또는 직접)
□ Anthropic API 키 보유 (https://console.anthropic.com)
□ Slack 워크스페이스 관리자 권한
□ (선택) GitHub 레포 Webhook 설정 권한
```

---

## 1. Node.js 설치

```bash
# Homebrew 없으면 먼저 설치
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node.js 20 LTS
brew install node@20

# 확인
node --version   # v20.x.x 이상
npm --version    # 10.x.x 이상
```

---

## 2. 프로젝트 클론 & 의존성 설치

```bash
# 작업 디렉토리
cd ~
git clone <your-repo-url> effy
cd effy

# npm 패키지 설치
npm install
```

> Git 레포 없이 시작하는 경우: 이 폴더 전체를 USB/scp로 Mac Mini에 복사 후 `npm install`

---

## 3. Slack App 생성

### 3-1. 앱 생성
1. https://api.slack.com/apps → **Create New App** → **From scratch**
2. App Name: `Effy` (또는 원하는 이름)
3. Workspace: 팀 워크스페이스 선택

### 3-2. Socket Mode 활성화
1. 좌측 **Socket Mode** → **Enable Socket Mode** 켜기
2. Token Name: `socket-token` → **Generate**
3. 생성된 토큰 복사 → 이것이 `SLACK_APP_TOKEN` (xapp-로 시작)

### 3-3. Bot Token Scopes
좌측 **OAuth & Permissions** → **Bot Token Scopes**에 추가:

```
app_mentions:read
channels:history
channels:join
channels:read
chat:write
commands
groups:history
groups:read
im:history
im:read
im:write
mpim:history
reactions:read
users:read
```

### 3-4. Event Subscriptions
좌측 **Event Subscriptions** → Enable Events 켜기
**Subscribe to bot events**:

```
app_mention
message.channels
message.groups
message.im
message.mpim
reaction_added
member_joined_channel
channel_created
```

### 3-5. 슬래시 커맨드 등록
좌측 **Slash Commands** → Create New Command:

| Command | Request URL | Description |
|---------|-----------|-------------|
| `/kpi` | (Socket Mode라 URL 불필요) | 팀/개인 KPI 조회 |
| `/search` | (Socket Mode라 URL 불필요) | 크로스채널 검색 |

### 3-6. Install to Workspace
좌측 **Install App** → **Install to Workspace** → 승인
→ **Bot User OAuth Token** 복사 → 이것이 `SLACK_BOT_TOKEN` (xoxb-로 시작)

---

## 4. 환경변수 설정

```bash
cd ~/effy
cp .env.example .env
```

`.env` 파일 편집:

```bash
nano .env
```

```
SLACK_BOT_TOKEN=xoxb-여기에-봇토큰-붙여넣기
SLACK_APP_TOKEN=xapp-여기에-앱토큰-붙여넣기
ANTHROPIC_API_KEY=sk-ant-여기에-API키-붙여넣기

# 나머지는 기본값 유지
DATABASE_URL=sqlite:./data/effy.db
```

저장: `Ctrl+O` → `Enter` → `Ctrl+X`

---

## 5. 데이터베이스 초기화

```bash
# data/ 디렉토리 생성 + 스키마 생성
npm run db:init
```

출력 확인:
```
[db:init] Initializing database...
[db] SQLite initialized: ./data/effy.db
[db:init] Done. Tables created.
```

---

## 6. 테스트 실행

```bash
# 포그라운드에서 먼저 테스트
npm start
```

출력 확인:
```
⚡ Effy bot is running (Socket Mode)
   Sessions idle timeout: 300s
   Concurrency: global=20 user=2 ch=3
   Database: sqlite:./data/effy.db
   Budget profiles: LIGHT(8K) / STANDARD(35K) / DEEP(70K)
```

### 동작 확인:
1. Slack에서 아무 퍼블릭 채널에 봇 초대: `/invite @Effy`
2. `@Effy 안녕 테스트` 입력
3. 봇이 스레드에 응답하면 성공 ✓
4. 봇에 DM 전송 → 응답 오면 DM도 성공 ✓
5. `/kpi team week` → KPI 응답 확인 ✓

문제 있으면 `Ctrl+C`로 종료 후 `.env` 확인.

---

## 7. pm2로 상시 실행

```bash
# pm2 설치 (프로세스 매니저)
npm install -g pm2

# 시작
pm2 start src/app.js --name effy

# 로그 확인
pm2 logs effy

# Mac 재부팅 시 자동 시작
pm2 startup
pm2 save
```

### pm2 명령어 참고:
```bash
pm2 status          # 상태 확인
pm2 restart effy  # 재시작
pm2 stop effy     # 정지
pm2 logs effy --lines 50  # 최근 50줄 로그
```

---

## 8. (선택) GitHub Webhook 연결

### 8-1. Cloudflare Tunnel 설치

```bash
brew install cloudflared

# 터널 로그인 (Cloudflare 계정 필요)
cloudflared tunnel login

# 터널 생성
cloudflared tunnel create effy

# 설정 파일
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: effy
credentials-file: /Users/$(whoami)/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: effy-webhook.yourdomain.com
    service: http://localhost:3100
  - service: http_status:404
EOF

# 터널 시작
cloudflared tunnel run effy

# pm2로 상시 실행
pm2 start "cloudflared tunnel run effy" --name cloudflare-tunnel
pm2 save
```

### 8-2. GitHub Webhook 등록
1. GitHub 레포 → Settings → Webhooks → Add webhook
2. Payload URL: `https://effy-webhook.yourdomain.com/github/webhook`
3. Content type: `application/json`
4. Secret: `.env`의 `GITHUB_WEBHOOK_SECRET` 값
5. Events: **Pull requests**, **Pushes**

### 8-3. .env에 추가
```
GITHUB_WEBHOOK_SECRET=여기에-위에서-설정한-시크릿
GITHUB_WEBHOOK_PORT=3100
```

```bash
pm2 restart effy
```

---

## 9. (선택) GitHub ↔ Slack 유저 매핑

봇 DM 또는 관리자 채널에서:

```sql
-- SQLite에 직접 추가 (초기 설정용)
sqlite3 data/effy.db "INSERT INTO user_mappings (slack_user_id, github_login, display_name) VALUES ('U12345', 'alice-github', 'Alice');"
```

또는 추후 `/map-user @alice alice-github` 슬래시 커맨드 구현.

---

## 10. Mac Mini B (백업) 설정

### 10-1. 동일한 1~7단계 실행 (B 머신에서)

### 10-2. rsync 크론 (A에서 실행)
```bash
# A의 crontab에 추가
crontab -e

# 매시간 DB + 마크다운 동기화
0 * * * * rsync -av ~/effy/data/ drake@mac-mini-b:~/effy/data/
0 * * * * rsync -av ~/effy/memory/ drake@mac-mini-b:~/effy/memory/
```

### 10-3. B에서 pm2 대기 (start 안 함)
```bash
# B에서는 pm2 stop 상태로 유지
pm2 stop effy
```

### 10-4. 장애 절체 스크립트 (B에 저장)
```bash
#!/bin/bash
# ~/failover.sh (Mac Mini B)
# A 다운 감지 시 수동 실행

echo "Starting failover to Mac Mini B..."
pm2 start effy
echo "Effy bot now running on Mac Mini B"
echo "→ Cloudflare DNS를 B의 IP로 수동 전환하세요"
```

---

## 트러블슈팅

| 증상 | 해결 |
|------|------|
| `SLACK_BOT_TOKEN` 에러 | `.env` 파일 확인. `xoxb-`로 시작하는지 확인 |
| `SLACK_APP_TOKEN` 에러 | Socket Mode 활성화 확인. `xapp-`로 시작하는지 확인 |
| 봇이 응답 안 함 | Event Subscriptions에 `app_mention` 등록 확인 |
| `SQLITE_BUSY` 에러 | `npm run db:init`으로 DB 재초기화 |
| npm install 실패 (better-sqlite3) | `xcode-select --install` 실행 후 재시도 |
| API 비용 걱정 | `.env`에서 기본 모델이 Haiku인지 확인 (기본값) |

---

## 파일 구조

```
effy/
├── .env                  ← 환경변수 (git 미포함)
├── .env.example          ← 환경변수 템플릿
├── package.json
├── data/
│   └── effy.db          ← SQLite DB (자동 생성)
├── src/
│   ├── app.js            ← 엔트리포인트
│   ├── config.js         ← 설정 로드
│   ├── db/
│   │   ├── sqlite.js     ← DB 레이어
│   │   └── init.js       ← DB 스키마 초기화
│   ├── core/
│   │   ├── middleware.js  ← 미들웨어 파이프라인
│   │   ├── router.js     ← 이벤트/기능 라우터
│   │   └── pool.js       ← 세션/동시성 관리
│   ├── memory/
│   │   ├── manager.js    ← 4계층 메모리 매니저
│   │   ├── context.js    ← 3경로 병렬 컨텍스트 엔진
│   │   └── indexer.js    ← SessionIndexer + Promotion
│   ├── agents/
│   │   └── base.js       ← Anthropic Agentic Loop
│   └── github/
│       └── webhook.js    ← GitHub Webhook + KPI
└── docs/
    └── ARCHITECTURE_v2.md ← 설계 문서
```
