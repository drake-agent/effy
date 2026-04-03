# Effy v4.0

**팀의 두뇌가 되는 AI.** Slack 한 마디에 팀 전체가 똑똑해집니다.

대화가 지식이 되고, 결정이 기록되고, 반복이 사라집니다.

---

## 핵심 엔진

### 🧠 4-Layer Memory
대화가 일회성으로 사라지지 않습니다. Working → Episodic → Semantic → Entity. 결정사항은 영구 기록되고, 매일 밤 Nightly Distiller가 교훈을 추출합니다.

### 🤖 5 Agent × 5-Tier Routing
General, Code, Ops, Knowledge, Strategy — 역할별 에이전트. 질문 복잡도에 따라 Self-Hosted → Haiku($1/M) → Sonnet → Opus → Opus+Extended Thinking($75/M) 자동 배정. Self-Hosted LLM을 최하위 Tier로 활용해 비용 자동 최적화.

### 👁️ Ambient Intelligence (Observer)
@멘션 없이 모든 채널을 관찰합니다. 의사결정 자동 감지, 미답변 질문에 지식 제안, 크로스채널 이슈 연결. 프롬프트 없는 AI.

### 🔄 Self-Improvement Loop
교정 감지 → Lesson 생성 → Committee 투표 → Nightly Distillation. 시간이 지날수록 나아집니다.

---

## v4.0 업데이트

### 🔀 Gateway Pipeline (Strangler Fig)
모놀리식 게이트웨이를 16단계 파이프라인으로 분리했습니다.

- **Pipeline Steps**: middleware → onboarding → binding → function → model → circuitBreaker → concurrency → session → memory → context → budget → agentRuntime → respond
- **Feature Flag**: `EFFY_GATEWAY_V2=true`로 활성화, 환경변수 제거만으로 즉시 롤백
- **Strangler Fig Pattern**: 레거시 게이트웨이와 파이프라인이 동시 공존, 점진적 마이그레이션
- **하위 호환성**: `EFFY_GATEWAY_V2=false` (기본값)이면 기존 모놀리식 그대로 동작

### 🗄️ Dual DB Adapter (PostgreSQL + SQLite)
프로덕션 PostgreSQL과 개발용 SQLite를 통합 어댑터로 지원합니다.

- **Adapter 패턴**: `getAdapter()`로 통합 인터페이스. SQLite 동기 → async 자동 래핑
- **SQL 자동 번역**: `?` → `$1,$2`, `datetime()` → `NOW() + INTERVAL`, `json_extract()` → `jsonb`, `IFNULL` → `COALESCE`, `GROUP_CONCAT` → `STRING_AGG`
- **PostgreSQL Full-Text Search**: FTS5 → tsvector + GIN 인덱스 자동 전환
- **Connection Pool**: `pg` Pool (min/max 설정, idle timeout, 백프레셔)
- **Translation Cache**: SQL 번역 결과 캐싱으로 반복 쿼리 최적화

```yaml
# effy.config.yaml
memory:
  database:
    type: postgres
    host: localhost
    port: 5432
    database: effy
    user: effy
    password: secret
    pool: { min: 2, max: 10 }
```

환경변수로도 설정 가능: `DB_ADAPTER=postgres`, `DATABASE_URL`

### 🏗️ State Externalization (Redis)
인메모리 상태를 Redis로 외부화하여 수평 확장이 가능합니다.

- **StateBackendFactory**: DI 패턴으로 메모리/Redis 백엔드 교체
- **Redis State**: 세션, 대화 상태, 레이트 리밋을 Redis에 저장
- **Stateless Gateway**: 게이트웨이가 무상태가 되어 다중 인스턴스 배포 가능

### 🔌 MCP (Model Context Protocol) 클라이언트
외부 도구 서버를 표준 프로토콜로 연결합니다.

- **Transport**: stdio, SSE, HTTP 스트림 지원
- **Registry**: 도구 자동 발견 + 스키마 검증
- **Remote Registry**: 원격 스킬 카탈로그 동기화

### 📊 Evaluation Framework
에이전트 응답 품질을 정량적으로 측정합니다.

- **5개 메트릭**: Accuracy, Relevance, Coherence, Helpfulness, Safety
- **Collector**: 대화별 점수 자동 수집 + 트렌드 분석
- **A/B 비교**: 프롬프트 변경 전후 품질 차이 측정

### 🌐 분산 아키텍처
단일 프로세스 → 멀티 노드 확장 기반을 제공합니다.

- **Message Bus**: 에이전트 간 비동기 메시지 라우팅
- **Service Discovery**: 에이전트 서비스 자동 등록 + 헬스체크
- **Session Store**: 분산 세션 관리 (Redis 호환)
- **Agent Service**: 독립 배포 가능한 에이전트 래퍼

