# Effy v3.6.2 — Architecture Map

> 이 문서는 에이전트와 인간 개발자 모두가 읽을 수 있도록 설계되었습니다.
> OpenAI Codex 패턴: "Repository as System of Record"

## Module Dependency Graph

```
┌─────────────────────────────────────────────────────┐
│                    app.js (Boot)                     │
│  Config → DB → DataSource → Skills → Gateway → Dash │
└──────────────────────┬──────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          │     Gateway (gateway.js)│
          │  Adapters │ Router │ CB │
          └────────┬───────────────┘
                   │
     ┌─────────────┼──────────────┐
     │             │              │
┌────┴─────┐ ┌────┴─────┐ ┌─────┴──────┐
│ runtime  │ │ context  │ │  memory    │
│ .js      │ │ .js      │ │  manager   │
│ (Agent   │ │ (Context │ │  .js       │
│  Loop)   │ │  Build)  │ │ (4-Layer)  │
└────┬─────┘ └──────────┘ └────────────┘
     │
┌────┴───────────────┐
│  tool-registry.js  │
│  (31 tools, SSOT)  │
└────────────────────┘
```

## Layers (Dependency Direction: top → bottom only)

| Layer | Modules | Depends On |
|-------|---------|------------|
| **Boot** | `app.js` | config, db, gateway, reflection, dashboard |
| **Gateway** | `gateway.js`, adapters, model-router, circuit-breaker | runtime, context, memory |
| **Runtime** | `runtime.js`, tool-registry | memory, knowledge, shared |
| **Memory** | context, manager, compaction, graph, indexer | shared |
| **Knowledge** | chub-adapter, vendor/ | shared |
| **Reflection** | engine, outcome-tracker, distiller, committee | memory, shared |
| **Dashboard** | router, metrics, app.jsx | shared, config |
| **Shared** | auth, utils, logger, fts-sanitizer, anthropic | config |
| **Config** | config.js, effy.config.yaml | (none) |

## Agent Pipeline (Message → Response)

```
User Message
  → Slack Adapter (event parse)
  → Message Coalescer (debounce 150ms)
  → Middleware Chain (rate limit, format)
  → Binding Router (channel → agent)
  → Model Router (complexity → tier1-4)
  → Budget Gate (cost check → downgrade)
  → Context Build (3-route parallel + Context Hub)
  → System Prompt Assembly (Layered: Core → Domain → Orientation)
  → Agent Runtime (Anthropic Agentic Loop, max 10 iterations)
    → Tool Execution (31 tools, admin guard, result guard)
  → Response → Slack
  → Memory Persist (Working + Episodic + Entity + Graph)
  → Run Logger + Outcome Tracker
  → SSE Dashboard Broadcast
```

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| 4-Tier Model Routing | Cost optimization: 대부분 Haiku(저비용), 복잡한 것만 Opus |
| Single Tool Registry | SSOT: 도구 정의, 접근 제어, 검증, 스키마가 한 파일에 |
| Admin-only via registry flag | 동적 추출: auth.js가 tool-registry.adminOnly를 읽음 |
| Context Budget Profiles | Progressive Disclosure: LIGHT(8K) skips search, DEEP(70K) full |
| BM25 + FTS5 Hybrid Search | Context Hub: 빠른 키워드 검색, 무거운 임베딩 서버 불필요 |
| SQLite Phase 1 | 단일 배포 최적화. Phase 2에서 PostgreSQL 전환 예정 |
| NDJSON Run Logger | Append-only, jq로 실시간 쿼리 가능, 일별 자동 로테이션 |

## File Quick Reference

| Need | Look At |
|------|---------|
| 도구 추가 | `src/agents/tool-registry.js` → `TOOL_DEFINITIONS` |
| 에이전트 성격 변경 | `agents/{id}/SOUL.md` |
| 메모리 검색 튜닝 | `src/memory/context.js` → Budget profiles |
| 보안 규칙 | `src/shared/auth.js` + `RULES.json` |
| 비용 설정 | `effy.config.yaml` → `cost` 섹션 |
| 대시보드 API | `src/dashboard/api/metrics.js` |
