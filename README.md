# Effy v3.6.2 — Native Gateway Multi-Agent Platform

100명 규모 팀을 위한 Slack 기반 다중 에이전트 AI 플랫폼.
단일 Node.js 프로세스, 선언적 에이전트, 4계층 메모리 + Memory Graph, 제로 프레임워크.

---

## 아키텍처

```
Slack Socket Mode
      |
      v
+-----------+    +---------------------------+
|  Gateway  |--->|  Middleware Pipeline       |
| (adapters)|    |  BotFilter -> RateLimit   |
+-----------+    |  -> Trace -> Classify     |
                 +------------+-------------+
                              |
                 +------------v-------------+
                 |  Binding Router          |
                 |  channelId -> agentId    |
                 +------------+-------------+
                              |
              +---------------+---------------+
              v               v               v
         +--------+     +--------+     +--------+
         |  Code  |     |  Ops   |     |General |  ...
         | Agent  |     | Agent  |     | Agent  |
         +---+----+     +---+----+     +---+----+
             |              |              |
             +------+-------+------+-------+
                    |              |
          +---------v----+  +-----v---------+
          |Memory Manager|  | Memory Graph  |
          | L1 Working   |  | 8 node types  |
          | L2 Episodic  |  | 5 edge types  |
          | L3 Semantic  |  | importance    |
          | L4 Entity    |  | scoring       |
          +------+-------+  +-------+-------+
                 |                   |
                 +----->SQLite<------+
                       + FTS5
```

---

## v3.6 신규 모듈

### v3.6.0 — Reflection + Hybrid Committee
| 모듈 | 파일 | 역할 |
|------|------|------|
| **ReflectionEngine** | `reflection/engine.js` | Post-run 자기 평가 + 개선 루프 |
| **HybridCommittee** | `reflection/committee.js` | Multi-agent 합의 메커니즘 |
| **DataSource** | `datasource/` | 외부 데이터 커넥터 프레임워크 |

### v3.6.2 — 코드 리뷰 4라운드 적용
- **BUG-5 Fix**: `tasks` 테이블 rowid 중복 조회 제거 (id INTEGER PRIMARY KEY = rowid)
- **STALE-1 Fix**: AgentMailbox 오류 메시지 현행화
- **DOC**: `_withDb` 미사용 핸들러에 의도 주석 추가 (graceful degradation)
- **테스트**: Tier2 통합 34 tests + 스트레스 16 tests 신규 추가

### v4 Port 모듈 (v3.5에서 이식)

| 모듈 | 파일 | 역할 |
|------|------|------|
| **MemoryGraph** | `memory/graph.js` | 8 typed nodes + 5 edge types + importance scoring |
| **MemorySearch** | `memory/search.js` | Hybrid FTS5 BM25 + importance re-ranking |
| **CompactionEngine** | `memory/compaction.js` | 80% threshold context compression + memory extraction |
| **Structured Logger** | `shared/logger.js` | `[timestamp] [LEVEL] [component] message {meta}` |
| **Enhanced Tools** | `agents/runtime.js` | DB-backed tasks/incidents, dual-write knowledge |

### Dual-Write Architecture

`save_knowledge` 도구가 semantic_memory (pool-based FTS5)와 memories (graph-based) 양쪽에 동시 저장.
한쪽 실패 시에도 다른 쪽은 정상 동작 (graceful degradation).

### Importance Scoring

```
score = (accessFreq * 0.3) + (recency * 0.3) + (graphCentrality * 0.2) + (baseImportance * 0.2)
```

---

## 에이전트

| ID | 역할 | 트리거 |
|----|------|--------|
| **general** | 범용 폴백 (default) | 매칭 안 될 때 |
| **code** | 코드 리뷰, 배포, 아키텍처 | #dev, #engineering 채널 |
| **ops** | 인시던트, 작업 할당, 운영 | #ops 채널 |
| **knowledge** | Q&A, 문서 검색, 온보딩 | #general, #help 채널 |
| **strategy** | 의사결정, 로드맵, OKR | #strategy 채널 |

