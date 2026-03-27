# Effy v3 — Native Gateway Architecture (100점 설계)

> 작성: 2026-03-16
> 목적: Gateway 아키텍처 + 선언적 에이전트 + Effy의 핵심 혁신(4계층 메모리 + 3경로 검색 + 승격 로직)을 **단일 프로세스**로 통합
> 원칙: zero-hop 메모리 접근, 선언적 에이전트, 선택적 크로스에이전트 메모리, 단일 설정 파일

---

## 변경 이력

| 버전 | 변경 |
|------|------|
| v1 | 3경로 병렬 크로스채널 검색 도입 |
| v2 | v1 + Node.js/Mac Mini/Phase staging/GitHub KPI 통합 |
| **v3** | **Gateway 아키텍처 전환. 선언적 에이전트(SOUL.md), 선택적 메모리 공유, 멀티 채널 어댑터, zero-hop 컨텍스트 조립** |

---

## 1. v2 → v3 핵심 변경 요약

| 항목 | v2 (독립 앱) | v3 (Native Gateway) |
|------|------------|---------------------|
| **프로세스 모델** | Slack Bolt 직접 사용 | Gateway 프로세스 + 채널 어댑터 |
| **에이전트 정의** | 코드 (router.js, FUNCTION_PROMPTS) | **SOUL.md + AGENTS.md** (마크다운 선언적) |
| **메모리 접근** | 코드 내부 직접 호출 | **Gateway가 LLM 호출 전 직접 주입** (zero-hop) |
| **메모리 공유** | 전체 공유 (단일 DB) | **선택적 공유** (private + shared pools) |
| **채널 지원** | Slack 전용 | **Slack + Discord + Webhook** (어댑터 패턴) |
| **설정** | .env + 코드 | **effy.config.yaml 단일 파일** |
| **라우팅** | 키워드 분류 → 기능 전환 | **바인딩 기반** (채널/계정 → 에이전트 매핑) + 기능 라우팅 |
| **도구 시스템** | TOOL_REGISTRY 하드코딩 | **SOUL.md에서 도구 선언** + 레지스트리 |

### 재사용 모듈 (변경 없이 그대로)

| 모듈 | 경로 | 이유 |
|------|------|------|
| **memory/manager.js** | src/memory/manager.js | L1~L4 + cost + promotion 모두 DB 추상화. Gateway에서 그대로 import |
| **memory/context.js** | src/memory/context.js | buildContext + formatContextForLLM + Budget Allocator. 호출자만 바뀜 |
| **memory/indexer.js** | src/memory/indexer.js | SessionIndexer. onIdle 콜백으로 동일하게 트리거 |
| **core/pool.js** | src/core/pool.js | ConcurrencyGovernor + SessionRegistry. 변경 없음 |
| **db/sqlite.js** | src/db/sqlite.js | 스키마 + init. 변경 없음 |
| **github/webhook.js** | src/github/webhook.js | Express webhook server. 변경 없음 |

### 리팩토링 모듈

| 모듈 | 변경 내용 |
|------|----------|
| **core/router.js** | 바인딩 매칭 로직 추가. 기존 키워드 분류 유지 |
| **agents/base.js** | SOUL.md 로더 추가. FUNCTION_PROMPTS → 파일 기반. TOOL_REGISTRY 동적 로딩 |
| **config.js** | .env → effy.config.yaml 파서로 교체 |

### 신규 모듈

| 모듈 | 역할 |
|------|------|
| **gateway/gateway.js** | Gateway 메인 프로세스. 부팅, 채널 어댑터 관리, 메시지 파이프라인 |
| **gateway/adapters/slack.js** | Slack Socket Mode 어댑터 |
| **gateway/adapters/discord.js** | Discord 어댑터 (Phase 2) |
| **gateway/adapters/webhook.js** | 범용 Webhook 수신 어댑터 |
| **gateway/context-assembler.js** | LLM 호출 전 컨텍스트 조립기 (memory → system prompt 직접 주입) |
| **gateway/agent-loader.js** | SOUL.md + AGENTS.md 파일 로더 + 핫 리로드 |

---

