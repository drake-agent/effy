# Pipeline System Architecture

## System Overview

Effy의 새로운 파이프라인 시스템은 13단계 고정 메시지 처리 흐름을 동적, 구성 가능한 아키텍처로 대체합니다.

```
┌─────────────────────────────────────────────────────────────┐
│                    Pipeline System                           │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌───────────────────────────────────────────────────────┐  │
│  │          5 Pipeline Types (pipeline.js)               │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │                                                       │  │
│  │  1. Sequential    → Step₁ → Step₂ → Step₃           │  │
│  │  2. Fanout        → [Step₁, Step₂, Step₃] parallel  │  │
│  │  3. Conditional   → if(cond) → TrueBranch          │  │
│  │  4. Iterative     → while(cond) { Step }             │  │
│  │  5. Agent         → Agent₁ → Agent₂ → Agent₃        │  │
│  │                                                       │  │
│  └───────────────────────────────────────────────────────┘  │
│                           ↓                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │    Pre-built Steps (pipeline-steps.js)                │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │                                                       │  │
│  │  authStep, rateLimitStep, routeStep,                 │  │
│  │  contextBuildStep, runtimeStep,                      │  │
│  │  memoryPersistStep, logStep,                         │  │
│  │  circuitBreakerStep, modelRouterStep, ...            │  │
│  │                                                       │  │
│  └───────────────────────────────────────────────────────┘  │
│                           ↓                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Fluent Builder + Config Loader (pipeline-builder.js)│  │
│  ├───────────────────────────────────────────────────────┤  │
│  │                                                       │  │
│  │  PipelineBuilder.create('name')                      │  │
│  │    .sequential()                                      │  │
│  │      .step(authStep)                                 │  │
│  │    .end()                                            │  │
│  │    .build()                                          │  │
│  │                                                       │  │
│  │  ConfigBasedPipelineLoader (YAML)                    │  │
│  │                                                       │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. pipeline.js (3.8 KB, ~350 lines)

**BasePipeline** (추상 클래스)
- 모든 파이프라인의 기반
- `execute(context)` 인터페이스 정의
- 타임아웃 처리, 에러 관리

**SequentialPipeline**
- 순차 실행: Step₁(ctx) → Step₂(result₁) → Step₃(result₂)
- 메시지 처리 기본 흐름
- 라인형 워크플로우

**FanoutPipeline**
- 병렬 실행: Promise.all([Step₁, Step₂, Step₃])
- 모든 결과를 context.fanout.results에 수집
- 알림, 분석, 추적 등 독립적 작업

**ConditionalPipeline**
- 조건 함수 결과에 따라 분기
- True/False 각각 파이프라인 또는 함수 실행
- 요청 타입별 라우팅

**IterativePipeline**
- while(condition(ctx)) { step(ctx) }
- maxIterations로 무한 루프 방지
- 재시도, 폴링 패턴

**AgentPipeline**
- 에이전트 순차 체인: Agent₁ → Agent₂ → Agent₃
- 각 에이전트 결과를 context[agentName]에 저장
- Code → Review → Documentation 패턴

**Pipeline** (팩토리)
```javascript
Pipeline.sequential() // SequentialPipeline 반환
Pipeline.fanout()     // FanoutPipeline 반환
Pipeline.conditional() // ConditionalPipeline 반환
Pipeline.iterative()  // IterativePipeline 반환
Pipeline.agent()      // AgentPipeline 반환
```

### 2. pipeline-steps.js (5.2 KB, ~400 lines)

**기본 스텝** (설정 불필요)
```
authStep
  ├─ 봇 메시지 필터링
  ├─ 차단 사용자 검사
  └─ 기타 보안 검증

rateLimitStep
  ├─ 사용자별 슬라이딩 윈도우
  └─ 요청 속도 제한

routeStep
  ├─ 키워드 분석
  └─ agent 타입 결정 (code|ops|knowledge|general)

contextBuildStep
  ├─ L1 Working Memory (단기)
  ├─ L2 Episodic Memory (에피소드)
  └─ L4 Entity Memory (엔티티)

runtimeStep
  ├─ LLM 호출
  ├─ 도구 실행
  └─ 응답 생성

memoryPersistStep
  ├─ L1 업데이트
  ├─ L2 저장
  └─ L4 동기화

logStep
  ├─ RunLogger 기록
  └─ 추적 ID 관리