에이전트는 `agents/{id}/SOUL.md` + `AGENTS.md` 파일로 선언적 정의.
공통 행동은 `agents/_base/`에서 상속 (P-4 Skill Layering).

---

## 빠른 시작

### Prerequisites

- **Node.js** >= 20.0.0
- **Anthropic API Key**
- **Slack Bot Token** + **App-Level Token** (Socket Mode)

### Install

```bash
git clone <repo-url> effy && cd effy
cp .env.example .env
# .env 편집: ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, SLACK_APP_TOKEN
npm install
npm run db:init
```

### Run

```bash
# Development (auto-reload)
npm run dev

# Production
NODE_ENV=production npm start
```

### Docker

```bash
# Development
npm run docker:dev

# Production (detached)
npm run docker:prod
```

> 상세 설치 가이드 (Slack App 생성, pm2, GitHub Webhook 등): **[INSTALL.md](./INSTALL.md)**

---

## 설정

모든 설정은 `effy.config.yaml`, 환경별 오버라이드는 `config/env.{development,staging,production}.yaml`.
환경변수는 `${VAR_NAME}` 형태로 참조.

| 환경변수 | 설명 | 필수 |
|----------|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 키 | O |
| `SLACK_BOT_TOKEN` | Slack bot 토큰 (`xoxb-...`) | O |
| `SLACK_APP_TOKEN` | Slack app-level 토큰 (`xapp-...`) | O |
| `GITHUB_WEBHOOK_SECRET` | GitHub webhook 시크릿 | X |
| `NODE_ENV` | 실행 환경 (development/staging/production) | X |
| `LOG_LEVEL` | 로그 레벨 (info/debug) | X |

---

## 테스트

```bash
# 전체 (16 files, 65 suites, 405 tests)
npm test

# Tier 1 only (단위 테스트)
npm run test:tier1

# Tier 2 only (통합 + 스트레스)
npm run test:tier2

# 커버리지
npm run test:coverage
```

### Test Tiers

| Tier | Files | Scope |
|------|-------|-------|
| **Tier 1** | `tier1-*.test.js` (11) | 단위: config, router, middleware, security, skills, tool-registry, binding-router, context, mailbox, reflection, datasource |
| **Tier 2** | `tier2-*.test.js` (5) | 통합: runtime CRUD, memory, agent-loader, run-logger, stress (10K ops) |

모든 테스트는 pure-logic (native SQLite 의존 없음). In-memory mock으로 동작.

---

## 12-Step Message Pipeline

```
1.  Adapter         - Slack Socket Mode 수신
2.  Coalescer       - 빠른 연속 메시지 합체 (v3.5)
3.  Middleware       - BotFilter -> RateLimit -> Trace
4.  Binding Router  - channelId -> agentId 결정
5.  Model Router    - 5단계 Agent-Level 4-Tier 모델 결정 (v3.6.2)
6.  Circuit Breaker - 에이전트 장애 차단 (v3.5)
7.  Budget Gate     - 토큰 비용 제어 (v3.5)
8.  Session/Memory  - Working Memory + Compaction (80% threshold)
9.  Context Assembly- 3경로 병렬 컨텍스트 조립
10. Agent Runtime   - Anthropic Agentic Loop + 27 Tool Execution
11. Respond         - Slack 응답 + Memory Persist + Session Index
12. Run Logger      - NDJSON 관측 로그
```

---

## 27 Tools

| Category | Tools | 접근 권한 |
|----------|-------|----------|
| **Communication** (5) | `slack_reply`, `send_message`, `react`, `send_file`, `send_agent_message` | `*` (send_message: ops) |
| **Memory** (3) | `search_knowledge`, `save_knowledge`, `memory_delete` | `*` (delete: ops) |
| **Ops** (4) | `create_task`, `task_list`, `task_update`, `create_incident` | `*` (create: ops) |
| **Skills** (6) | `search_skills`, `install_skill`, `list_skills`, `activate_skill`, `create_skill`, `delete_skill` | `*` |
| **DataSource** (2) | `query_datasource`, `list_datasources` | `*` |
| **System** (4) | `file_read`, `file_write`, `web_search`, `shell` | `*` (write/shell: code,ops) |
| **Config** (1) | `config_inspect` | `*` |
| **Flow** (1) | `set_status` | `*` |
| **Integration** (1) | `cron_schedule` | ops |