### 🔭 OpenTelemetry 통합
운영 가시성을 위한 표준 관측 레이어입니다.

- **Traces**: 요청 → 에이전트 → LLM 호출 전체 추적
- **Metrics**: 응답 시간, 토큰 소비, 에러율 Prometheus 포맷
- **자동 계측**: LLM 호출, DB 쿼리, HTTP 요청 자동 span 생성

### 🏠 Self-Hosted LLM 지원
Anthropic/OpenAI 외에 로컬 LLM도 사용할 수 있습니다.

- **vLLM, Ollama, TGI** 등 OpenAI-호환 API 연동
- **모델 라우팅**: Tier별 self-hosted 모델 매핑
- **Keyring 격리**: 멀티테넌트 환경에서 API 키 안전 관리

### 🛡️ 에이전트 고급 기능 (47개 모듈)

- **Agent Scope**: 에이전트별 격리된 실행 컨텍스트 (변수, 도구, 메모리)
- **Autonomy Loop**: 자율 실행 루프 + 인간 승인 게이트
- **Delegation**: 에이전트 간 작업 위임 + 결과 취합
- **Permission Gate**: 위험도별 도구 실행 승인 (자동/사용자확인/관리자)
- **Sandbox**: 코드 실행 격리 (vm2, 시간/메모리 제한)
- **Prompt Router**: 의도 분류 → 에이전트 자동 배정
- **Budget Gate**: 토큰/비용 한도 실시간 차단
- **Fallback Chain**: LLM 실패 시 체인 순서대로 재시도
- **Branch Agent**: 조건 분기 + 병렬 실행 + 결과 병합
- **Outcome Gate**: 응답 품질 미달 시 자동 재생성

### 🔒 메모리 고급 기능

- **Tiered Memory**: 중요도 기반 메모리 자동 승격/아카이브
- **Cross-Channel Recall**: 채널 간 관련 대화 자동 연결
- **Embedding Cache**: 벡터 임베딩 캐시 (중복 호출 제거)
- **Memory Compaction**: 오래된 메모리 압축 + 요약
- **Memory Decay**: 시간 기반 중요도 자동 감쇠
- **Bulletin Board**: 팀 전체 공유 메모리 보드

### 🔐 보안 강화 (v3.6.3 → v4.0 누적)

- **Review Council R1–R2**: 6-agent iterative code review — 25개 파일 수정, 11개 버그/보안/성능 이슈 해결
- SQL 인젝션 방어 (FTS 화이트리스트, 주석 제거 후 세미콜론 탐지, WHERE 절 검증)
- ReDoS 방어 (NL Config 500자 입력 제한, 워크플로 엔진 정규식 감사)
- Shell 인젝션 방어 (pipe-to-interpreter 차단 패턴 확장: node/python/ruby/perl)
- Secret Scrubber (로그 내 API 키/토큰 자동 마스킹)
- SSRF Guard (도구 실행 시 내부 네트워크 접근 차단)
- Context Engine 10초 타임아웃 (무한 대기 방지)
- 빈 catch 블록 16개 파일 전수 로깅 추가
- 0 npm vulnerabilities (path-to-regexp, picomatch, yaml 패치)

### 🧪 QA Level 2–6 (96 신규 테스트)

- **Fuzz Testing**: 5,000+ 랜덤 입력 (fast-check) — FTS injection, ReDoS, shell escape 검증
- **Property-Based Testing**: 26개 불변성 검증 — hash 결정성, 토큰 단조성, 예산 준수
- **Integration E2E**: 14개 전체 파이프라인 스모크 테스트
- **Chaos Engineering**: 15개 장애 주입 — DB 손실, 10K 레코드 압박, 동시성 경합
- **Mutation Testing**: 17개 수동 변이체 — sanitizer, hash, token, shell 보안 로직 사멸 확인

---

## 팀원이 체감하는 것

- **☀️ 아침 브리핑** — 매일 아침, 100명이 각자 다른 개인화 DM 브리핑
- **🔍 전문가 찾기** — "이 주제는 @drake가 3주 전에 다뤘습니다"
- **📝 자동 요약** — 스레드 논의 끝나면 결정사항 + 액션 아이템 자동 정리
- **🚀 신규 멤버 온보딩** — 지난 3개월 핵심 결정을 자동 브리핑
- **🔄 중복 답변 연결** — 같은 질문 3번째면 이전 답변 자동 링크
- **📎 파일 찾기** — Slack에 공유된 CSV, 코드, 링크 즉시 검색
- **📊 실시간 대시보드** — `/dashboard`로 에이전트 상태, 비용, 메모리 사용량 한눈에
- **💚 시스템 건강** — `/health`로 DB, LLM, 메모리 엔진 상태 즉시 확인

