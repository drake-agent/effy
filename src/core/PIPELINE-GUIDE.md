# Pipeline System Guide

Effy의 새로운 구성 가능한 파이프라인 추상화 시스템.

## 개요

기존의 고정된 13단계 메시지 파이프라인을 대체하는 동적, 구성 가능한 시스템입니다. AgentScope의 Pipeline 패턴을 기반으로 설계되었습니다.

### 핵심 특징

- **구성 가능**: 스텝을 자유롭게 추가/제거/순서 변경
- **재사용 가능**: 사전 구성된 스텝으로 빠른 개발
- **중첩 가능**: 파이프라인을 다른 파이프라인에 포함
- **설정 기반**: YAML으로 파이프라인 정의
- **에러 안전**: 타임아웃, 에러 처리, 복구 메커니즘
- **모니터링**: 실행 시간, 메모리, 로깅 추적

## 파일 구조

```
src/core/
├── pipeline.js           # 핵심 파이프라인 클래스 (5가지 타입)
├── pipeline-steps.js     # 사전 구성된 스텝 (auth, routing, etc)
├── pipeline-builder.js   # 유창한 빌더 API + 설정 로더
├── pipeline-examples.js  # 사용 예제 및 패턴
└── PIPELINE-GUIDE.md     # 이 문서
```

## 5가지 파이프라인 타입

### 1. SequentialPipeline (순차 실행)

각 스텝이 이전 스텝의 결과를 받아 순차적으로 실행.

```javascript
const pipeline = Pipeline.sequential('message-processing')
  .addStep(authStep)
  .addStep(routeStep)
  .addStep(runtimeStep);

const result = await pipeline.execute(context);
```

**용도**: 기본 메시지 처리, 선형 워크플로우

### 2. FanoutPipeline (병렬 실행)

모든 스텝을 동시에 실행하고 결과를 수집.

```javascript
const pipeline = Pipeline.fanout('notification-dispatch')
  .addStep(notifySlack)
  .addStep(notifyEmail)
  .addStep(logAnalytics);

const result = await pipeline.execute(context);
// result.fanout.results = { notifySlack, notifyEmail, logAnalytics }
```

**용도**: 알림 전송, 병렬 분석, 다중 채널 업데이트

### 3. ConditionalPipeline (조건부 라우팅)

조건 함수 결과에 따라 다른 경로 실행.

```javascript
const pipeline = Pipeline.conditional('severity-router')
  .setCondition((ctx) => ctx.severity === 'critical')
  .whenTrue(criticalResponsePipeline)
  .whenFalse(standardResponseStep);

const result = await pipeline.execute(context);
```

**용도**: 요청 타입별 라우팅, A/B 테스트, 기능 플래그

### 4. IterativePipeline (반복 실행)

조건을 만족할 때까지 반복 실행 (최대 반복 제한).

```javascript
const pipeline = Pipeline.iterative('retry-logic')
  .setStep(fetchDataStep)
  .setCondition((ctx) => ctx.success || ctx.attempts >= 3)
  .setMaxIterations(3);

const result = await pipeline.execute(context);
// result.iterations = 실제 반복 횟수
```

**용도**: 재시도 로직, 폴링, 루프 처리

### 5. AgentPipeline (에이전트 체인)

여러 Effy 에이전트를 순차적으로 실행.

```javascript
const pipeline = Pipeline.agent('code-generation')
  .addAgent('code-writer', async (ctx) => {
    // Code Agent
    return { code: '...' };
  })
  .addAgent('reviewer', async (ctx) => {
    // Review Agent
    return { feedback: '...' };
  })
  .addAgent('documenter', async (ctx) => {
    // Documentation Agent
    return { docs: '...' };
  });

const result = await pipeline.execute(context);
// result.agentResults = { 'code-writer', 'reviewer', 'documenter' }
```

**용도**: 다단계 AI 워크플로우, 협업 에이전트

## 사전 구성된 스텝 (pipeline-steps.js)

### 기본 스텝 (설정 불필요)

| 스텝 | 설명 | 추가 정보 |
|------|------|---------|
| `authStep` | 인증 & 보안 검증 | 봇 필터, 차단 사용자 |
| `rateLimitStep` | 속도 제한 | 사용자별 슬라이딩 윈도우 |
| `coalesceStep` | 메시지 병합 | 배치 처리 |
| `routeStep` | 기능 라우팅 | agent 타입 결정 |
| `contextBuildStep` | 컨텍스트 조립 | 메모리 로드 |
| `runtimeStep` | 에이전트 실행 | LLM 호출 |
| `memoryPersistStep` | 메모리 저장 | L1/L2/L4 동기화 |
| `logStep` | 이벤트 로깅 | RunLogger 기록 |