도구 정의는 `src/agents/tool-registry.js` (SSOT). 에이전트별 접근 제어 적용.
`*` = 모든 에이전트 접근 가능. 괄호 안은 제한된 에이전트만 접근.

---

## 4-Tier Model Routing (v3.6.2)

에이전트별 동적 모델 선택 — 같은 에이전트도 요청 복잡도에 따라 다른 모델 사용.

### Tier 체계

| Tier | 모델 | maxTokens | 용도 |
|------|------|-----------|------|
| tier1 | Haiku | 8,192 | 빠른 응답, 인사, 단순 확인 |
| tier2 | Sonnet | 16,384 | 코딩, 일반 추론 |
| tier3 | Opus | 16,384 | 깊은 분석, 전략적 판단 |
| tier4 | Opus+ET | 32,000 | Extended Thinking, 최고 수준 추론 |

### 에이전트별 모델 범위

| Agent | Range | LIGHT | STANDARD | HEAVY | CRITICAL |
|-------|-------|-------|----------|-------|----------|
| general | tier1~tier2 | Haiku | Haiku | Sonnet | Sonnet |
| code | tier2~tier4 | Sonnet | Sonnet | Opus | Opus+ET |
| ops | tier1~tier3 | Haiku | Haiku | Sonnet | Opus |
| knowledge | tier1~tier3 | Haiku | Haiku | Sonnet | Opus |
| strategy | tier2~tier4 | Sonnet | Sonnet | Opus | Opus+ET |

### 5단계 라우팅

1. **Agent Config** — 에이전트의 `model.range`에서 [minTier, maxTier] 결정
2. **Process Defaults** — 에이전트 설정 없으면 processDefaults 폴백 (channel→tier1)
3. **Complexity Analysis** — 텍스트 분석 → LIGHT/STANDARD/HEAVY/CRITICAL → 범위 내 tier 선택
4. **Tier Resolve** — tier → 실제 모델 ID + maxTokens + Extended Thinking 파라미터
5. **Fallback** — 모델 장애(429/502) 시 하위 tier로 자동 전환 (15분 cooldown)

### 복잡도 판정 기준

- **LIGHT**: 10단어 이하 + 인사/확인 패턴 (`안녕`, `hi`, `ok`, `감사` 등)
- **STANDARD**: 기본값 (일반 질문, 대화)
- **HEAVY**: 코드 블록 포함 또는 3문장 이상 + 기술 키워드 5개+
- **CRITICAL**: 아키텍처/전략 키워드 2개+ 또는 "깊이 분석" 명시 요청

---

## 설계 패턴

| 패턴 | 이름 | 설명 |
|------|------|------|
| P-1 | SummarizationMiddleware | 장기 대화 자동 압축 (30턴 초과 시 Haiku 요약) |
| P-2 | Tool Registry SSOT | 도구 정의 단일 소스, 에이전트별 자동 필터링 |
| P-3 | Actionable Error Messages | 모든 에러에 `hint` 필드 포함 |
| P-4 | Skill Layering | `_base/` 공통 레이어 + 에이전트별 오버라이드 |
| P-5 | Context Window Budget Guard | 80% 초과 시 점진적 트리밍 |
| P-6 | Run Logger | NDJSON append-only 일별 로그 |
| P-7 | Multi-Tier Testing Pyramid | Tier1(단위) + Tier2(통합/스트레스) |
| DI-1 | Dependency Injection | MemoryGraph 싱글톤 공유 |

---

## 메모리 시스템

4계층 메모리 + **Memory Graph** + **Selective Memory Pool**:

- **L1 Working**: 현재 대화 버퍼 (인메모리, 세션별, TTL 30분)
- **L2 Episodic**: 과거 대화 히스토리 (SQLite)
- **L3 Semantic**: FTS5 전문 검색 (키워드 + 토픽 기반, pool 격리)
- **L4 Entity**: 유저/레포/채널 관계 그래프 (SQLite)
- **Memory Graph**: 8 typed nodes + 5 edge types + importance scoring (v4 Port)