---

## 주요 기능

| 카테고리 | 기능 |
|---|---|
| **에이전트** | 5개 전문 에이전트, 5-Tier 모델 라우팅, Multi-LLM Fallback (Claude → OpenAI → Self-Hosted) |
| **게이트웨이** | Pipeline (Strangler Fig), Feature Flag 롤백, Stateless (Redis State) |
| **파이프라인** | Composable Pipeline, Step Library, Branch/Parallel 실행, Circuit Breaker |
| **메모리** | 4-Layer Memory, Nightly Distillation, MemoryGraph, Tiered Memory, Cross-Channel Recall |
| **도구** | 37개 도구, Admin 권한 체계, Tool Isolation, Sandbox, Browser 자동화, SSRF Guard |
| **관찰** | Observer (Ambient Intelligence), Pattern Detector, Proactive Engine, Feedback Loop |
| **자동화** | Workflow Engine, SOP 자동 감지, Webhook Outbound, Morning Briefing, Autonomy Loop |
| **온보딩** | 대화형 온보딩 (조직 + 개인), Smart Onboarding, Natural Language Config |
| **거버넌스** | Change Control, Committee 투표, Permission Gate, Outcome Gate, Audit Trail |
| **대시보드** | Mission Control (Recharts, SSE 실시간), Live Logs, 비용 추적, 에이전트 상태 |
| **플랫폼** | Slack + Microsoft Teams, 실시간 스트리밍 응답, 첨부파일 텍스트 추출 |
| **데이터베이스** | PostgreSQL + SQLite Dual Adapter, FTS5/tsvector, Connection Pool, SQL Translation Cache |
| **관측** | OpenTelemetry (Traces + Metrics), Secret Scrubber, Health Check, Prometheus |
| **분산** | Message Bus, Service Discovery, Session Store, Agent Service, Redis State |
| **MCP** | Model Context Protocol 클라이언트, Transport (stdio/SSE/HTTP), Remote Registry |
| **평가** | Evaluation Framework, 5-Metric Scoring, A/B 비교, Trend Analysis |
| **문서** | Document Ingestion (Notion, Google Drive, 로컬), Context Hub Custom Source |
| **v4.0 모듈** | State (Redis), Distributed, MCP, Evaluation, Tools, Schema, Observability |

---

## 빠른 시작

### 1. 설치

```bash
git clone https://github.com/drake-agent/effy.git
cd effy
nvm use          # Node 24 LTS (.nvmrc)
npm install
npm install pg   # PostgreSQL 사용 시 (선택)
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

PostgreSQL 사용 시 추가:
```
DB_ADAPTER=postgres
DATABASE_URL=postgresql://user:pass@host:5432/effy
```

Redis State 사용 시 추가:
```
REDIS_URL=redis://localhost:6379
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
  selfHosted:
    enabled: true
    baseUrl: http://localhost:8000/v1  # vLLM, Ollama, TGI 등
```

3단계 Fallback: Claude (primary) → OpenAI gpt-5.4 → Self-Hosted LLM. 각 단계 장애 시 자동 전환, 5분 후 상위 Tier 재시도.

| Tier | Claude | OpenAI Fallback | Self-Hosted |
|---|---|---|---|
| Fast | Haiku | gpt-5.4-nano | local-small |
| Standard | Sonnet | gpt-5.4-mini | local-medium |
| Premium | Opus | gpt-5.4 | local-large |

---

## 테스트

```bash
npm run test:tier1   # 411 unit tests
npm run test:tier2   # 258 integration + stress tests
npm run test:qa      # 96 fuzz, property, chaos, mutation tests
npm test             # all (765 pass, 0 fail)
```

---

## Tech Stack

- **Runtime**: Node.js 24 LTS, Express 5
- **Database**: PostgreSQL (production) + SQLite (dev/fallback), FTS5 / tsvector
- **LLM**: Anthropic Claude (primary), OpenAI GPT (fallback), Self-Hosted (vLLM/Ollama)
- **Messaging**: Slack Bolt 4.6, Microsoft 365 Agents SDK
- **Memory**: 4-Layer (Working → Episodic → Semantic → Entity) + MemoryGraph + CompactionEngine
- **State**: Redis (session, rate-limit, state externalization)
- **Gateway**: Pipeline-based (Strangler Fig), feature-flagged rollback
- **Observability**: OpenTelemetry (Traces + Metrics), Prometheus
- **Protocol**: MCP (Model Context Protocol)
- **v4.0 Modules**: State, Distributed, MCP, Evaluation, Tools, Schema, Observability

---

## License

UNLICENSED — Private use only.