## 2. 전체 구조

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Effy GATEWAY (단일 Node.js 프로세스)             │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ Channel Adapters (메시지 수신/발신)                                 │  │
│  │                                                                   │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │  │
│  │  │ Slack        │  │ Discord      │  │ Webhook      │  ...       │  │
│  │  │ Socket Mode  │  │ (Phase 2)    │  │ (HTTP POST)  │            │  │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘            │  │
│  └─────────┼─────────────────┼─────────────────┼────────────────────┘  │
│            │                 │                 │                        │
│            └─────────────────┴─────────────────┘                        │
│                              │                                          │
│                              ▼                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ Middleware Pipeline                                                │  │
│  │  BotFilter → Auth → RateLimit → Logging → TraceId                │  │
│  └──────────────────────────────┬────────────────────────────────────┘  │
│                                 │                                       │
│                                 ▼                                       │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ Binding Router (NEW)                                              │  │
│  │                                                                   │  │
│  │  effy.config.yaml의 bindings 매칭:                                │  │
│  │  ① exact peer match (DM 특정 유저)                                 │  │
│  │  ② channel match (채널 ID → 에이전트)                              │  │
│  │  ③ account match (Slack workspace → 에이전트)                      │  │
│  │  ④ default agent (매칭 없을 때)                                    │  │
│  │                                                                   │  │
│  │  + 기존 기능 라우팅 (keyword → code/ops/knowledge/general)         │  │
│  │  + Budget Profile 선택 (LIGHT/STANDARD/DEEP)                      │  │
│  └──────────────────────────────┬────────────────────────────────────┘  │
│                                 │                                       │
│                                 ▼                                       │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ Agent Pool Manager (REUSE: pool.js)                               │  │
│  │  ConcurrencyGovernor (global:20, user:2, channel:3)               │  │
│  │  SessionRegistry (5min idle → SessionIndexer)                     │  │
│  └──────────────────────────────┬────────────────────────────────────┘  │
│                                 │                                       │
│                                 ▼                                       │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ Context Assembler (NEW — zero-hop)                                │  │
│  │                                                                   │  │
│  │  ① SOUL.md + AGENTS.md 로드 (에이전트별 시스템 프롬프트)            │  │
│  │  ② 3경로 병렬 메모리 검색 (REUSE: context.js)                     │  │
│  │     경로 1: 유저 크로스채널 (L2)                                   │  │
│  │     경로 2: 시맨틱/FTS (L3) — 유저/채널 무관                       │  │
│  │     경로 3: 채널 히스토리 + 결정사항 (L2+L3)                       │  │
│  │  ③ Budget Allocator 트리밍 (REUSE: context.js)                    │  │
│  │  ④ system prompt 조립:                                            │  │
│  │     SOUL.md + AGENTS.md + <memory_context>...</memory_context>    │  │
│  │                                                                   │  │
│  │  ★ 메모리가 tool_use가 아니라 system prompt에 직접 주입됨          │  │
│  │  ★ 에이전트는 메모리를 "검색"하지 않고 "이미 알고 있음"             │  │
│  └──────────────────────────────┬────────────────────────────────────┘  │
│                                 │                                       │
│                                 ▼                                       │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ Agent Runtime (REFACTOR: base.js)                                 │  │
│  │                                                                   │  │
│  │  Anthropic SDK Agentic Loop (max 10 iterations)                   │  │
│  │  system: Context Assembler 출력 (SOUL + 메모리 이미 포함)          │  │
│  │  tools: SOUL.md에 선언된 도구 + 기본 도구                          │  │
│  │  → tool_use 응답 시: 도구 실행 → 재호출                            │  │
│  │  → end_turn: 최종 텍스트                                           │  │
│  └──────────────────────────────┬────────────────────────────────────┘  │
│                                 │                                       │
│                                 ▼                                       │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ Memory Engine (REUSE: manager.js + indexer.js)                    │  │
│  │                                                                   │  │
│  │  L1 Working Memory (Map/Redis TTL 30min)                          │  │
│  │  L2 Episodic Memory (SQLite/PG)                                   │  │
│  │  L3 Semantic Memory (FTS5/pgvector)                               │  │
│  │  L4 Entity Memory (SQLite/PG)                                     │  │
│  │                                                                   │  │
│  │  Memory Pool System (NEW):                                        │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐               │  │
│  │  │ Pool: team  │  │ Pool: eng   │  │ Pool: design│               │  │
│  │  │ (전 에이전트 │  │ (code agent │  │ (design     │               │  │
│  │  │  읽기 가능)  │  │  + general) │  │  agent만)   │               │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘               │  │
│  │                                                                   │  │
│  │  + SessionIndexer (REUSE: 5min idle → 3기준 승격)                  │  │
│  │  + Anti-Bloat (REUSE: 채널 500/유저 200 상한)                      │  │
│  │  + Cost Meter (REUSE: 유저별 예산)                                 │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ GitHub Webhook (REUSE: webhook.js)                                │  │
│  │  PR/Push → Haiku 요약 → L4 Entity → KPI DB → /kpi                │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 선언적 에이전트 시스템

### 에이전트 워크스페이스 구조

```
agents/
├── general/
│   ├── SOUL.md          # 성격, 경계, 톤
│   ├── AGENTS.md        # 운영 규칙, 도구 사용법, 워크플로우
│   └── tools.yaml       # 이 에이전트가 사용할 도구 목록 (선택적)
│
├── code/
│   ├── SOUL.md
│   ├── AGENTS.md
│   └── tools.yaml
│
├── ops/
│   ├── SOUL.md
│   ├── AGENTS.md
│   └── tools.yaml
│
└── knowledge/
    ├── SOUL.md
    ├── AGENTS.md
    └── tools.yaml
```

### SOUL.md 예시 (general 에이전트)