메모리 풀: `team` (전체 공유), `engineering` (엔지니어링), `design` (디자인)

### Memory Graph Node Types

`fact`, `preference`, `decision`, `identity`, `event`, `observation`, `goal`, `todo`

### Memory Graph Edge Types

`related_to`, `updates`, `contradicts`, `caused_by`, `part_of`

---

## 보안

| ID | 방어 | 설명 |
|----|------|------|
| SEC-1 | Channel origin 검증 | Slack reply 채널 LLM 환각 방지 |
| SEC-2 | Shell whitelist | 승인 명령만 실행, 체이닝(`&&`, `\|`, `;`) 차단 |
| SEC-3 | File path restriction | Symlink 디펜스 + path traversal 방지 |
| SEC-4 | Secret masking | API 키/토큰 로그 마스킹 |
| SEC-5 | Channel ID validation | `^C[A-Z0-9]{8,}$` strict pattern |
| C-2 | Memory pool ACL | 에이전트별 pool read/write 권한 하드 검증 |
| B-3 | FTS5 sanitizer | 예약어 이스케이프, injection 방지 |
| SEC-W | SQL parameterization | 100% parameterized queries, 타입 강제 |
| HMAC | Webhook 서명 | raw body 기반 timing-safe 검증 |

---

## 기술 스택

| 영역 | 기술 |
|------|------|
| **Runtime** | Node.js 20+ (순수 CommonJS, 트랜스파일 없음) |
| **LLM** | Anthropic Claude (Haiku 기본 / Sonnet 고급) |
| **DB** | SQLite + WAL mode + FTS5 (better-sqlite3) |
| **Slack** | @slack/bolt Socket Mode |
| **Webhook** | Express (GitHub) |
| **Test** | Node.js built-in test runner |

---

## 프로젝트 통계 (v3.6.2)

| Metric | Count |
|--------|-------|
| 소스 파일 | 47 |
| 소스 라인 | 10,412 |
| 테스트 파일 | 16 |
| 테스트 라인 | 3,788 |
| 테스트 스위트 | 65 |
| 테스트 케이스 | 405 |
| 도구 정의 | 27 |
| 에이전트 타입 | 5 |
| 프로덕션 의존성 | 6 |

---

## 주요 스크립트

```bash
npm start              # 프로덕션 실행
npm run dev            # 개발 모드 (--watch)
npm test               # 전체 테스트 (405 tests)
npm run test:tier1     # 단위 + 보안 테스트
npm run test:tier2     # 통합 + 스트레스 테스트
npm run test:coverage  # 커버리지 리포트
npm run lint           # 문법 검증
npm run db:init        # DB 스키마 초기화
npm run validate       # 설정 파일 검증
npm run clean          # DB + 로그 초기화
npm run docker:dev     # Docker 개발 환경
npm run docker:prod    # Docker 프로덕션 (detached)
npm run release        # 릴리즈 스크립트
```

---

## 프로젝트 구조

