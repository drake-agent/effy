# Effy v3.6.2

**팀의 두뇌가 되는 AI.** Slack 한 마디에 팀 전체가 똑똑해집니다.

대화가 지식이 되고, 결정이 기록되고, 반복이 사라집니다.

---

## 핵심 엔진

### 🧠 4-Layer Memory
대화가 일회성으로 사라지지 않습니다. Working → Episodic → Semantic → Entity. 결정사항은 영구 기록되고, 매일 밤 Nightly Distiller가 교훈을 추출합니다.

### 🤖 5 Agent × 4-Tier Routing
General, Code, Ops, Knowledge, Strategy — 역할별 에이전트. 질문 복잡도에 따라 Haiku($1/M) → Sonnet → Opus → Opus+Extended Thinking($75/M) 자동 배정. 비용 자동 최적화.

### 👁️ Ambient Intelligence (Observer)
@멘션 없이 모든 채널을 관찰합니다. 의사결정 자동 감지, 미답변 질문에 지식 제안, 크로스채널 이슈 연결. 프롬프트 없는 AI.

### 🔄 Self-Improvement Loop
교정 감지 → Lesson 생성 → Committee 투표 → Nightly Distillation. 시간이 지날수록 나아집니다.

---

## 팀원이 체감하는 것

- **☀️ 아침 브리핑** — 매일 아침, 100명이 각자 다른 개인화 DM 브리핑
- **🔍 전문가 찾기** — "이 주제는 @drake가 3주 전에 다뤘습니다"
- **📝 자동 요약** — 스레드 논의 끝나면 결정사항 + 액션 아이템 자동 정리
- **🚀 신규 멤버 온보딩** — 지난 3개월 핵심 결정을 자동 브리핑
- **🔄 중복 답변 연결** — 같은 질문 3번째면 이전 답변 자동 링크
- **📎 파일 찾기** — Slack에 공유된 CSV, 코드, 링크 즉시 검색

---

## 주요 기능

| 카테고리 | 기능 |
|---|---|
| **에이전트** | 5개 전문 에이전트, 4-Tier 모델 라우팅, Multi-LLM Fallback (Claude → OpenAI gpt-5.4) |
| **메모리** | 4-Layer Memory, Nightly Distillation, Context Hub (602 API docs), Session Summary |
| **도구** | 31개 도구, Admin 권한 체계, Tool Result Guard, Quality Gate |
| **관찰** | Observer (Ambient Intelligence), Pattern Detector, Proactive Engine, Feedback Loop |
| **자동화** | Workflow Engine, SOP 자동 감지, Webhook Outbound, Morning Briefing |
| **온보딩** | 대화형 온보딩 (조직 + 개인), Smart Onboarding, Natural Language Config |
| **거버넌스** | Change Control (CRITICAL/HIGH 승인 게이트), Committee 투표, Audit Trail |
| **대시보드** | Mission Control (Recharts, SSE 실시간), 비용 추적, 에이전트 상태 |
| **플랫폼** | Slack + Microsoft Teams, 실시간 스트리밍 응답, 첨부파일 텍스트 추출 |
| **문서** | Document Ingestion (Notion, Google Drive, 로컬), Context Hub Custom Source |

---

## 빠른 시작

### 1. 설치

```bash
git clone https://github.com/drake-agent/effy.git
cd effy
npm install
```

### 2. 환경변수

```bash
cp .env.example .env
```

`.env`에 3개만 입력:
```
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx
SLACK_BOT_TOKEN=xoxb-xxxxxxxxxxxx
SLACK_APP_TOKEN=xapp-xxxxxxxxxxxx
```

### 3. DB 초기화 + 실행

```bash
npm run db:init
npm start
```

### 4. Slack에서

```
@Effy 안녕
```

처음 말을 걸면 온보딩이 시작됩니다.

---

## Slack App 설정

### Bot Token Scopes
```
app_mentions:read, channels:history, channels:read, chat:write,
commands, files:read, im:history, im:read, im:write, reactions:read, users:read
```

### Event Subscriptions
```
app_mention, message.channels, message.im, reaction_added
```

### Slash Commands
```
/kpi, /search, /dashboard, /committee, /effy, /agent
```

### App Home
Messages Tab 활성화 + "Allow users to send messages" 체크

---

## Teams 지원

```yaml
# effy.config.yaml
channels:
  teams:
    enabled: true
    appId: ${TEAMS_APP_ID}
    appPassword: ${TEAMS_APP_PASSWORD}
```

```bash
npm install botbuilder  # 또는 @microsoft/agents-hosting
```

Microsoft 365 Agents SDK 기반. 봇 설치 채널에서 Observer 관찰 + Proactive DM + Adaptive Card 투표 지원.

---

## Multi-LLM Fallback

```yaml
llm:
  fallback:
    enabled: true
    apiKey: ${OPENAI_API_KEY}
```

Claude 장애 시 OpenAI gpt-5.4로 자동 전환. 5분 후 primary 재시도.

| Claude | OpenAI Fallback |
|---|---|
| Haiku | gpt-5.4-nano |
| Sonnet | gpt-5.4-mini |
| Opus | gpt-5.4 |

---

## 테스트

```bash
npm run test:tier1   # 411 unit tests
npm run test:tier2   # 277 integration + stress tests
```

24 files, 688 tests, 0 failures. 32 Round 코드 리뷰, 107 findings, 69 fixes.

---

## Tech Stack

- **Runtime**: Node.js 22+, Express
- **Database**: SQLite (Phase 1), FTS5
- **LLM**: Anthropic Claude (primary), OpenAI GPT (fallback)
- **Messaging**: Slack Bolt 4.6, Microsoft 365 Agents SDK
- **Memory**: 4-Layer (Working → Episodic → Semantic → Entity) + MemoryGraph

---

## License

UNLICENSED — Private use only.
