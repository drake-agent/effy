# Changelog

All notable changes to Effy will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.6.2] - 2026-03-17

### Added
- **Hybrid Committee**: AI + 인간 멤버 혼합 투표 시스템
  - 인간 멤버: 플랫폼 DM 알림 → 버튼 클릭 투표 (타임아웃 설정 가능)
  - 가중치 투표: AI=1, 인간=2 (config 변경 가능), 정족수도 가중치 기반
  - Drake 기본 인간 멤버 등록 (`effy.config.yaml`)
- **VoteNotifier 추상화 레이어** (`vote-notifier.js`)
  - `VoteNotifier` 인터페이스 — 플랫폼 독립적 투표 알림
  - `SlackVoteNotifier` — Slack Block Kit 버튼 기반 구현
  - `WebhookVoteNotifier` — 범용 HTTP Webhook 기반 구현 (확장용)
  - 향후 Discord, Telegram 등 추가 가능
- **Tier 2 Integration Tests** (`tests/tier2-runtime-integration.test.js`): 12 suites, 34 tests
  - Task/Incident/Cron CRUD lifecycle simulation (pure-logic mock)
  - Mailbox round-trip (send → receive FIFO ordering)
  - File I/O security (path traversal, symlink defense)
  - Shell whitelist enforcement
  - Memory pool isolation
  - Secret masking verification
  - FTS5 sanitizer edge cases
  - ToolContext propagation
  - Slack channel ID validation
- **Tier 2 Stress Tests** (`tests/tier2-stress.test.js`): 6 suites, 16 tests
  - Mailbox high-volume (250+ messages, per-agent 50 / global 500 cap enforcement)
  - Task store bulk operations (1,000 inserts + compound filter)
  - Tool Registry 27×100 validation throughput
  - FTS5 sanitizer 10K query stress
  - Shell whitelist 10K pattern matches
  - Mailbox interleaving (10 agents concurrent)
- **4-Tier Agent-Level Model Routing** (`model-router.js` 완전 재작성)
  - Tier 체계: tier1(Haiku) → tier2(Sonnet) → tier3(Opus) → tier4(Opus+Extended Thinking)
  - 에이전트별 `model.range` — 각 에이전트가 사용 가능한 tier 범위 설정
    - general: [tier1, tier2], code: [tier2, tier4], ops: [tier1, tier3], knowledge: [tier1, tier3], strategy: [tier2, tier4]
  - 5단계 라우팅: Agent Config → Process Defaults → Complexity Analysis → Tier Resolve → Fallback
  - 4단계 복잡도 분석: LIGHT(인사/확인) → STANDARD(일반) → HEAVY(코드/기술) → CRITICAL(아키텍처/전략)
  - Per-tier maxTokens: Haiku 8192, Sonnet 16384, Opus 16384, Opus-ET 32000
  - Extended Thinking: tier4에서 `thinking: { type: 'enabled', budget_tokens: 10000 }` 자동 활성화
  - Fallback chain: 모델 장애(429/502) 시 하위 tier로 graceful degradation
  - Runtime 파이프라인 통합: gateway.js → runtime.js → Anthropic API까지 maxTokens/extendedThinking 전달
  - Opus 비용 추가: input $15/1M, output $75/1M + 월예산 $500 확대
- **Context Hub 통합** — Phase 1, 2, 3 완성 (`src/knowledge/`)
  - Phase 1: Library Import — ESM→CJS 변환 7개 vendor 파일, ChubAdapter 싱글톤
  - Phase 2: Context Assembly — detectApiQuery() + BM25 자동 검색 → system prompt 주입
  - Phase 3: Self-Improving Loop — _postAgentAnnotation() 비동기 + MemoryGraph 엣지 생성
  - 사용자 Custom Source 관리: Slack 봇에서 add/remove/list (CRUD)
  - BM25 필드 가중 검색: name(3.0), tags(2.0), description(1.0) + IDF 스코어링
  - **Security**: SSRF IPv4+IPv6 방어, Path Traversal 차단, Prompt Injection 방어 (XML+Template 구문)
  - 5개 새 도구: search_api_docs, get_api_doc, add_api_source, remove_api_source, list_api_sources
