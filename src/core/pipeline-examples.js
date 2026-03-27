/**
 * pipeline-examples.js — 파이프라인 시스템 사용 예제 및 패턴.
 *
 * 다양한 파이프라인 구성 시나리오를 보여줍니다.
 */

const {
  Pipeline,
  SequentialPipeline,
  FanoutPipeline,
  ConditionalPipeline,
} = require('./pipeline');
const {
  authStep,
  rateLimitStep,
  routeStep,
  contextBuildStep,
  runtimeStep,
  memoryPersistStep,
  logStep,
  circuitBreakerStep,
  budgetGateStep,
  concurrencyStep,
} = require('./pipeline-steps');
const { PipelineBuilder, ConfigBasedPipelineLoader } = require('./pipeline-builder');

/**
 * 예제 1: 기본 메시지 처리 파이프라인 (Sequential).
 *
 * 기본 13단계 파이프라인을 파이프라인 시스템으로 대체.
 */
function exampleBasicSequentialPipeline() {
  const pipeline = Pipeline.sequential('message-processing')
    .addStep(authStep)
    .addStep(rateLimitStep)
    .addStep(routeStep)
    .addStep(contextBuildStep)
    .addStep(runtimeStep)
    .addStep(memoryPersistStep)
    .addStep(logStep);

  return pipeline;
}

/**
 * 예제 2: 유창한 빌더 API 사용.
 *
 * PipelineBuilder를 사용한 우아한 구성.
 */
function exampleBuilderAPI() {
  const pipeline = PipelineBuilder.create('incident-response')
    .sequential()
      .step(authStep)
      .step(rateLimitStep)
      .step(routeStep)
    .end()
    .build();

  return pipeline;
}

/**
 * 예제 3: 조건부 라우팅 (Conditional).
 *
 * 메시지 심각도에 따라 다른 처리 경로.
 * 중요 메시지 → Ops 팀 알림 (병렬)
 * 일반 메시지 → 표준 처리
 */
function exampleConditionalPipeline() {
  const pipeline = PipelineBuilder.create('severity-router')
    .sequential()
      .step(authStep)
      .step(rateLimitStep)
      .step(routeStep)
    .end()
    .conditional(
      (ctx) => ctx.routing?.agent === 'code',
      'code-detection'
    )
      .whenTrue(
        // Code 관련 요청: 병렬로 코드 리뷰 + 문서화 실행
        PipelineBuilder.create('code-analysis')
          .fanout()
            .step(async (ctx) => ({
              ...ctx,
              codeAnalysis: { reviewed: true },
            }))
            .step(async (ctx) => ({
              ...ctx,
              documentation: { generated: true },
            }))
          .end()
          .build()
      )
      .whenFalse(
        // 일반 요청: 표준 처리
        async (ctx) => ({
          ...ctx,
          standardHandling: true,
        })
      )
    .end()
    .build();

  return pipeline;
}

/**
 * 예제 4: 병렬 처리 (Fanout).
 *
 * 알림, 로깅, 분석을 동시에 실행.
 */
function exampleFanoutPipeline() {
  const pipeline = PipelineBuilder.create('notification-dispatch')
    .fanout()
      .step(async (ctx) => ({
        ...ctx,
        slack: { notified: true },
      }))
      .step(async (ctx) => ({
        ...ctx,
        email: { sent: true },
      }))
      .step(async (ctx) => ({
        ...ctx,
        analytics: { tracked: true },
      }))
    .end()
    .build();

  return pipeline;
}

/**
 * 예제 5: 반복 처리 (Iterative).
 *
 * 재시도 로직이나 폴링 패턴에 사용.
 * 최대 3회까지 재시도, 성공 또는 모든 시도 소진까지 반복.
 */
function exampleIterativePipeline() {
  const pipeline = Pipeline.iterative('retry-pipeline')
    .setStep(async (ctx) => {
      // 재시도 스텝
      ctx.attempts = (ctx.attempts || 0) + 1;
      console.log(`재시도 시도: ${ctx.attempts}`);
      return ctx;
    })
    .setCondition((ctx) => {
      // 성공 또는 최대 시도 도달 시 종료
      return ctx.attempts >= 3 || ctx.success;
    })
    .setMaxIterations(3);

  return pipeline;
}