```
effy/
+-- src/
|   +-- app.js                  # 부트 시퀀스 (6단계)
|   +-- config.js               # YAML 설정 로더 + 검증
|   +-- agents/
|   |   +-- runtime.js          # Agentic Loop + 27 Tool Handlers (1,012 lines)
|   |   +-- tool-registry.js    # P-2 도구 정의 SSOT (567 lines)
|   |   +-- mailbox.js          # Inter-agent FIFO 메시징 (175 lines)
|   +-- core/
|   |   +-- middleware.js        # 미들웨어 파이프라인
|   |   +-- router.js           # 키워드 기반 기능 분류기
|   |   +-- pool.js             # ConcurrencyGovernor + SessionRegistry
|   |   +-- coalescer.js        # v3.5 메시지 합체
|   |   +-- circuit-breaker.js  # v3.5 장애 차단기
|   |   +-- model-router.js     # v3.6.2 5단계 Agent-Level 4-Tier 모델 결정
|   |   +-- budget-gate.js      # v3.5 비용 제어
|   +-- memory/
|   |   +-- manager.js          # 4계층 메모리 매니저
|   |   +-- context.js          # 3경로 병렬 컨텍스트 조립
|   |   +-- graph.js            # v4 Port: Memory Graph (8+5+importance)
|   |   +-- search.js           # v4 Port: Hybrid FTS5 + Re-ranking
|   |   +-- compaction.js       # v4 Port: 80% Context Compaction
|   |   +-- indexer.js          # 세션 인덱서 + 승격
|   |   +-- bulletin.js         # v3.5 메모리 게시판
|   +-- skills/
|   |   +-- registry.js         # Skill 라이프사이클 (search→install→activate)
|   |   +-- catalog.js          # 카탈로그 검색
|   |   +-- resolver.js         # GitHub 다운로드 + 캐시
|   |   +-- loader.js           # SKILL.md 파서
|   +-- reflection/
|   |   +-- engine.js           # v3.6 Self-reflection 엔진
|   |   +-- committee.js        # v3.6 Hybrid Committee
|   |   +-- (5 more modules)
|   +-- datasource/
|   |   +-- registry.js         # v3.6 DataSource 커넥터 레지스트리
|   |   +-- (4 more modules)
|   +-- gateway/
|   |   +-- gateway.js          # 12-step 메인 파이프라인 (445 lines)
|   |   +-- binding-router.js   # 채널->에이전트 매핑
|   |   +-- agent-loader.js     # P-4 선언적 에이전트 로더
|   |   +-- adapters/slack.js   # Slack Socket Mode 어댑터
|   +-- github/
|   |   +-- webhook.js          # GitHub Webhook + KPI
|   +-- shared/
|   |   +-- anthropic.js        # Anthropic SDK 싱글턴
|   |   +-- fts-sanitizer.js    # FTS5 쿼리 새니타이저
|   |   +-- logger.js           # v4 구조화 로거
|   |   +-- run-logger.js       # P-6 NDJSON 로거
|   |   +-- utils.js            # contentHash, estimateTokens
|   +-- db/
|       +-- sqlite.js           # DDL SSOT + WAL + Migration (358 lines)
|       +-- init.js             # DB 초기화 스크립트
+-- agents/                     # 선언적 에이전트 정의 (SOUL.md + AGENTS.md)
|   +-- _base/                  # 공통 레이어
|   +-- general/ code/ ops/ knowledge/ strategy/
+-- tests/                      # 16 files, 65 suites, 405 tests
|   +-- tier1-*.test.js (11)    # 단위 테스트
|   +-- tier2-*.test.js (5)     # 통합 + 스트레스 테스트
+-- config/                     # 환경별 설정 오버라이드
|   +-- env.{development,staging,production}.yaml
+-- scripts/
|   +-- release.sh              # 시맨틱 버저닝 릴리즈
|   +-- health-check.sh         # 헬스 체크
+-- effy.config.yaml            # 메인 설정 (gateway, agents, bindings, memory, skills)
+-- .env.example                # 환경변수 템플릿
+-- Dockerfile                  # 멀티스테이지 빌드 (Node 20-slim)
+-- docker-compose.yml          # dev/staging/prod 프로필
+-- package.json                # v3.6.2
+-- CHANGELOG.md                # 변경 이력
```

---

## 새 에이전트 추가

1. `agents/{id}/SOUL.md` — 에이전트 정체성 + 행동 지침
2. `agents/{id}/AGENTS.md` — 다른 에이전트와의 협업 규칙
3. `effy.config.yaml`의 `agents.list`에 추가
4. `bindings`에 채널 매핑 추가

```yaml
# effy.config.yaml
agents:
  list:
    - id: my-agent
      memory:
        private: true
        shared_read: [team]
        shared_write: [team]

bindings:
  - agentId: my-agent
    match: { channel: slack, channelId: C_my_channel }
```

코드 변경 없이 YAML + 마크다운 파일만으로 에이전트 추가 완료.

---

## License

UNLICENSED — Proprietary