- **Integration Tests E2E** (`tests/tier2-gateway-e2e.test.js`, `tests/tier2-gateway-e2e-r2.test.js`): 22 suites, 119 tests
  - Round 1: Context Hub pipeline, sanitizer, SSRF IPv4+IPv6, ModelRouter param propagation, tool routing, BM25, custom source CRUD, annotation flow, vendor config, full pipeline chain
  - Round 2: Edge cases (Unicode, long text, null fields), nested injection, concurrent ops, error recovery, cross-tool consistency, model router determinism
- **Stress Tests Context Hub** (`tests/tier2-stress-chub.test.js`, `tests/tier2-stress-chub-r2.test.js`): 16 suites, 22 tests
  - Round 1: BM25 1000-doc index, 100 searches <500ms, detectApiQuery ×1000, format ×500 docs, SSRF ×10000 URLs, tool validation 32×100, ModelRouter ×500, CRUD ×1000 ops
  - Round 2: Index build/discard ×50, max payload ×100, streaming input ×5000, full pipeline chain ×1000 (<2s), config reset ×500, annotation ×10000 entries, MemoryGraph ×10000 edges
- **Admin Authorization** — 고위험 도구 실행 권한 제어
  - `src/shared/auth.js` — 중앙 집중 권한 관리 유틸리티 (getAdminUsers, isAdmin, requireAdmin)
  - `gateway.adminUsers` 단일 역할 모델 — 슬래시 커맨드 관리 + 고위험 도구 통합
  - 7개 Admin-only 도구: shell, remove_api_source, add_api_source, delete_skill, cron_schedule, config_inspect, file_write
  - `runtime.js executeTool()` 진입점 단일 가드 — 모든 도구 실행 전 권한 검증
  - `memory_delete` 영구 비활성화 — antiBloat(90일 아카이브)로 자동 관리
- **Mission Control Dashboard** — 시각화 대시보드 (`src/dashboard/`)
  - Apple HIG 스타일: 라이트 테마, 프로스트 글래스 네비게이션, SF Pro 타이포
  - 6단 레이아웃: KPI → Agent Cards → Cost/Tier Charts → Activity/System → Tools/Memory → Sessions
  - Recharts: AreaChart(비용 추이), PieChart(Tier 분포), BarChart(도구 사용), LineChart(메모리 성장)
  - SSE 실시간 스트림: `/dashboard/api/events` → 에이전트 활동 푸시
  - REST API: 8개 엔드포인트 (overview, agents, cost, activity, sessions, memory, tools, system)
  - API 미연결 시 mock data fallback — 독립 실행 가능
  - 기존 Express webhook 서버에 마운트 (`/dashboard`)
  - 빌드 도구 없음 — CDN 기반 React 19 + Recharts + Babel standalone
- Tests total: **22 files, 125 suites, 629 tests, 0 failures**
- **Tool Registry 확장** — 22 → 32 도구 (17개 신규):
  - Communication 확장: `send_message` (크로스채널), `react` (이모지 리액션), `send_file` (파일/스니펫 업로드), `send_agent_message` (에이전트 간 메시징)
  - Ops CRUD 완성: `task_list` (필터 검색), `task_update` (상태/담당자 변경)
  - Skills 확장: `create_skill` (대화형 커스텀 스킬 빌더), `delete_skill` (로컬 스킬 삭제)
  - Config: `config_inspect` (런타임 설정 조회 — agents, memory, datasources, skills, reflection)
  - Flow: `set_status` (에이전트 상태 메시지 표시)
  - Memory 확장: `memory_delete` (지식 항목 삭제 + 사유 기록)
  - Integration: `cron_schedule` (예약 작업 등록/조회/삭제 — create/list/delete 통합)

