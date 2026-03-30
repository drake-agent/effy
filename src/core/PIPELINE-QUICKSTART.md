# Pipeline System Quick Start

## 30초 시작하기

```javascript
const { Pipeline } = require('./pipeline');
const { authStep, routeStep, runtimeStep } = require('./pipeline-steps');

// 파이프라인 생성
const pipeline = Pipeline.sequential('my-pipeline')
  .addStep(authStep)
  .addStep(routeStep)
  .addStep(runtimeStep);

// 실행
const result = await pipeline.execute(context);
console.log(result.success ? '성공' : `실패: ${result.error}`);
```

## 주요 메서드

### Pipeline (팩토리)

```javascript
Pipeline.sequential(name)    // SequentialPipeline
Pipeline.fanout(name)        // FanoutPipeline
Pipeline.conditional(name)   // ConditionalPipeline
Pipeline.iterative(name)     // IterativePipeline
Pipeline.agent(name)         // AgentPipeline
```

### SequentialPipeline / FanoutPipeline

```javascript
pipeline.addStep(fn)         // 스텝 추가
pipeline.execute(context)    // 실행
pipeline.timeout = 5000      // 타임아웃 설정
```

### ConditionalPipeline

```javascript
pipeline.setCondition(fn)    // 조건 설정
pipeline.whenTrue(branch)    // True 분기
pipeline.whenFalse(branch)   // False 분기
```

### IterativePipeline

```javascript
pipeline.setStep(fn)         // 반복 스텝
pipeline.setCondition(fn)    // 종료 조건
pipeline.setMaxIterations(3) // 최대 반복
```

### AgentPipeline

```javascript
pipeline.addAgent(name, handler) // 에이전트 추가
```

## 빌더 API

```javascript
const { PipelineBuilder } = require('./pipeline-builder');

const pipeline = PipelineBuilder.create('name')
  .sequential()
    .step(authStep)
    .steps([routeStep, runtimeStep])
  .end()
  .conditional((ctx) => ctx.severity === 'critical')
    .whenTrue(urgentPipeline)
    .whenFalse(normalPipeline)
  .end()
  .build();
```

## 자주 사용하는 패턴

### 패턴 1: 순차 처리

```javascript
Pipeline.sequential('simple')
  .addStep(authStep)
  .addStep(rateLimitStep)
  .addStep(routeStep)
```

### 패턴 2: 병렬 처리

```javascript
Pipeline.fanout('parallel')
  .addStep(notifySlack)
  .addStep(notifyEmail)
  .addStep(logEvent)
```

### 패턴 3: 조건부 분기

```javascript
const pipeline = Pipeline.conditional('router');
pipeline.setCondition((ctx) => ctx.isUrgent);
pipeline.whenTrue(urgentHandler);
pipeline.whenFalse(normalHandler);
```

### 패턴 4: 재시도

```javascript
Pipeline.iterative('retry')
  .setStep(async (ctx) => {
    ctx.attempts = (ctx.attempts || 0) + 1;
    return await riskyOperation(ctx);
  })
  .setCondition((ctx) => ctx.success || ctx.attempts >= 3)
  .setMaxIterations(3)
```

### 패턴 5: 에이전트 체인

```javascript
Pipeline.agent('workflow')
  .addAgent('writer', codeWriterAgent)
  .addAgent('reviewer', codeReviewerAgent)
  .addAgent('documenter', docsAgent)
```

### 패턴 6: 복잡한 중첩

```javascript
PipelineBuilder.create('complex')
  .sequential('auth')
    .step(authStep)
  .end()
  .conditional((ctx) => ctx.agent === 'code')
    .whenTrue(
      PipelineBuilder.create('code-path')
        .fanout()
          .step(analyze)
          .step(execute)
        .end()
        .build()
    )
    .whenFalse(defaultHandler)
  .end()
  .sequential('finalize')
    .step(saveMemory)
    .step(logEvent)
  .end()
  .build()
```

## 스텝 목록

### 기본 스텝

```javascript
authStep              // 인증 + 봇 필터
rateLimitStep         // 속도 제한
routeStep             // 요청 라우팅
contextBuildStep      // 메모리 로드
runtimeStep           // 에이전트 실행
memoryPersistStep     // 메모리 저장
logStep               // 이벤트 로깅
```

### 의존성 주입 스텝

```javascript
circuitBreakerStep(breaker)    // CircuitBreaker
modelRouterStep(router)        // ModelRouter
budgetGateStep(gate)           // BudgetGate
concurrencyStep(governor)      // ConcurrencyGovernor
reflectionStep(reflection)     // Reflection
```

## 에러 처리

### 기본 에러 처리

```javascript
const result = await pipeline.execute(context);

if (!result.success) {
  console.error(`에러: ${result.error}`);
  console.log(`히스토리: ${result.history.map(h => h.name).join(' → ')}`);

  // 폴백 처리
  return await fallbackPipeline.execute(context);
}
```