### 팩토리 함수 (의존성 주입)

외부 인스턴스를 받아 스텝을 동적으로 생성.

```javascript
// CircuitBreaker 주입
const cbStep = circuitBreakerStep(circuitBreakerInstance);

// ModelRouter 주입
const mrStep = modelRouterStep(modelRouterInstance);

// BudgetGate 주입
const bgStep = budgetGateStep(budgetGateInstance);

// ConcurrencyGovernor 주입
const cStep = concurrencyStep(governorInstance);

// Reflection 주입
const refStep = reflectionStep(reflectionInstance);
```

## 유창한 빌더 API

### 기본 사용

```javascript
const pipeline = PipelineBuilder.create('my-pipeline')
  .sequential()
    .step(authStep)
    .step(rateLimitStep)
    .step(routeStep)
  .end()
  .build();
```

### 중첩된 복잡 파이프라인

```javascript
const pipeline = PipelineBuilder.create('complex-workflow')
  // 순차 (초기화)
  .sequential('init')
    .step(authStep)
    .step(rateLimitStep)
  .end()
  // 조건부 분기
  .conditional(
    (ctx) => ctx.routing.agent === 'code',
    'type-check'
  )
    .whenTrue(
      // Code 요청: 병렬 처리
      PipelineBuilder.create('code-path')
        .fanout()
          .step(staticAnalysisStep)
          .step(executionStep)
        .end()
        .build()
    )
    .whenFalse(
      // 일반 요청
      standardProcessingStep
    )
  .end()
  // 마무리
  .sequential('finalize')
    .step(memoryPersistStep)
    .step(logStep)
  .end()
  .build();
```

### 빌더 메서드

**SequentialBuilder**
- `.step(fn)` - 스텝 추가
- `.steps([fn, fn, ...])` - 다중 스텝 추가
- `.end()` - 파이프라인 종료

**FanoutBuilder**
- `.step(fn)` - 병렬 스텝 추가
- `.steps([fn, fn, ...])` - 다중 병렬 스텝
- `.end()` - 파이프라인 종료

**ConditionalBuilder**
- `.whenTrue(pipeline|fn)` - True 분기
- `.whenFalse(pipeline|fn)` - False 분기
- `.end()` - 파이프라인 종료

**IterativeBuilder**
- `.maxIterations(n)` - 최대 반복 횟수
- `.end()` - 파이프라인 종료

**AgentBuilder**
- `.agent(name, handler)` - 에이전트 추가
- `.agents([...])` - 다중 에이전트
- `.end()` - 파이프라인 종료

## 설정 기반 파이프라인 (YAML)

### effy.config.yaml

```yaml
pipelines:
  # 기본 메시지 처리
  default:
    steps: [auth, rateLimit, coalesce, route, contextBuild, runtime, memoryPersist, log]

  # 인시던트 처리 (조건부)
  incident:
    steps: [auth, route]
    then:
      conditional:
        field: severity
        critical: [notifyOps, notifySlack, escalate]
        default: [standardResponse]

  # 코드 분석 (병렬)
  codeAnalysis:
    steps: [auth]
    parallel: [staticAnalysis, unitTest, documentation]

  # 재시도 로직
  resilient:
    steps: [auth, route]
    retry:
      maxAttempts: 3
      backoffMs: 1000
```

### 프로그래밍 방식 로딩

```javascript
const { ConfigBasedPipelineLoader } = require('./pipeline-builder');

const loader = new ConfigBasedPipelineLoader();

// 스텝 등록
loader.registerSteps({
  auth: authStep,
  rateLimit: rateLimitStep,
  route: routeStep,
  // ... 기타 스텝
});

// 설정에서 로드
loader.loadFromConfig(config.pipelines);

// 파이프라인 사용
const pipeline = loader.getPipeline('default');
const result = await pipeline.execute(context);
```

## 컨텍스트 객체 (Context)

모든 파이프라인 스텝이 주고받는 객체.

```javascript
{
  // 기본 정보
  sender: { id, name, isBot },
  channel: { channelId, isDM },
  message: { content: { text }, metadata },

  // 스텝별 추가 정보
  traceId,           // 추적 ID
  auth: { passed },  // 인증 결과
  routing: {
    agent,           // code|ops|knowledge|general
    confidence
  },
  contextBuilt: {
    memories: { l1, l2, l4 }
  },
  runtime: {
    executed,
    modelUsed,
    tokensUsed
  },
  agentResponse: { ... },

  // 에러 정보
  error,
  reason
}
```

## 실행 결과 (PipelineResult)