### Fixed
- **SEC-1 (SSRF IPv4)**: Custom source URL — private IP 블록리스트 (127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x)
- **SEC-1b (SSRF IPv6)**: `[::1]`, `[::ffff:127.x]`, `fd00::/8`, `fe80::/10`, `fc00::/7` 전체 차단
- **SEC-2 (Path Traversal)**: fetchDoc() `..` 경로 탐지 차단
- **SEC-3 (Filename Injection)**: Annotation 파일명 encodeURIComponent() 적용
- **SEC-PROMPT (Prompt Injection)**: _sanitizeForPrompt() — XML 태그 + Jinja `{{}}` + Django `{%%}` + MediaWiki `[[]]` + JS `${}` 전체 차단
- **BUG-2**: registry.js null entry name 크래시 → `(entry.name || '')` 방어
- **DRY-1**: runtime.js 5중 require 통합 → 단일 case 블록
- **PERF-3**: cache.js 중복 fetch+timeout → `_fetchWithTimeout()` 추출
- **SEC-1 (original)**: Committee LLM reasoning에 `sanitizeForPrompt` 적용 (prompt injection 차단)
- **BUG-3**: 실패한 투표(`failed: true`) 집계 제외 + 성공 투표 0건 시 의결 불가 처리
- **BUG-5 (runtime)**: `task_list` / `task_update` 에서 `SELECT rowid as id` → `SELECT * FROM tasks` 수정. `id INTEGER PRIMARY KEY AUTOINCREMENT`이 곧 rowid이므로 중복 컬럼 제거
- **BUG-5 (app.js)**: RunLogger 이중 생성 → Gateway 인스턴스 공유로 통합
- **STALE-1**: `send_agent_message` catch 블록 — 변수명 `_` → `mailboxErr`, 메시지 `"mailbox pending implementation"` → `"mailbox unavailable"` 로 현행화
- **WARN-3**: `MAX_PENDING_PROPOSALS=50` 상한 + `rejected_cap` 상태 반환
- OutcomeTracker: 미사용 `reflection` 필드 제거 (순환 참조 방지)

### Changed
- Committee: `slackClient` 직접 의존 → `notifier` 추상화 레이어로 전환
- Committee: `payload` 매개변수 제거 (미사용)
- index.js: `notifier` 의존성 주입 경로 추가
- app.js: 부팅 순서 변경 — Gateway 생성 → Slack 어댑터 → Reflection 초기화 (RunLogger 공유)
- Boot 배너: Hybrid Committee 멤버 수 + 가중치 표시
- **DOC**: `create_task`, `create_incident` 핸들러에 `_withDb` 미사용 의도 주석 추가 (graceful degradation)
- **Test architecture**: native SQLite (`better-sqlite3`) 의존 제거. Tier 2 전체를 pure-logic mock 기반으로 전환

### Code Review (4라운드 9-criteria 적용)
- 설계, 간결성, 버그, 목적, 보안, 중복, 성능, 공통화, 불필요 코드 — 5개 소스 파일 전수 분석
- 발견: 2 bugs (BUG-5, STALE-1) + 1 doc gap → 모두 수정 완료

## [3.6.0] - 2026-03-17

### Added
- **Self-Improvement Loop**: 자기개선 메커니즘 4개 컴포넌트
  - `ReflectionEngine` — 사용자 교정 패턴 실시간 감지 + Lesson 자동 승격 (L3 Semantic)
    - 한/영 교정 키워드 12종 (직접교정, 반복실수, 재시도 신호)
    - 반복 교정 N회 → Global Lesson 자동 승격 (team pool)
  - `OutcomeTracker` — 에이전트 응답 품질 추적 (긍정/부정/중립 신호 감지)
    - RunLogger NDJSON에 outcome 필드 추가
    - 에이전트별 성과 리포트 + 교정률 임계치 알림
  - `NightlyDistiller` — 매일 23:30 KST에 L2→L3 메모리 증류
    - LLM 기반 승격 후보 추출 (결정사항/반복참조/장기가치/교훈)
    - Anti-Bloat: 500건 상한 + 90일 미참조 자동 아카이브 (결정사항 제외)
    - 중복 감지 (LCS 기반 유사도 50자 임계)
  - `Committee` — 에이전트 위원회 의사결정 시스템
    - 멤버: general, code, ops (설정 가능)
    - 투표: approve(찬성), reject(반대), defer(보류)
    - 정족수(quorum) 기반 의결 + L3에 Decision 타입으로 영구 기록
    - Distiller 승격 → Committee 투표 경유 (자동 승인 폴백)