```

**팩토리 함수** (의존성 주입)
```javascript
circuitBreakerStep(breaker)  // CircuitBreaker
modelRouterStep(router)      // ModelRouter (5단계)
budgetGateStep(gate)         // BudgetGate (비용 제어)
concurrencyStep(governor)    // ConcurrencyGovernor
reflectionStep(reflection)   // Reflection (자기개선)
```

### 3. pipeline-builder.js (4.9 KB, ~450 lines)

**PipelineBuilder** (유창한 API)
```javascript
PipelineBuilder.create('name')
  .sequential()
    .step(fn)
    .steps([fn, fn])
  .end()
  .conditional(fn)
    .whenTrue(pipeline|fn)
    .whenFalse(pipeline|fn)
  .end()
  .fanout()
    .step(fn)
  .end()
  .build() // BasePipeline 반환
```

**ConfigBasedPipelineLoader** (설정 기반)
- YAML 설정에서 파이프라인 정의 로드
- 동적 스텝 등록/조회
- 조건부 라우팅 설정

## Data Flow

### Context 객체 (파이프라인 스텝 간 전달)

```javascript
{
  // 입력 정보
  sender: {
    id: 'U123',
    name: 'Alice',
    isBot: false
  },
  channel: {
    channelId: 'C456',
    isDM: false
  },
  message: {
    content: { text: 'help with code' },
    metadata: { ts: 1234567890 }
  },

  // 스텝별 추가 정보 (누적)
  traceId: 't-1234567890-abc123',

  auth: {
    passed: true,
    reason: null
  },

  routing: {
    agent: 'code',
    confidence: 0.95,
    keywords: ['code', 'help']
  },

  contextBuilt: {
    memories: {
      l1: [/* 최근 메시지 */],
      l2: [/* 에피소드 */],
      l4: [/* 엔티티 */]
    },
    assembled: true
  },

  runtime: {
    executed: true,
    modelUsed: 'claude-3-opus',
    tokensUsed: 1234
  },

  agentResponse: {
    text: '답변...',
    toolCalls: [...]
  },

  memoryPersist: {
    l1Updated: true,
    l2Saved: true,
    l4Synced: true
  },

  logged: {
    traceId: 't-...',
    timestamp: '2024-01-01T00:00:00Z',
    recorded: true
  }
}
```

### PipelineResult 객체 (실행 결과)

```javascript
{
  success: true,
  context: { /* 최종 상태 */ },
  history: [
    { name: 'authStep', status: 'success' },
    { name: 'rateLimitStep', status: 'success' },
    { name: 'routeStep', status: 'success' },
    // ...
  ],
  executionTime: 456, // ms
  error: null,
  iterations: 1       // iterative만
}
```

## Integration with Effy's 13-Step Pipeline

### 매핑 테이블

| 기존 단계 | 새 스텝 | 파이프라인 타입 |
|----------|--------|----------------|
| ① 미들웨어 | authStep, rateLimitStep | Sequential |
| ②.5 온보딩 | 조건부 (아직 미통합) | Conditional |
| ②.6 NL Config | 조건부 | Conditional |
| ② 바인딩 라우팅 | 컨텍스트 (아직 미통합) | - |
| ③ 기능 라우팅 | routeStep | Sequential |
| ③.5 ModelRouter | modelRouterStep | Sequential |
| ④ CircuitBreaker | circuitBreakerStep | Sequential |
| ④.5 동시성 체크 | concurrencyStep | Sequential |
| ⑤ 세션 터치 | 컨텍스트 (아직 미통합) | - |
| ⑥ L1 메모리 | contextBuildStep | Sequential |
| ⑥.7 Compaction | 컨텍스트 (아직 미통합) | - |
| ⑥.9 Reflection | reflectionStep | Sequential |
| ⑦ L2 저장 | memoryPersistStep | Sequential |
| ⑧ L4 업데이트 | memoryPersistStep | Sequential |
| ⑨ Context Assembler | contextBuildStep | Sequential |
| ⑨.5 Bulletin 주입 | 컨텍스트 (아직 미통합) | - |
| ⑨.6 Skills 주입 | 컨텍스트 (아직 미통합) | - |
| ⑨.7 Lesson 주입 | 컨텍스트 (아직 미통합) | - |
| ⑨.7.2 BudgetGate | budgetGateStep | Sequential |
| ⑩ Agent Runtime | runtimeStep | Sequential |
| ⑪ RunLogger | logStep | Sequential |
| ⑫ 응답 전송 | 컨텍스트 (아직 미통합) | - |
| ⑬ 정리 | 컨텍스트 (아직 미통합) | - |

## Usage Patterns

### Pattern 1: 기본 메시지 처리

```
auth → rateLimit → route → contextBuild → runtime → memoryPersist → log
```

### Pattern 2: 조건부 심각도 처리

```
auth → route → [condition: severity]
  ├─ CRITICAL: notify_ops (parallel) + escalate
  └─ NORMAL: standard_response