```markdown
# SOUL — General Agent

당신은 100명 규모 팀의 범용 AI 어시스턴트 Effy입니다.

## 성격
- 간결하고 실용적. 불필요한 수식어 없이 핵심만.
- 한국어와 영어 모두 자연스럽게 대응.
- 모르면 "모르겠습니다"라고 솔직하게.

## 경계
- 코드 리뷰 요청은 code 에이전트에게 위임하라.
- 인시던트/배포 관련은 ops 에이전트에게 위임하라.
- 개인정보(주민번호, 비밀번호 등)는 절대 저장/전송하지 마라.

## 컨텍스트 활용
- <memory_context>에 이미 관련 지식이 주입되어 있다.
- 추가 검색이 필요하면 search_knowledge 도구를 사용하라.
- 결정사항을 발견하면 반드시 save_knowledge로 저장하라.

## 응답 형식
- 일반 대화: 3문장 이내.
- 분석/설명: 구조화된 마크다운 (헤더, 리스트).
- 코드: 코드 블록 + 한 줄 설명.
```

### AGENTS.md 예시 (code 에이전트)

```markdown
# AGENTS — Code Agent 운영 규칙

## 부트 시퀀스
1. <memory_context>에서 현재 프로젝트의 아키텍처 결정사항 확인
2. 요청된 코드/PR의 컨텍스트 파악
3. 팀 코딩 컨벤션 (memory에서 자동 로드) 적용

## 도구 사용 우선순위
1. search_knowledge — 기존 결정사항/패턴 확인
2. 직접 분석 — 코드 리뷰, 버그 분석
3. save_knowledge — 새로운 패턴/결정사항 발견 시 저장

## 결정사항 감지
아래 키워드가 대화에서 발견되면 자동으로 save_knowledge 호출:
- "이걸로 가자", "확정", "결정", "합의"
- 기술 선택, 라이브러리 채택, 아키텍처 변경

## 코드 리뷰 체크리스트
- [ ] 에러 핸들링
- [ ] 엣지 케이스
- [ ] 성능 영향
- [ ] 보안 취약점
- [ ] 팀 컨벤션 준수
```

### 에이전트 로더 (Agent Loader)

```javascript
// gateway/agent-loader.js 설계

class AgentLoader {
  constructor(agentsDir) {
    this.agentsDir = agentsDir;
    this.cache = new Map();    // agentId → { soul, agents, tools, mtime }
    this.watchInterval = null;
  }

  /**
   * 에이전트 로드 — 파일에서 읽어서 캐시.
   * SOUL.md 수정 → 다음 세션부터 즉시 반영 (핫 리로드).
   */
  load(agentId) {
    const cached = this.cache.get(agentId);
    const dir = path.join(this.agentsDir, agentId);

    // mtime 체크로 핫 리로드
    const soulPath = path.join(dir, 'SOUL.md');
    const agentsPath = path.join(dir, 'AGENTS.md');
    const currentMtime = fs.statSync(soulPath).mtimeMs;

    if (cached && cached.mtime === currentMtime) {
      return cached;
    }

    const soul = fs.readFileSync(soulPath, 'utf-8');
    const agents = fs.existsSync(agentsPath)
      ? fs.readFileSync(agentsPath, 'utf-8')
      : '';
    const toolsPath = path.join(dir, 'tools.yaml');
    const tools = fs.existsSync(toolsPath)
      ? yaml.parse(fs.readFileSync(toolsPath, 'utf-8'))
      : null;

    const entry = { soul, agents, tools, mtime: currentMtime };
    this.cache.set(agentId, entry);
    return entry;
  }

  /**
   * 에이전트 시스템 프롬프트 조립.
   * SOUL.md + AGENTS.md + memory_context → 단일 system prompt.
   */
  buildSystemPrompt(agentId, memoryContext) {
    const { soul, agents } = this.load(agentId);
    return [
      soul,
      agents ? `\n---\n${agents}` : '',
      memoryContext ? `\n---\n${memoryContext}` : '',
    ].join('\n');
  }
}
```

**v2 대비 차이**: 에이전트 행동을 바꾸려면 코드를 수정하고 pm2 restart가 필요했다. v3에서는 SOUL.md 편집만으로 **즉시 반영**. 비개발자도 에이전트 성격/규칙을 조정할 수 있다.

---

## 4. 선택적 메모리 공유 (Memory Pools)

### v2의 문제