- Gateway: Step ⑥.9 (교정감지 + Outcome 추적) + Step ⑨.7 (Lesson 주입)
- Config: `reflection` 섹션 (correctionThreshold, lessonPool, nightly, distillation, committee)
- App: Reflection 모듈 초기화 + graceful shutdown 정리 + 부트 배너
- Tests: `tier1-reflection.test.js` — 25개 단위 테스트 (4 suites)

### Architecture (설계 도면 차용 내역)
- Layer 1-A (교정 감지): 키워드 패턴 매칭 → 가중치 스코어링
- Layer 2 (3계층 메모리): Anti-Bloat 규칙 강화 (500건 상한, 90일 아카이브)
- Layer 3 (Promotion 판단 트리): 3기준 (결정사항/반복/장기가치) + Committee 투표
- Layer 4-A (Lessons → 행동 변화): `<learned_lessons>` XML → system prompt 자동 주입
- 교정 분류 체계: Global(team) > Domain(reflection pool) > Session(인메모리)

## [3.5.7] - 2026-03-17

### Changed
- **프로젝트 리브랜딩**: ARETE → Effy(에피)
  - 설정 파일: `arete.config.yaml` → `effy.config.yaml`
  - 환경변수: `ARETE_CONFIG` → `EFFY_CONFIG`
  - DB 기본 경로: `arete.db` → `effy.db`
  - Docker/CI: 이미지명, 서비스명, 볼륨명 모두 effy로 변경
  - 전 에이전트 SOUL.md 아이덴티티 Effy로 통일
- **General Agent 아이덴티티 재설계**
  - 3가지 핵심 목표 명시: ① 기록/기억 ② 프로세스 개선 ③ 일 줄여주기
  - 디지털본부 운영 컨텍스트에 맞춘 미션 정의
  - AGENTS.md에 프로세스 개선 프로토콜 추가

### Note
- 기능적 동작 변경 없음 (라우팅, 바인딩, 에이전트 ID 등 모두 동일)
- 기존 `ARETE_CONFIG` 환경변수 사용 시 `EFFY_CONFIG`로 변경 필요
- 기존 DB 경로를 config에 명시하지 않은 경우, 새 `effy.db`가 생성됨

## [3.5.6] - 2026-03-17

### Added
- **Skill Registry**: 에이전트가 awesome-claude-skills에서 스킬을 검색/설치/활성화
  - `SkillRegistry` 싱글톤 — 스킬 생명주기 관리 (search → install → activate → prompt injection)
  - `SkillResolver` — GitHub raw content 다운로더 + TTL 기반 로컬 파일 캐시 (24h)
  - `loader.js` — SKILL.md 파서 (YAML frontmatter + Markdown body)
  - `catalog.js` — 25개 빌트인 스킬 카탈로그 (Anthropic official + community)
- Tool Registry: `search_skills`, `install_skill`, `list_skills`, `activate_skill` 도구 추가
- Runtime: 스킬 도구 실행 핸들러 4종
- Gateway: 활성화된 스킬 지시문 → system prompt 자동 주입 (`<active_skills>` XML)
- Config: `skills` 섹션 — cacheDir, cacheTtlMs, preInstall, agentSkills
- App: 부팅 시 SkillRegistry 초기화 + graceful shutdown 시 정리
- Tests: `tier1-skills.test.js` — 27개 단위 테스트 (loader, catalog, registry, tool definitions)

## [3.5.5] - 2026-03-17

### Added
- **DataSource Connector Layer**: 외부 데이터 소스 연동 프레임워크
  - `BaseConnector` 추상 클래스 — 표준 인터페이스 (init/query/destroy)
  - `DataSourceRegistry` 싱글톤 — 커넥터 생명주기 관리 + 접근 제어
  - `RestApiConnector` — REST API 연동 (bearer/basic/header 인증, readOnly 보호)
  - `SqlDatabaseConnector` — SQLite 연동 (SELECT-only, DDL 차단)
  - `FileSystemConnector` — 파일 시스템 연동 (경로 탈출 방지, 확장자 화이트리스트)