/**
 * 예제 6: 에이전트 체인 (AgentPipeline).
 *
 * Code Agent (작성) → Code Review Agent (리뷰) → Knowledge Agent (문서화)
 */
function exampleAgentChain() {
  const pipeline = Pipeline.agent('code-generation-chain')
    .addAgent('code-generator', async (ctx) => {
      // Code Agent: 코드 생성
      return {
        language: 'javascript',
        code: 'function hello() { console.log("Hello"); }',
        tokens: 150,
      };
    })
    .addAgent('code-reviewer', async (ctx) => {
      // Code Review Agent: 리뷰 및 피드백
      const code = ctx['code-generator']?.code;
      return {
        reviewed: true,
        issues: code ? [] : ['No code to review'],
        suggestions: ['Add JSDoc', 'Add error handling'],
      };
    })
    .addAgent('knowledge-documenter', async (ctx) => {
      // Knowledge Agent: 문서화
      return {
        documented: true,
        docUrl: '/docs/hello-function',
        exampleCode: 'hello();',
      };
    });

  return pipeline;
}

/**
 * 예제 7: 복잡한 중첩 파이프라인.
 *
 * 순차(인증) → 조건(타입 체크) → 병렬(처리) → 순차(저장)
 */
function exampleComplexNestedPipeline() {
  const pipeline = PipelineBuilder.create('complex-workflow')
    // 단계 1: 인증 및 검증
    .sequential('init')
      .step(authStep)
      .step(rateLimitStep)
    .end()
    // 단계 2: 타입에 따른 분기
    .conditional(
      (ctx) => ctx.routing?.agent === 'code',
      'type-check'
    )
      .whenTrue(
        // Code 요청: 병렬로 분석 + 실행
        PipelineBuilder.create('code-processing')
          .fanout()
            .step(async (ctx) => ({
              ...ctx,
              static_analysis: { done: true },
            }))
            .step(async (ctx) => ({
              ...ctx,
              execution: { done: true },
            }))
          .end()
          .build()
      )
      .whenFalse(
        // 기타 요청: 기본 처리
        async (ctx) => ({
          ...ctx,
          basic_handling: true,
        })
      )
    .end()
    // 단계 3: 저장 및 로깅
    .sequential('finalize')
      .step(memoryPersistStep)
      .step(logStep)
    .end()
    .build();

  return pipeline;
}

/**
 * 예제 8: 설정 기반 파이프라인 (YAML).
 *
 * effy.config.yaml에서 파이프라인 정의를 로드.
 */
function exampleConfigBasedPipeline() {
  const loader = new ConfigBasedPipelineLoader();

  // 스텝 등록
  loader.registerSteps({
    auth: authStep,
    rateLimit: rateLimitStep,
    route: routeStep,
    contextBuild: contextBuildStep,
    runtime: runtimeStep,
    memoryPersist: memoryPersistStep,
    log: logStep,
  });

  // YAML 설정 로드 (예)
  const yamlConfig = {
    default: {
      steps: ['auth', 'rateLimit', 'route', 'contextBuild', 'runtime', 'memoryPersist', 'log'],
    },
    incident: {
      steps: ['auth', 'route'],
      then: {
        conditional: {
          field: 'severity',
          critical: ['notifyOps', 'escalate'],
          default: ['standardResponse'],
        },
      },
    },
  };

  loader.loadFromConfig(yamlConfig);

  // 파이프라인 사용
  const defaultPipeline = loader.getPipeline('default');
  const incidentPipeline = loader.getPipeline('incident');

  return { defaultPipeline, incidentPipeline };
}

/**
 * 예제 9: 에러 처리 및 복구.
 *
 * 에러 발생 시 폴백 파이프라인 실행.
 */
function exampleErrorHandling() {
  return async (context) => {
    const mainPipeline = Pipeline.sequential('main-flow')
      .addStep(authStep)
      .addStep(routeStep)
      .addStep(runtimeStep);

    const fallbackPipeline = Pipeline.sequential('fallback-flow')
      .addStep(async (ctx) => ({
        ...ctx,
        fallback: true,
        message: 'Using fallback response',
      }));

    try {
      const result = await mainPipeline.execute(context);
      if (!result.success) {
        console.log('메인 파이프라인 실패, 폴백 실행:', result.error);
        return await fallbackPipeline.execute(context);
      }
      return result;
    } catch (err) {
      console.error('예외 발생, 폴백 실행:', err.message);
      return await fallbackPipeline.execute(context);
    }
  };
}