```

### Pattern 3: 병렬 분석

```
auth → route → [fanout]
  ├─ static_analysis
  ├─ dynamic_test
  └─ performance_check
→ aggregate_results
```

### Pattern 4: 에이전트 협업

```
CodeAgent (write) → ReviewAgent (check) → KnowledgeAgent (document)
```

### Pattern 5: 재시도 로직

```
[iterative]
  → fetch_data
  → [until: success OR attempts >= 3]
→ process_result
```

## Performance Characteristics

### Time Complexity

| 파이프라인 | N 스텝 시간복잡도 | 설명 |
|-----------|------------------|------|
| Sequential | O(N) | 선형: 모든 스텝 순차 |
| Fanout | O(1) | 상수: 모든 스텝 병렬 |
| Conditional | O(N) | 선형: 조건 + 1개 분기 |
| Iterative | O(N×M) | N: 스텝 수, M: 반복 횟수 |
| Agent | O(N) | 선형: 에이전트 순차 |

### Space Complexity

```
Sequential:  O(1) - 이전 결과만 보유
Fanout:      O(N) - 모든 결과 저장
Conditional: O(1) - 한 분기만 실행
Iterative:   O(M) - 반복 상태 보유
Agent:       O(N) - 모든 에이전트 결과
```

## Error Handling Strategy

### 3-Level Error Architecture

```
┌─ Step-Level ──────────────────────┐
│ try/catch in step function        │
│ → throw custom error with reason  │
├─────────────────────────────────┤
│ Pipeline-Level ────────────────│
│ catch in execute()              │
│ → record history                │
│ → return result.success = false  │
├─────────────────────────────────┤
│ Application-Level ─────────────│
│ check result.success            │
│ → fallback pipeline             │
│ → user notification             │
└─────────────────────────────────┘
```

## Logging & Monitoring

### Built-in Metrics

```javascript
result.history[i] = {
  name,              // 스텝 이름
  status,            // success|error
  error,             // 에러 메시지
  timestamp          // 실행 시각 (선택)
}

result.executionTime // 전체 실행 시간 (ms)
```

### Example Monitoring

```javascript
const result = await pipeline.execute(context);
console.log(`Pipeline: ${result.executionTime}ms`);
result.history.forEach((step, i) => {
  console.log(`  ${i+1}. ${step.name}: ${step.status}`);
});
```

## Security Considerations

1. **Input Validation**: authStep에서 검증
2. **Rate Limiting**: rateLimitStep로 제어
3. **Timeout Protection**: 각 파이프라인 타임아웃
4. **Resource Limits**: ConcurrencyGovernor, BudgetGate
5. **Error Isolation**: 스텝 실패가 다른 스텝에 영향 없음

## Testing Strategy

### Unit Testing

```javascript
describe('AuthStep', () => {
  it('should reject rate-limited users', async () => {
    const result = await authStep({ /* context */ });
    expect(result).toBeDefined();
  });
});
```

### Integration Testing

```javascript
describe('MessagePipeline', () => {
  it('should process complete workflow', async () => {
    const result = await pipeline.execute(context);
    expect(result.success).toBe(true);
    expect(result.history.length).toBe(7);
  });
});
```

### Load Testing

```javascript
// N개 파이프라인 동시 실행
const results = await Promise.all([
  pipeline.execute(ctx1),
  pipeline.execute(ctx2),
  // ...
]);
```

## Future Enhancements

- [ ] **Reactive Pipeline**: 비동기 이벤트 기반
- [ ] **Dynamic Steps**: 런타임 스텝 추가/제거
- [ ] **Version Management**: 파이프라인 버전 관리
- [ ] **Metrics Dashboard**: 성능 모니터링 UI
- [ ] **Transformer Functions**: 스텝 간 데이터 변환
- [ ] **Middleware Pattern**: 파이프라인 전후 훅
- [ ] **Circuit Breaker**: 자동 장애 격리
- [ ] **Distributed Tracing**: 분산 추적 지원

## File Statistics

| 파일 | 크기 | 라인 | 클래스/함수 |
|------|------|------|-----------|
| pipeline.js | 16 KB | ~500 | 7 클래스 |
| pipeline-steps.js | 11 KB | ~350 | 8+5 함수 |
| pipeline-builder.js | 13 KB | ~450 | 6 클래스 |
| pipeline-examples.js | 12 KB | ~400 | 10 함수 |
| **합계** | **52 KB** | **~1700** | **30+** |

## References

- **AgentScope**: https://agentscope.io/docs/tutorial/pipeline/
- **Effy Gateway**: src/gateway/gateway.js (13단계 참조)
- **Memory System**: src/memory/
- **Agent Runtime**: src/agents/runtime.js
