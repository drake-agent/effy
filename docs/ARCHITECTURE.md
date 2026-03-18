# Slack Agent Platform - Architecture Design

## Overview

100명 규모 팀을 위한 Slack 기반 다대다(Many-to-Many) AI 에이전트 플랫폼.
채널/스레드가 자유롭게 확장되며, 크로스채널 컨텍스트 동기화를 보장하는 시스템.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      SLACK WORKSPACE                         │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐           │
│  │Channel A│ │Channel B│ │Channel C│ │  DM/Thread│          │
│  └────┬────┘ └────┬────┘ └────┬────┘ └────┬─────┘          │
└───────┼───────────┼───────────┼────────────┼────────────────┘
        │           │           │            │
        ▼           ▼           ▼            ▼
┌─────────────────────────────────────────────────────────────┐
│                   SLACK EVENT GATEWAY                        │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐    │
│  │ Socket Mode   │ │ Event Filter │ │ Rate Limiter     │    │
│  │ Listener      │ │ & Classifier │ │ & Queue          │    │
│  └──────┬───────┘ └──────┬───────┘ └────────┬─────────┘    │
└─────────┼────────────────┼──────────────────┼───────────────┘
          │                │                  │
          ▼                ▼                  ▼
┌─────────────────────────────────────────────────────────────┐
│                     AGENT HARNESS                            │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────┐    │
│  │  Event      │  │  Agent     │  │  Middleware         │    │
│  │  Router     │──│  Pool      │──│  Pipeline           │    │
│  │             │  │  Manager   │  │  (auth/log/trace)   │    │
│  └──────┬─────┘  └──────┬─────┘  └──────────┬─────────┘    │
│         │               │                    │               │
│  ┌──────▼───────────────▼────────────────────▼─────────┐    │
│  │              AGENT EXECUTION ENGINE                   │    │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────┐  │    │
│  │  │ Ops     │ │Knowledge│ │  Code   │ │ Custom   │  │    │
│  │  │ Agent   │ │ Agent   │ │ Agent   │ │ Agent    │  │    │
│  │  └─────────┘ └─────────┘ └─────────┘ └──────────┘  │    │
│  └─────────────────────┬───────────────────────────────┘    │
└────────────────────────┼────────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│   MEMORY     │ │    TOOL      │ │   CONTEXT    │
│   MANAGER    │ │   REGISTRY   │ │   ENGINE     │
│              │ │              │ │              │
│ ┌──────────┐ │ │ ┌──────────┐ │ │ ┌──────────┐ │
│ │L1:Working│ │ │ │Slack API │ │ │ │ Builder  │ │
│ │  (Redis) │ │ │ │Code Exec │ │ │ │ Compactor│ │
│ │L2:Episode│ │ │ │Knowledge │ │ │ │ Scorer   │ │
│ │  (PG)    │ │ │ │External  │ │ │ │ Merger   │ │
│ │L3:Semant.│ │ │ │  APIs    │ │ │ └──────────┘ │
│ │(pgvector)│ │ │ └──────────┘ │ └──────────────┘
│ │L4:Entity │ │ │              │
│ │  (PG)    │ │ └──────────────┘
│ └──────────┘ │
└──────────────┘
```

---

## Memory Architecture (Core Innovation)

### 4-Layer Hierarchical Memory

| Layer | Name | Store | TTL | Purpose |
|-------|------|-------|-----|---------|
| L1 | Working Memory | Redis | 30min | 현재 대화 컨텍스트, 활성 상태 |
| L2 | Episodic Memory | PostgreSQL | Unlimited | 대화 히스토리, 인터랙션 로그 |
| L3 | Semantic Memory | pgvector | Unlimited | 임베딩된 지식, RAG 검색용 |
| L4 | Entity Memory | PostgreSQL | Unlimited | 유저 프로필, 프로젝트 상태, 관계 |

### Cross-Channel Context Sync

```
┌─────────────────────────────────────────────┐
│            MEMORY SCOPING MODEL              │
│                                              │
│  Global Scope ─────────────────────────────  │
│  │  Workspace Scope ─────────────────────  │ │
│  │  │  Channel Scope ──────────────────  │ │ │
│  │  │  │  Thread Scope ──────────────  │ │ │ │
│  │  │  │  │  DM Scope ────────────  │ │ │ │ │
│  │  │  │  │  │                    │ │ │ │ │ │
│  │  │  │  │  └────────────────────┘ │ │ │ │ │
│  │  │  │  └──────────────────────────┘ │ │ │ │
│  │  │  └────────────────────────────────┘ │ │ │
│  │  └────────────────────────────────────────┘ │ │
│  └──────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

**동기화 전략:**
- 유저별 Unified Memory Profile: 어느 채널에서든 유저의 히스토리 접근 가능
- 프로젝트/토픽 기반 Shared Memory Space: 특정 프로젝트에 대한 맥락이 채널 간 공유
- Entity Graph: 유저↔프로젝트↔채널↔토픽 관계를 그래프로 관리
- Memory Promotion: L1 → L2 → L3 자동 승격 (중요도 기반)

### Context Window Management

```python
# Context Budget Allocation (Claude 200K tokens 기준)
CONTEXT_BUDGET = {
    "system_prompt": 2000,      # 에이전트 역할/규칙
    "entity_context": 3000,     # 유저/프로젝트 상태
    "cross_channel": 5000,      # 타 채널 관련 맥락
    "semantic_search": 10000,   # RAG 검색 결과
    "recent_history": 15000,    # 최근 대화 히스토리
    "current_thread": 20000,    # 현재 스레드 전체
    "tool_results": 10000,      # 도구 실행 결과
    "buffer": 5000,             # 여유 버퍼
}
```

---

## Harness Design

### Event Processing Pipeline

```
Event → Filter → Classify → Route → Enrich(Context) → Execute(Agent) → Respond → Log
```

### Agent Lifecycle

1. **Spawn**: 이벤트 수신 시 에이전트 인스턴스 생성 (또는 풀에서 할당)
2. **Context Load**: Memory Manager에서 관련 컨텍스트 로드
3. **Execute**: Claude API 호출 + Tool 사용
4. **Persist**: 결과를 Memory Manager에 저장
5. **Respond**: Slack에 응답 전송
6. **Recycle**: 인스턴스를 풀에 반환

### Concurrency Model

- asyncio 기반 비동기 처리
- 채널/스레드별 독립적 처리 (no blocking)
- Redis 기반 분산 락 (동일 스레드 동시 처리 방지)
- Agent Pool: max_concurrent_agents = 20 (조절 가능)

---

## Deployment Architecture

```
┌─────────────────────────────────────────┐
│            Docker Compose                │
│                                          │
│  ┌──────────┐  ┌──────────┐             │
│  │  Agent    │  │  Agent   │  (scale)   │
│  │  Worker 1 │  │  Worker 2│             │
│  └────┬─────┘  └────┬─────┘             │
│       │              │                   │
│  ┌────▼──────────────▼─────┐             │
│  │      Redis (Cache)       │             │
│  └──────────┬──────────────┘             │
│             │                            │
│  ┌──────────▼──────────────┐             │
│  │  PostgreSQL + pgvector  │             │
│  └─────────────────────────┘             │
└─────────────────────────────────────────┘
```