### 스텝 레벨 에러

```javascript
const customStep = async (ctx) => {
  if (!isValid(ctx)) {
    const err = new Error('Invalid context');
    err.shouldNotify = true;  // 사용자 알림
    throw err;
  }
  return ctx;
};
```

## 실행 결과

```javascript
{
  success: boolean,           // 성공/실패
  context: object,            // 최종 상태
  history: [                  // 스텝 이력
    { name, status, error }
  ],
  executionTime: number,      // ms
  error: string,              // 에러 메시지
  iterations: number,         // 반복 파이프라인
  agentResults: object        // 에이전트 파이프라인
}
```

## 설정 파일 예제 (effy.config.yaml)

```yaml
pipelines:
  default:
    steps: [auth, rateLimit, route, contextBuild, runtime, memoryPersist, log]

  urgent:
    steps: [auth, route]
    then:
      conditional:
        field: severity
        critical: [notifyOps, escalate]
        default: [standardResponse]
```

## 설정에서 로드

```javascript
const { ConfigBasedPipelineLoader } = require('./pipeline-builder');

const loader = new ConfigBasedPipelineLoader();
loader.registerSteps({
  auth: authStep,
  rateLimit: rateLimitStep,
  route: routeStep,
  // ...
});

loader.loadFromConfig(config.pipelines);
const pipeline = loader.getPipeline('default');
```

## 성능 최적화 팁

| 상황 | 권장 방법 |
|------|---------|
| 독립적 작업 | FanoutPipeline 사용 |
| 캐시 확인 | ConditionalPipeline + 폴백 |
| 재시도 필요 | IterativePipeline |
| 많은 스텝 | 논리적 그룹으로 중첩 |
| 높은 트래픽 | ConcurrencyGovernor 적용 |

## 디버깅

### 스텝별 로깅

```javascript
const debugStep = (name) => async (ctx) => {
  console.log(`[${name}] Before:`, ctx);
  // ... 처리 ...
  console.log(`[${name}] After:`, ctx);
  return ctx;
};

pipeline.addStep(debugStep('step-1'));
```

### 성능 프로파일링

```javascript
const result = await pipeline.execute(context);
console.log(`전체: ${result.executionTime}ms`);
result.history.forEach((step, i) => {
  console.log(`  ${i+1}. ${step.name}: ${step.status}`);
});
```

### 조건 테스트

```javascript
const condition = (ctx) => ctx.isUrgent;
console.log('Condition result:', condition(testContext));
```

## 공통 실수

### ❌ 잘못된 스텝 함수

```javascript
// 에러: 함수가 아님
pipeline.addStep({ name: 'invalid' });

// 올바름
pipeline.addStep(async (ctx) => ctx);
```

### ❌ Context 변경 안 함

```javascript
// 에러: context 수정 없음
const badStep = async (ctx) => {
  ctx.value = 10; // 직접 수정
};

// 올바름
const goodStep = async (ctx) => ({
  ...ctx,
  value: 10  // 새 객체 반환
});
```

### ❌ 비동기 처리 누락

```javascript
// 에러: async 키워드 없음
const badStep = (ctx) => ctx;

// 올바름
const goodStep = async (ctx) => ctx;
```

## 라이프사이클

```
create → add steps → build → execute → handle result
  |          |          |         |           |
  v          v          v         v           v
new class  configure  finalize  run steps  check success
```

## 다음 단계

1. [PIPELINE-GUIDE.md](./PIPELINE-GUIDE.md) - 자세한 가이드
2. [PIPELINE-ARCHITECTURE.md](./PIPELINE-ARCHITECTURE.md) - 아키텍처
3. [pipeline-examples.js](./pipeline-examples.js) - 10가지 예제
4. [src/core/](../) - 통합 예제 확인

## FAQ

**Q: 파이프라인을 재사용할 수 있나?**
A: 네, 생성 후 여러 번 execute() 호출 가능합니다.

**Q: Context는 불변인가?**
A: 아니요, 스텝에서 수정하면 다음 스텝에 전달됩니다. 원본 보존이 필요하면 스프레드 연산자 사용.

**Q: 스텝 순서를 동적으로 바꿀 수 있나?**
A: 현재는 구성 후 고정입니다. 동적 순서는 ConfigBasedPipelineLoader 또는 빌더로 미리 구성.

**Q: 타임아웃은?**
A: `pipeline.timeout = 5000`으로 설정 (기본 30초).

**Q: 에러 발생 시 멈추나?**
A: Sequential/Fanout은 즉시 멈춤. Conditional/Iterative는 분기 로직에 따라 결정.

---

**Created**: March 27, 2024
**Version**: 1.0.0
**Status**: Production Ready