v2는 모든 에이전트가 **하나의 SQLite DB를 전부 공유**한다. 이건 크로스채널 검색에는 좋지만:
- #hr 에이전트의 인사 논의가 #engineering 에이전트 검색에 노출될 수 있음
- 에이전트별 메모리 격리가 불가능
- 민감한 채널(#leadership, #hr)의 내용이 전체에 공유됨

### v3 해결: Memory Pool 시스템

```yaml
# effy.config.yaml 발췌

memory:
  pools:
    team:                          # 전사 공유 풀
      description: "팀 전체 결정사항, 정책, 컨벤션"
      access: read_all             # 모든 에이전트가 읽기 가능
      write: [general, code, ops, knowledge]
      promotion: auto              # 3기준 판단 트리

    engineering:                   # 엔지니어링 풀
      description: "코드 결정, PR 리뷰, 기술 스펙"
      access: [code, general]      # code와 general만 읽기
      write: [code]                # code만 쓰기
      promotion: decisions_only    # 결정사항만 승격

    design:                        # 디자인 풀
      description: "디자인 결정, 스펙, 가이드라인"
      access: [design, general]
      write: [design]
      promotion: auto

    hr:                            # HR 풀 (격리)
      description: "인사 관련"
      access: [hr]                 # hr 에이전트만 접근
      write: [hr]
      promotion: decisions_only

agents:
  - id: general
    soul: ./agents/general/SOUL.md
    default: true
    memory:
      private: true                # 자기 세션 메모리는 자기만 접근
      shared_read: [team, engineering, design]  # 이 풀들의 L3 검색 가능
      shared_write: [team]         # team 풀에만 승격 가능

  - id: code
    soul: ./agents/code/SOUL.md
    memory:
      private: true
      shared_read: [team, engineering]
      shared_write: [team, engineering]

  - id: hr
    soul: ./agents/hr/SOUL.md
    memory:
      private: true
      shared_read: [team, hr]      # hr 풀만 추가 접근
      shared_write: [hr]           # hr 풀에만 쓰기
```

### DB 스키마 변경 (semantic_memory에 pool_id 추가)

```sql
-- v3 추가 컬럼
ALTER TABLE semantic_memory ADD COLUMN pool_id TEXT DEFAULT 'team';
CREATE INDEX idx_semantic_pool ON semantic_memory(pool_id, archived, last_accessed DESC)
    WHERE archived = 0;
```

### 3경로 검색에서 Pool 필터링

```javascript
// context.js 변경점 (최소 변경)

async function buildContext(params) {
  // ... 기존 코드 ...

  // v3 추가: 에이전트의 접근 가능 풀 목록
  const accessiblePools = params.accessiblePools || ['team'];

  // 경로 2: 시맨틱 검색 시 풀 필터 적용
  const route2Promise = budget.route2_semantic > 0
    ? Promise.resolve(searchSemanticWithPools(text, accessiblePools))
    : Promise.resolve([]);

  // ... 나머지 동일 ...
}

function searchSemanticWithPools(queryText, pools) {
  // FTS5 + pool_id IN (...) 필터
  const poolFilter = pools.map(p => `'${p}'`).join(',');
  return db.prepare(`
    SELECT sm.*, rank FROM semantic_fts
    JOIN semantic_memory sm ON semantic_fts.rowid = sm.id
    WHERE semantic_fts MATCH ?
      AND sm.archived = 0
      AND sm.pool_id IN (${poolFilter})
    ORDER BY rank LIMIT ?
  `).all(ftsQuery, 10);
}
```

**핵심**: 기존 context.js의 `buildContext()`에 `accessiblePools` 파라미터 하나만 추가. 나머지 로직(3경로 병렬, Budget Allocator, 트리밍)은 전부 그대로.

---

## 5. Gateway 메시지 파이프라인

### v2 vs v3 플로우 비교

```
v2 (독립 앱):
  Slack Bolt → handleMessage() → routeEvent() → buildContext() → runAgent()
  모든 채널이 하나의 handleMessage()

v3 (Gateway):
  채널 어댑터 → Gateway.onMessage() → bindingRouter() → pool → contextAssembler() → agentRuntime()
  어댑터가 메시지를 정규화 → Gateway는 채널 무관하게 처리
```

### 정규화된 메시지 포맷

```typescript
// 모든 채널 어댑터가 이 포맷으로 변환

interface NormalizedMessage {
  id: string;                    // 유니크 메시지 ID
  channel: {
    type: 'slack' | 'discord' | 'webhook';
    accountId: string;           // Slack workspace ID 등
    channelId: string;
    threadId?: string;
  };
  sender: {
    id: string;                  // 채널별 유저 ID
    name?: string;
    isBot: boolean;
  };
  content: {
    text: string;
    mentions: string[];          // 채널 멘션 (<#C...>)
    attachments?: any[];
  };
  metadata: {
    timestamp: number;
    raw: any;                    // 원본 이벤트 (디버깅용)
  };
}
```

### Gateway.onMessage() — 메인 파이프라인

```javascript
// gateway/gateway.js 핵심 로직

class Gateway {
  constructor(config) {
    this.config = config;
    this.adapters = new Map();       // 'slack' → SlackAdapter, ...
    this.agentLoader = new AgentLoader(config.agents.dir);
    this.governor = new ConcurrencyGovernor();
    this.sessions = new SessionRegistry(config.session.idleTimeoutMs);
    this.workingMemory = new WorkingMemory();
    this.bindingRouter = new BindingRouter(config.bindings);

    // 세션 idle → SessionIndexer
    this.sessions.onIdle(async (key, data) => {
      const messages = this.workingMemory.get(data.conversationKey || key);
      if (messages.length > 0) {
        await indexSession(key, data, messages);
        this.workingMemory.clear(data.conversationKey || key);
      }
    });
  }

  /**
   * 채널 어댑터에서 호출. 정규화된 메시지 수신.
   */
  async onMessage(msg, adapter) {
    // ① 미들웨어
    const mw = runMiddleware(msg);
    if (!mw.pass) {
      if (mw.reason === 'rate_limited') {
        await adapter.reply(msg, '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.');
      }
      return;
    }

    // ② 바인딩 라우팅 (채널/계정 → 에이전트 결정)
    const binding = this.bindingRouter.match(msg);
    const agentId = binding.agentId;    // 'general', 'code', 'hr', ...

    // ③ 기능 라우팅 (기존 router.js 로직 재사용)
    const routing = routeEvent(msg.content, {
      isDM: msg.channel.channelId.startsWith('D'),
      isMention: msg.content.mentions?.length > 0,
      isThreadFollowUp: !!msg.channel.threadId,
    });

    // ④ 동시성 체크
    const userId = msg.sender.id;
    const channelId = msg.channel.channelId;
    const acquired = await this.governor.waitForSlot(userId, channelId);
    if (!acquired) {
      await adapter.reply(msg, '현재 처리 중인 요청이 많습니다.');
      return;
    }

    try {
      // ⑤ 세션 터치
      const sessionKey = `${agentId}:${userId}:${channelId}:${msg.channel.threadId || msg.id}`;
      this.sessions.touch(sessionKey, { userId, channelId, agentType: agentId });

      // ⑥ L1 Working Memory 업데이트
      this.workingMemory.add(sessionKey, { role: 'user', content: msg.content.text });

      // ⑦ L2 Episodic 저장
      episodic.save(sessionKey, userId, channelId, msg.channel.threadId, 'user', msg.content.text, agentId, routing.functionType);

      // ⑧ L4 Entity 업데이트
      entity.upsert('user', userId, msg.sender.name || '', {});
      entity.addRelationship('user', userId, 'channel', channelId, 'active_in');

      // ⑨ Context Assembler (zero-hop) ★
      const agentConfig = this.config.agents.find(a => a.id === agentId);
      const accessiblePools = agentConfig?.memory?.shared_read || ['team'];

      const memoryCtx = await buildContext({
        userId,
        channelId,
        conversationKey: sessionKey,
        text: msg.content.text,
        budgetProfile: routing.budgetProfile,
        channelMentions: routing.channelMentions,
        workingMemory: this.workingMemory,
        accessiblePools,                // v3 추가
      });

      const memoryPrompt = formatContextForLLM(memoryCtx);

      // SOUL.md + AGENTS.md + memory = 완성된 system prompt
      const systemPrompt = this.agentLoader.buildSystemPrompt(agentId, memoryPrompt);

      // ⑩ Agent Runtime (agentic loop)
      const recentMessages = this.workingMemory.get(sessionKey)
        .map(m => ({ role: m.role, content: m.content }));

      const result = await runAgent({
        systemPrompt,
        messages: recentMessages,
        functionType: routing.functionType,
        model: routing.budgetProfile === 'DEEP' ? this.config.anthropic.advancedModel : this.config.anthropic.defaultModel,
        agentId,                       // v3: 에이전트별 도구 로딩
        userId,
        sessionId: sessionKey,
      });

      // ⑪ 응답 전송 (채널 어댑터 통해)
      if (result.text) {
        await adapter.reply(msg, result.text);
        this.workingMemory.add(sessionKey, { role: 'assistant', content: result.text });
        episodic.save(sessionKey, 'bot', channelId, msg.channel.threadId, 'assistant', result.text, agentId, routing.functionType);
      }

    } catch (err) {
      console.error(`[gateway] Error:`, err);
      await adapter.reply(msg, '처리 중 오류가 발생했습니다.');
    } finally {
      this.governor.release(userId, channelId);
    }
  }
}
```

**v2의 `handleMessage()`와 거의 동일한 흐름** — 차이점은:
1. `adapter.reply()` (채널 무관한 응답)
2. `bindingRouter.match()` (설정 기반 에이전트 결정)
3. `agentLoader.buildSystemPrompt()` (SOUL.md 기반 프롬프트)
4. `accessiblePools` (메모리 풀 필터)

---

## 6. 바인딩 라우터

### effy.config.yaml — bindings 섹션

```yaml
bindings:
  # 특정 채널 → 특정 에이전트
  - agentId: code
    match:
      channel: slack
      channelId: C_engineering      # #engineering → code 에이전트

  - agentId: code
    match:
      channel: slack
      channelId: C_devops           # #devops → code 에이전트

  - agentId: ops
    match:
      channel: slack
      channelId: C_ops              # #ops → ops 에이전트

  - agentId: knowledge
    match:
      channel: slack
      channelId: C_general          # #general → knowledge 에이전트

  - agentId: hr
    match:
      channel: slack
      channelId: C_hr               # #hr → hr 에이전트 (격리 메모리)

  # DM은 기본적으로 general 에이전트 (아래 default)
  # 특정 유저의 DM을 특정 에이전트로 라우팅 가능:
  - agentId: code
    match:
      channel: slack
      peer: U_alice                  # Alice의 DM → code 에이전트
```

### 바인딩 매칭 우선순위

```
① peer match    — 특정 유저 DM
② channelId     — 특정 채널
③ accountId     — 특정 Slack workspace
④ channel type  — 채널 종류 (slack, discord, ...)
⑤ default       — agents.list에서 default: true인 에이전트
```

```javascript
// gateway/binding-router.js

class BindingRouter {
  constructor(bindings, defaultAgentId) {
    this.bindings = bindings || [];
    this.defaultAgentId = defaultAgentId;
  }

  match(msg) {
    // 우선순위 순 매칭
    for (const b of this.bindings) {
      const m = b.match;
      if (m.peer && m.peer === msg.sender.id) return b;
    }
    for (const b of this.bindings) {
      const m = b.match;
      if (m.channelId && m.channelId === msg.channel.channelId) return b;
    }
    for (const b of this.bindings) {
      const m = b.match;
      if (m.accountId && m.accountId === msg.channel.accountId) return b;
    }
    for (const b of this.bindings) {
      const m = b.match;
      if (m.channel && m.channel === msg.channel.type && !m.channelId && !m.peer && !m.accountId) return b;
    }
    return { agentId: this.defaultAgentId };
  }
}
```

---

## 7. 채널 어댑터 (Slack)

```javascript
// gateway/adapters/slack.js

class SlackAdapter {
  constructor(config, gateway) {
    this.gateway = gateway;
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });
  }

  async start() {
    // @멘션
    this.app.event('app_mention', async ({ event, say }) => {
      const msg = this.normalize(event, { isMention: true });
      await this.gateway.onMessage(msg, this);
    });

    // DM
    this.app.event('message', async ({ event, say }) => {
      if (event.channel_type !== 'im') return;
      if (event.subtype) return;
      const msg = this.normalize(event, { isDM: true });
      await this.gateway.onMessage(msg, this);
    });

    // 리액션
    this.app.event('reaction_added', async ({ event }) => {
      if (event.reaction !== 'robot_face') return;
      // 원본 메시지 fetch → normalize → onMessage
    });

    await this.app.start();
    return this;
  }

  /**
   * Slack 이벤트 → NormalizedMessage 변환.
   */
  normalize(event, context = {}) {
    return {
      id: event.ts,
      channel: {
        type: 'slack',
        accountId: event.team || '',
        channelId: event.channel,
        threadId: event.thread_ts || undefined,
      },
      sender: {
        id: event.user,
        isBot: !!event.bot_id,
      },
      content: {
        text: (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim(),
        mentions: detectChannelMentions(event.text || ''),
      },
      metadata: {
        timestamp: parseFloat(event.ts) * 1000,
        raw: event,
      },
    };
  }

  /**
   * 응답 전송.
   */
  async reply(originalMsg, text) {
    await this.app.client.chat.postMessage({
      channel: originalMsg.channel.channelId,
      text,
      thread_ts: originalMsg.channel.threadId || originalMsg.id,
    });
  }

  /**
   * 슬래시 커맨드 등록.
   */
  registerCommands() {
    this.app.command('/kpi', async ({ command, ack, respond }) => {
      await ack();
      const result = getKPI(command.text);
      await respond(result);
    });
    this.app.command('/search', async ({ command, ack, respond }) => {
      await ack();
      // ... 기존 로직 ...
    });
  }
}
```

**v2의 `app.js`와 구조적으로 동일** — 차이점은 `normalize()`로 Slack 이벤트를 `NormalizedMessage`로 변환하는 것뿐. Discord 어댑터도 같은 인터페이스의 `normalize()` + `reply()`만 구현하면 된다.

---

## 8. 단일 설정 파일

### effy.config.yaml 전체 구조

```yaml
# ═══════════════════════════════════════════════════
# Effy v3 — 단일 설정 파일
# ═══════════════════════════════════════════════════

gateway:
  port: 3100                         # 내부 API + GitHub webhook
  idleTimeoutMs: 300000              # 5분
  maxConcurrency:
    global: 20
    perUser: 2
    perChannel: 3

# ─── LLM ───
anthropic:
  apiKey: ${ANTHROPIC_API_KEY}       # 환경변수 참조
  defaultModel: claude-haiku-4-5-20251001
  advancedModel: claude-sonnet-4-20250514
  maxTokens: 4096

# ─── 에이전트 ───
agents:
  dir: ./agents                      # SOUL.md 워크스페이스 디렉토리
  list:
    - id: general
      default: true
      memory:
        private: true
        shared_read: [team, engineering, design]
        shared_write: [team]

    - id: code
      memory:
        private: true
        shared_read: [team, engineering]
        shared_write: [team, engineering]

    - id: ops
      memory:
        private: true
        shared_read: [team, engineering]
        shared_write: [team]

    - id: knowledge
      memory:
        private: true
        shared_read: [team, engineering, design]
        shared_write: [team]

    - id: hr
      memory:
        private: true
        shared_read: [team, hr]
        shared_write: [hr]

# ─── 바인딩 ───
bindings:
  - agentId: code
    match: { channel: slack, channelId: C_engineering }
  - agentId: code
    match: { channel: slack, channelId: C_devops }
  - agentId: ops
    match: { channel: slack, channelId: C_ops }
  - agentId: knowledge
    match: { channel: slack, channelId: C_general }
  - agentId: hr
    match: { channel: slack, channelId: C_hr }

# ─── 채널 어댑터 ───
channels:
  slack:
    enabled: true
    botToken: ${SLACK_BOT_TOKEN}
    appToken: ${SLACK_APP_TOKEN}

  discord:
    enabled: false                   # Phase 2
    botToken: ${DISCORD_BOT_TOKEN}

  webhook:
    enabled: true
    port: 3100                       # GitHub webhook 공유

# ─── 메모리 ───
memory:
  database:
    phase: 1                         # 1 = SQLite, 2 = PostgreSQL
    sqlitePath: ./data/effy.db
    postgresUrl: ${DATABASE_URL}     # Phase 2

  pools:
    team:
      description: "팀 전체 결정사항, 정책, 컨벤션"
      access: read_all
      write: [general, code, ops, knowledge]
      promotion: auto

    engineering:
      description: "코드 결정, PR 리뷰, 기술 스펙"
      access: [code, general]
      write: [code]
      promotion: decisions_only

    design:
      description: "디자인 결정, 스펙, 가이드라인"
      access: [design, general]
      write: [design]
      promotion: auto

    hr:
      description: "인사 관련"
      access: [hr]
      write: [hr]
      promotion: decisions_only

  promotion:
    decisionKeywords:
      - 결정
      - 확정
      - 합의
      - 정했
      - 결론은
      - 하기로 했
      - 채택
      - decided
      - confirmed
      - finalized
    topicWeightThreshold: 3.0
    longTermHints:
      - 아키텍처
      - 정책
      - 프로세스
      - 온보딩
      - 컨벤션

  antiBloat:
    channelLimit: 500
    userLimit: 200
    archiveDays: 90

  budget:
    LIGHT:  { total: 8000 }
    STANDARD: { total: 35000 }
    DEEP: { total: 70000 }

# ─── GitHub ───
github:
  enabled: true
  webhookSecret: ${GITHUB_WEBHOOK_SECRET}
  webhookPort: 3100

# ─── 비용 ───
cost:
  monthlyBudget: 200                 # USD
  alertThreshold: 0.8                # 80% 도달 시 경고
```

### 설정 로더

```javascript
// config.js (리팩토링)

const yaml = require('yaml');
const fs = require('fs');

function loadConfig(configPath = './effy.config.yaml') {
  const raw = fs.readFileSync(configPath, 'utf-8');

  // 환경변수 치환: ${VAR_NAME} → process.env.VAR_NAME
  const resolved = raw.replace(/\$\{(\w+)\}/g, (_, name) => {
    const val = process.env[name];
    if (!val) throw new Error(`Missing env var: ${name}`);
    return val;
  });

  return yaml.parse(resolved);
}
```

---

## 9. 파일 구조 (v3)

```
slack-agent-platform/
├── effy.config.yaml              # ★ 단일 설정 파일
├── package.json
├── .env                           # 환경변수 (API 키만)
├── .gitignore
│
├── agents/                        # ★ 에이전트 워크스페이스 (선언적)
│   ├── general/
│   │   ├── SOUL.md
│   │   └── AGENTS.md
│   ├── code/
│   │   ├── SOUL.md
│   │   └── AGENTS.md
│   ├── ops/
│   │   ├── SOUL.md
│   │   └── AGENTS.md
│   ├── knowledge/
│   │   ├── SOUL.md
│   │   └── AGENTS.md
│   └── hr/
│       ├── SOUL.md
│       └── AGENTS.md
│
├── src/
│   ├── gateway/                   # ★ 신규: Gateway 레이어
│   │   ├── gateway.js             # 메인 Gateway 클래스
│   │   ├── binding-router.js      # 바인딩 매칭
│   │   ├── agent-loader.js        # SOUL.md 로더 + 핫 리로드
│   │   ├── context-assembler.js   # zero-hop 컨텍스트 조립
│   │   └── adapters/
│   │       ├── slack.js           # Slack Socket Mode 어댑터
│   │       ├── discord.js         # Discord 어댑터 (Phase 2)
│   │       └── webhook.js         # 범용 Webhook 어댑터
│   │
│   ├── memory/                    # 재사용 (변경 최소)
│   │   ├── manager.js             # L1~L4 + cost + promotion
│   │   ├── context.js             # 3경로 병렬 + Budget Allocator (pool 필터 추가)
│   │   └── indexer.js             # SessionIndexer (3기준 승격)
│   │
│   ├── core/                      # 재사용
│   │   ├── middleware.js           # BotFilter + RateLimit
│   │   ├── router.js              # 기능 분류 + Budget Profile (바인딩 로직 추가)
│   │   └── pool.js                # ConcurrencyGovernor + SessionRegistry
│   │
│   ├── agents/                    # 리팩토링
│   │   └── runtime.js             # Agentic Loop (base.js → 리네임 + SOUL.md 통합)
│   │
│   ├── db/
│   │   ├── sqlite.js              # 재사용
│   │   └── init.js                # 재사용
│   │
│   ├── github/
│   │   └── webhook.js             # 재사용
│   │
│   ├── config.js                  # 리팩토링: YAML 로더
│   └── app.js                     # 리팩토링: Gateway 부트스트래퍼
│
├── data/                          # 런타임 생성
│   └── effy.db
│
├── memory/                        # Markdown Mirror (재사용)
│   ├── team/
│   ├── channels/
│   └── users/
│
├── docs/
│   ├── ARCHITECTURE_v2.md
│   └── ARCHITECTURE_v3.md         # 이 문서
│
└── INSTALL.md                     # 업데이트 필요
```

---

## 10. 빌드 계획 (작업 분류)

### Phase 1: 코어 리팩토링 (4-5시간)

| # | 작업 | 파일 | 난이도 |
|---|------|------|--------|
| 1 | YAML config 로더 | config.js | 쉬움 — yaml 파서 교체 |
| 2 | effy.config.yaml 작성 | effy.config.yaml | 쉬움 — 위 설계 기반 |
| 3 | BindingRouter | gateway/binding-router.js | 쉬움 — 70줄 |
| 4 | AgentLoader | gateway/agent-loader.js | 쉬움 — 80줄, fs.readFile + 캐시 |
| 5 | SlackAdapter | gateway/adapters/slack.js | 중간 — app.js에서 Slack 로직 추출 |
| 6 | Gateway 클래스 | gateway/gateway.js | 중간 — app.js의 handleMessage() 리팩토링 |
| 7 | context.js pool 필터 추가 | memory/context.js | 쉬움 — 파라미터 1개 + WHERE 조건 |
| 8 | semantic_memory pool_id 마이그레이션 | db/sqlite.js | 쉬움 — ALTER TABLE 1줄 |
| 9 | app.js → Gateway 부트스트래퍼 | app.js | 중간 — 기존 로직 Gateway로 위임 |

### Phase 2: 에이전트 워크스페이스 (1-2시간)

| # | 작업 | 파일 |
|---|------|------|
| 10 | general SOUL.md + AGENTS.md | agents/general/ |
| 11 | code SOUL.md + AGENTS.md | agents/code/ |
| 12 | ops SOUL.md + AGENTS.md | agents/ops/ |
| 13 | knowledge SOUL.md + AGENTS.md | agents/knowledge/ |
| 14 | hr SOUL.md + AGENTS.md | agents/hr/ |
| 15 | runtime.js (base.js + SOUL 로딩) | agents/runtime.js |

### Phase 3: 검증 + 설치 가이드 (1-2시간)

| # | 작업 |
|---|------|
| 16 | 부팅 테스트 (Gateway → Slack 연결 → 메시지 처리) |
| 17 | 바인딩 라우팅 테스트 (채널별 에이전트 분기) |
| 18 | 메모리 풀 테스트 (격리 검증) |
| 19 | INSTALL.md 업데이트 |

**총 예상: 6-9시간.** 기존 모듈 80%를 재사용하므로 새로 작성하는 코드는 ~500줄.

---

## 11. v2에서 보존되는 것 (변경 없음)

- **4계층 메모리 아키텍처** (L1~L4)
- **3경로 병렬 크로스채널 검색** (경로 1/2/3)
- **Budget Allocator** (LIGHT 8K / STANDARD 35K / DEEP 70K)
- **Memory Promotion 3기준 판단 트리** (결정사항 / 반복토픽 / Haiku 장기가치)
- **Anti-Bloat** (채널 500 / 유저 200 / 90일 아카이브)
- **SessionIndexer** (5분 idle → Haiku 요약 → 승격)
- **GitHub Webhook + KPI** (PR/Push → Haiku 요약 → Entity → /kpi)
- **ConcurrencyGovernor** (global:20 / user:2 / channel:3 + FIFO)
- **Cost Meter** (유저별 예산 + 모델 다운그레이드)
- **SQLite WAL → PostgreSQL Phase 전환 경로**
- **Markdown Mirror** (DB → .md 단방향 동기화)
- **Mac Mini A/B 인프라** (Primary + Standby)

---

## 12. v3에서 새로 얻는 것

| 기능 | 설명 |
|------|------|
| **선언적 에이전트** | SOUL.md 편집 → 즉시 반영. 코드 배포 불필요 |
| **에이전트 핫 리로드** | mtime 체크로 파일 변경 감지 → 다음 세션부터 자동 적용 |
| **선택적 메모리 공유** | pool_id 기반. #hr은 격리, #engineering은 code+general만 접근 |
| **멀티 채널 어댑터** | Slack 외 Discord, Webhook 확장 가능 (어댑터 패턴) |
| **zero-hop 컨텍스트** | 메모리가 system prompt에 직접 주입. tool_use 라운드트립 없음 |
| **바인딩 라우팅** | 채널/유저 → 에이전트 매핑을 config로 관리 |
| **단일 설정 파일** | effy.config.yaml 하나에 전체 시스템 설정 |
| **비개발자 운영** | SOUL.md 편집 + config YAML만으로 에이전트 추가/수정 가능 |

---

*이 문서는 v3 빌드의 기준 설계서. 구현 시 변경사항은 이 문서에 반영.*
*v2의 모든 혁신을 보존하면서 Gateway 아키텍처를 네이티브로 통합.*