/**
 * 예제 10: 성능 모니터링 및 로깅.
 *
 * 파이프라인 실행 시간, 메모리 사용량 추적.
 */
function examplePerformanceMonitoring() {
  const pipeline = Pipeline.sequential('monitored-pipeline')
    .addStep(authStep)
    .addStep(rateLimitStep)
    .addStep(routeStep)
    .addStep(runtimeStep);

  return async (context) => {
    const result = await pipeline.execute(context);

    // 성능 메트릭 로깅
    console.log('=== Pipeline Performance ===');
    console.log(`이름: ${pipeline.name}`);
    console.log(`성공: ${result.success}`);
    console.log(`실행 시간: ${result.executionTime}ms`);
    console.log(`실행 단계:`);
    result.history.forEach((step, idx) => {
      console.log(`  ${idx + 1}. ${step.name}: ${step.status}`);
    });

    return result;
  };
}

/**
 * 예제 사용 방법.
 */
async function runExamples() {
  console.log('=== 파이프라인 예제 ===\n');

  // 예제 1: 기본 파이프라인
  console.log('예제 1: 기본 Sequential 파이프라인');
  const p1 = exampleBasicSequentialPipeline();
  console.log(`파이프라인: ${p1.name}, 스텝 수: ${p1.steps.length}\n`);

  // 예제 2: 빌더 API
  console.log('예제 2: PipelineBuilder API');
  const p2 = exampleBuilderAPI();
  console.log(`파이프라인: ${p2.name}\n`);

  // 예제 3: 조건부 라우팅
  console.log('예제 3: Conditional 파이프라인');
  const p3 = exampleConditionalPipeline();
  console.log(`파이프라인: ${p3.name}\n`);

  // 예제 4: 병렬 처리
  console.log('예제 4: Fanout 파이프라인');
  const p4 = exampleFanoutPipeline();
  console.log(`파이프라인: ${p4.name}\n`);

  // 예제 5: 반복 처리
  console.log('예제 5: Iterative 파이프라인');
  const p5 = exampleIterativePipeline();
  console.log(`파이프라인: ${p5.name}, 최대 반복: ${p5.maxIterations}\n`);

  // 예제 6: 에이전트 체인
  console.log('예제 6: Agent 체인');
  const p6 = exampleAgentChain();
  console.log(`파이프라인: ${p6.name}, 에이전트 수: ${p6.agents.length}\n`);

  // 예제 7: 복잡한 중첩
  console.log('예제 7: 복잡한 중첩 파이프라인');
  const p7 = exampleComplexNestedPipeline();
  console.log(`파이프라인: ${p7.name}\n`);

  // 예제 8: 설정 기반
  console.log('예제 8: 설정 기반 파이프라인');
  const p8config = exampleConfigBasedPipeline();
  console.log(`등록된 파이프라인: default, incident\n`);

  // 예제 실행 (비동기)
  console.log('예제 실행: 기본 파이프라인 테스트');
  const testContext = {
    sender: { id: 'user123', isBot: false },
    message: { content: { text: 'help with code' } },
    channel: { channelId: 'ch-abc' },
  };

  try {
    const result = await p1.execute(testContext);
    console.log(`결과: success=${result.success}, 실행시간=${result.executionTime}ms`);
    console.log(`히스토리: ${result.history.map((h) => h.name).join(' → ')}\n`);
  } catch (err) {
    console.error(`실행 오류: ${err.message}`);
  }
}

// 스크립트 직접 실행 시
if (require.main === module) {
  runExamples().catch(console.error);
}

module.exports = {
  exampleBasicSequentialPipeline,
  exampleBuilderAPI,
  exampleConditionalPipeline,
  exampleFanoutPipeline,
  exampleIterativePipeline,
  exampleAgentChain,
  exampleComplexNestedPipeline,
  exampleConfigBasedPipeline,
  exampleErrorHandling,
  examplePerformanceMonitoring,
  runExamples,
};