- Tool Registry: `query_datasource`, `list_datasources` 도구 추가
- Runtime: DataSource 도구 실행 핸들러 (에이전트별 접근 제어)
- Config: `datasources` 섹션 — 배열/객체 양식 지원
- App: 부팅 시 DataSource 초기화 + graceful shutdown 시 정리
- Tests: `tier1-datasource.test.js` — 35개 단위 테스트 (보안 포함)

### Changed
- Registry `init()`: 배열(YAML list) + 객체(key-value) 듀얼 포맷 지원
- Registry: Config 구조 평탄화 로직 (options 필드 중첩 해소)

## [3.5.4] - 2026-03-17

### Fixed
- **R3-BUG-1**: `semantic.autoArchive()` — `days` 파라미터 타입 강제 누락 (manager.js)
- **R3-BUG-2**: `semantic.touchAccess()` — null/undefined ids 전달 시 TypeError (manager.js)
- **R4-BUG-1**: `||` → `??` — 명시적 0 설정이 falsy로 무시되는 문제 (compaction.js, manager.js)

### Changed
- **R3-PERF-1**: `compact()` — `_summarize`/`_extractMemories` 병렬화 (`Promise.all`) — 압축 지연 ~50% 절감 (compaction.js)
- **R3-DUP-1**: `_mapGraphRow()` 공통 헬퍼 추출 — get/getByType/getLinked 중복 제거 (graph.js)
- **R3-DUP-2**: context.js `estimateTokens` → utils.js 통합 (자모 범위 지원 버전)
- **R3-INFO-1**: context.js `console.warn` → structured logger 전환 (logger.js)
- **R4-WARN-1**: gateway.js — silent catch 제거, `log.error` 추가
- **R4-INFO-1**: `WorkingMemory.replace()` — `needsSummary` 초기화 누락 수정

## [3.5.3] - 2026-03-16

### Added
- **v4 Port**: MemoryGraph — 8 typed nodes, 5 edge types, importance scoring
- **v4 Port**: MemorySearch — Hybrid FTS5 BM25 + importance re-ranking
- **v4 Port**: CompactionEngine — 80% threshold, Haiku summarization, JSON extraction with 3-layer parse defense
- **v4 Port**: Context Engine — 3-route cross-channel search + Budget Allocator
- **v4 Port**: Agent Runtime — Agentic loop with tool execution, DI for MemoryGraph
- Dual-write architecture: `save_knowledge` writes to BOTH semantic_memory AND memories
- `_mapRow()` / `_appendFilters()` common helpers in search.js
- `_mapGraphRow()` common helper in graph.js
- Structured logger (`[timestamp] [LEVEL] [component] message {meta}`)
- `contentHash` (SHA256) re-exported from utils.js

## [3.5.0] - 2026-03-15

### Added
- Message Coalescer — debounce + batch for rapid-fire messages
- Circuit Breaker — per-agent fault isolation with auto-recovery
- Model Router — process/task-based model selection with fallback chains
- Budget Gate — per-user/per-channel/monthly cost enforcement
- Memory Bulletin — decision/goal briefing with TTL cache
- Run Logger — NDJSON audit trail per conversation
- Binding Router — priority-based channel→agent routing

### Changed
- 12-step message pipeline: Adapter → Coalescer → Middleware → Binding → ModelRouter → CircuitBreaker → BudgetGate → Pool → Context → LLM → Respond → Persist

## [3.0.0] - 2026-03-14

### Added
- Initial native gateway architecture (pure Node.js, no framework)
- 4-layer memory system (Working → Episodic → Semantic → Entity)
- Slack adapter with Socket Mode
- GitHub webhook integration (PR/Push events)
- Multi-agent support with SOUL.md/AGENTS.md personas
- FTS5 full-text search with Korean support
- SQLite-backed persistence
- Security: payload validation, rate limiting, input sanitization, secret masking, FTS5 query sanitization