```javascript
{
  success: boolean,           // 전체 성공 여부
  context: object,            // 최종 context 상태
  history: [                  // 실행된 스텝 이력
    { name, status, error }
  ],
  executionTime: number,      // 실행 시간 (ms)
  error: string,              // 에러 메시지
  iterations: number,         // 반복 파이프라인에서만
  agentResults: object        // 에이전트 파이프라인에서만
}
```

## 에러 처리

### 스텝 레벨 에러

스텝에서 throw한 에러는 자동으로 처리됨:

```javascript
const step = async (ctx) => {
  if (!ctx.sender) {
    const err = new Error('Missing sender');
    err.shouldNotify = true; // 사용자에게 알림
    throw err;
  }
  return ctx;
};
```

### 파이프라인 레벨 에러

결과에서 `success: false` 확인:

```javascript
const result = await pipeline.execute(context);
if (!result.success) {
  console.error(result.error);
  // 폴백 처리
}
```

### 타임아웃

각 파이프라인의 `timeout` 프로퍼티로 설정:

```javascript
const pipeline = Pipeline.sequential('slow-pipeline');
pipeline.timeout = 60000; // 60초
```

## 성능 최적화

### 병렬 처리

I/O 바운드 작업은 FanoutPipeline 사용:

```javascript
// 나쁜 예: 순차 (20ms + 20ms + 20ms = 60ms)
.sequential()
  .step(queryDB)    // 20ms
  .step(fetchAPI)   // 20ms
  .step(cacheLookup) // 20ms

// 좋은 예: 병렬 (max(20ms) ≈ 20ms)
.fanout()
  .step(queryDB)    // 20ms
  .step(fetchAPI)   // 20ms
  .step(cacheLookup) // 20ms
```

### 조기 종료 (Early Exit)

불필요한 스텝 생략:

```javascript
.conditional(
  (ctx) => ctx.cached,
  'cache-check'
)
  .whenTrue(async (ctx) => ctx) // 캐시 사용
  .whenFalse(expensiveComputationPipeline)
```

### 폴백 처리

주 파이프라인 실패 시 폴백:

```javascript
const result = await mainPipeline.execute(context);
if (!result.success) {
  return await fallbackPipeline.execute(context);
}
return result;
```

## 마이그레이션 가이드

### 기존 13단계 → 새 파이프라인 시스템

**이전 (Gateway.js에서)**:
```javascript
// ① 미들웨어
const mw = runMiddleware(event);
if (!mw.pass) return;

// ② 바인딩 라우팅
// ... 직렬 처리

// ③ 기능 라우팅
// ... 더 직렬 처리

// ... 13단계 계속
```

**새 방식**:
```javascript
const pipeline = PipelineBuilder.create('message-processing')
  .sequential()
    .step(authStep)
    .step(rateLimitStep)
    .step(routeStep)
    .step(contextBuildStep)
    .step(runtimeStep)
    .step(memoryPersistStep)
    .step(logStep)
  .end()
  .build();

const result = await pipeline.execute(context);
if (!result.success) {
  // 에러 처리
}
```

## 테스트

### 단위 테스트

```javascript
describe('AuthStep', () => {
  it('should reject bot messages', async () => {
    const context = { sender: { id: 'bot', isBot: true } };
    try {
      await authStep(context);
      fail('Expected error');
    } catch (err) {
      expect(err.message).toContain('bot');
    }
  });
});
```

### 통합 테스트

```javascript
describe('MessagePipeline', () => {
  it('should process valid message', async () => {
    const pipeline = exampleBasicSequentialPipeline();
    const context = { /* valid context */ };
    const result = await pipeline.execute(context);
    expect(result.success).toBe(true);
    expect(result.history.length).toBeGreaterThan(0);
  });
});
```

## 문제 해결

### 파이프라인이 시간 초과됨

- 타임아웃 값 증가: `pipeline.timeout = 60000`
- 병렬화 검토: FanoutPipeline 사용 검토
- 슬로우 스텝 프로파일링

### 메모리 누수

- 반복 파이프라인의 maxIterations 확인
- 큰 context 객체 모니터링
- 정리 함수 호출 확인

### 예상치 못한 분기

- 조건 함수 로직 검토
- context 객체 상태 로깅
- whenTrue/whenFalse 분기 확인

## 향후 확장

- [ ] 비동기 이벤트 기반 파이프라인
- [ ] 동적 스텝 추가 (런타임)
- [ ] 파이프라인 버전 관리
- [ ] 성능 메트릭 대시보드
- [ ] 파이프라인 사이 데이터 변환 (transformer)

## 참고 자료

- AgentScope Pipeline: https://agentscope.io/
- Effy Architecture: /docs/architecture.md
- Middleware System: /src/core/middleware.js
