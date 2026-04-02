/**
 * pipeline-steps.js — 사전 구성된 파이프라인 스텝.
 *
 * Effy의 기존 미들웨어 및 프로세싱 로직을 래핑하여
 * 파이프라인 시스템과 호환 가능한 스텝으로 제공.
 *
 * 각 스텝: async (context) => context
 */

const { createLogger } = require('../shared/logger');
const { runMiddleware } = require('./middleware');
const { MessageCoalescer } = require('./coalescer');
const { classifyRequest } = require('./router');

const log = createLogger('pipeline-steps');

// ─── 공유 상태 (Singleton) ───
let rateLimiterInstance = null;
let coalescerInstance = null;

/**
 * RateLimiter 싱글톤 가져오기.
 * @returns {RateLimiter}
 */
function getRateLimiter() {
  if (!rateLimiterInstance) {
    const { RateLimiter } = require('./middleware');
    const { config } = require('../config');
    rateLimiterInstance = new RateLimiter(config.rateLimit?.maxPerMinute || 30);
  }
  return rateLimiterInstance;
}

/**
 * MessageCoalescer 싱글톤 가져오기.
 * @returns {MessageCoalescer}
 */
function getCoalescer() {
  if (!coalescerInstance) {
    coalescerInstance = new MessageCoalescer();
  }
  return coalescerInstance;
}

// ─── 파이프라인 스텝 구현 ───

/**
 * authStep — 인증 및 보안 검증.
 * 봇 메시지 필터링, 차단된 사용자 검사, 기타 보안 검사.
 *
 * @param {object} context - { sender, channel, message, ... }
 * @returns {Promise<object>} context
 */
const authStep = async (context) => {
  log.debug('authStep 실행');

  // 기존 middleware 활용
  const mw = runMiddleware({
    user: context.sender?.id,
    text: context.message?.content?.text,
    bot_id: context.sender?.isBot ? 'bot' : undefined,
  });

  if (!mw.pass) {
    const err = new Error(`Auth failed: ${mw.reason}`);
    err.reason = mw.reason;
    err.shouldNotify = mw.reason === 'rate_limited'; // rate limit 사용자에게 알림
    throw err;
  }

  return {
    ...context,
    traceId: mw.traceId,
    auth: { passed: true, reason: mw.reason },
  };
};

/**
 * rateLimitStep — 속도 제한 (이미 authStep에서 처리되지만 명시적 스텝).
 * 사용자별 슬라이딩 윈도우 기반 요청 제한.
 *
 * @param {object} context
 * @returns {Promise<object>} context
 */
const rateLimitStep = async (context) => {
  log.debug('rateLimitStep 실행');

  const limiter = getRateLimiter();
  const userId = context.sender?.id;

  if (!userId) {
    return context;
  }

  if (!limiter.check(userId)) {
    const err = new Error('Rate limit exceeded');
    err.reason = 'rate_limited';
    err.shouldNotify = true;
    throw err;
  }

  return {
    ...context,
    rateLimit: { allowed: true },
  };
};

/**
 * coalesceStep — 메시지 병합 (배치 처리).
 * 빠른 연속 메시지를 채널별로 묶어 처리.
 *
 * @param {object} context
 * @returns {Promise<object>} context
 */
const coalesceStep = async (context) => {
  log.debug('coalesceStep 실행');

  // NOTE: Coalescer는 비동기 타이머 기반이므로
  // 파이프라인 스텝으로 직접 통합하기 어려움.
  // 이 스텝은 상태 표시용 (실제 병합은 Gateway에서 수행).

  return {
    ...context,
    coalesce: { processed: true },
  };
};

/**
 * routeStep — 기능 라우팅.
 * 메시지 내용 기반 에이전트 유형 결정 (code/ops/knowledge/general).
 *
 * @param {object} context
 * @returns {Promise<object>} context
 */
const routeStep = async (context) => {
  log.debug('routeStep 실행');

  const classification = classifyRequest(context.message?.content?.text || '');

  return {
    ...context,
    routing: {
      agent: classification.agent,
      confidence: classification.confidence,
      keywords: classification.keywords,
    },
  };
};

/**
 * contextBuildStep — 컨텍스트 조립 (메모리 + 맥락).
 * 장기 메모리(L2+), 단기 메모리(L1), 엔티티 메모리(L4) 조합.
 * → Gateway의 "⑨ Context Assembler" 대응.
 *
 * @param {object} context
 * @returns {Promise<object>} context
 */
const contextBuildStep = async (context) => {
  log.debug('contextBuildStep 실행');

  // NOTE: 실제 메모리 로드는 Gateway에서 수행.
  // 이 스텝은 상태 표시 및 메모리 참조 문서화.

  return {
    ...context,
    contextBuilt: {
      memories: {
        l1: context.memory?.l1 || [], // 작업 메모리
        l2: context.memory?.l2 || [], // 에피소드 메모리
        l4: context.memory?.l4 || [], // 엔티티 메모리
      },
      assembled: true,
    },
  };
};

/**
 * runtimeStep — 에이전트 런타임 실행.
 * LLM 호출, 도구 실행, 응답 생성.
 * → Gateway의 "⑩ Agent Runtime (runAgent)" 대응.
 *
 * @param {object} context
 * @returns {Promise<object>} context
 */
const runtimeStep = async (context) => {
  log.debug('runtimeStep 실행');

  // NOTE: 실제 runAgent 호출은 Gateway/Builder에서 수행.
  // 여기서는 스텝 래핑만 제공.

  if (!context.runAgent) {
    throw new Error('runtimeStep requires context.runAgent function');
  }

  const result = await context.runAgent(context);

  return {
    ...context,
    runtime: {
      executed: true,
      modelUsed: result.model,
      tokensUsed: result.tokens,
    },
    agentResponse: result,
  };
};

/**
 * memoryPersistStep — 메모리 영속성.
 * L1 (작업 메모리) 업데이트, L2 (에피소드) 저장, L4 (엔티티) 동기화.
 * → Gateway의 "⑦ L2 저장" + "⑧ L4 업데이트" + "⑥ L1 터치" 통합.
 *
 * @param {object} context
 * @returns {Promise<object>} context
 */
const memoryPersistStep = async (context) => {
  log.debug('memoryPersistStep 실행');

  // NOTE: 실제 DB 저장은 Gateway에서 수행.
  // 이 스텝은 저장 마킹.

  return {
    ...context,
    memoryPersist: {
      l1Updated: true,
      l2Saved: true,
      l4Synced: true,
    },
  };
};

/**
 * logStep — 이벤트 로깅 및 추적.
 * RunLogger에 세션 기록, 추적 ID 관리.
 * → Gateway의 "⑪ L3 RunLogger 기록" 대응.
 *
 * @param {object} context
 * @returns {Promise<object>} context
 */
const logStep = async (context) => {
  log.debug('logStep 실행', { traceId: context.traceId });

  // NOTE: 실제 RunLogger 호출은 Gateway에서 수행.
  // 이 스텝은 로깅 마킹.

  return {
    ...context,
    logged: {
      traceId: context.traceId,
      timestamp: new Date().toISOString(),
      recorded: true,
    },
  };
};

/**
 * circuitBreakerStep — 회로 차단기 검사.
 * 에이전트/모델 장애 감지 및 우회.
 *
 * @param {object} context
 * @param {CircuitBreaker} circuitBreaker - 외부에서 주입
 * @returns {Promise<object>} context
 */
const circuitBreakerStep = (circuitBreaker) => {
  return async (context) => {
    log.debug('circuitBreakerStep 실행');

    if (!circuitBreaker) {
      throw new Error('circuitBreakerStep requires circuitBreaker instance');
    }

    const agentType = context.routing?.agent || 'general';
    const state = circuitBreaker.getState(agentType);

    if (state === 'open') {
      const err = new Error(`Circuit breaker open for agent: ${agentType}`);
      err.circuitOpen = true;
      throw err;
    }

    return {
      ...context,
      circuitBreaker: { state, agent: agentType },
    };
  };
};

/**
 * modelRouterStep — 모델 라우팅 (5단계 의사결정).
 * 요청 복잡도, 비용, 성능에 따라 모델 선택.
 * → Gateway의 "③.5 ModelRouter" 대응.
 *
 * @param {object} context
 * @param {ModelRouter} modelRouter - 외부에서 주입
 * @returns {Promise<object>} context
 */
const modelRouterStep = (modelRouter) => {
  return async (context) => {
    log.debug('modelRouterStep 실행');

    if (!modelRouter) {
      throw new Error('modelRouterStep requires modelRouter instance');
    }

    const selectedModel = modelRouter.route(context);

    return {
      ...context,
      modelRouter: { selectedModel },
    };
  };
};

/**
 * budgetGateStep — 비용 게이트.
 * 일일/월간 토큰 예산 검사, 모델 조정.
 * → Gateway의 "⑨.7 BudgetGate" 대응.
 *
 * @param {object} context
 * @param {BudgetGate} budgetGate - 외부에서 주입
 * @returns {Promise<object>} context
 */
const budgetGateStep = (budgetGate) => {
  return async (context) => {
    log.debug('budgetGateStep 실행');

    if (!budgetGate) {
      throw new Error('budgetGateStep requires budgetGate instance');
    }

    const gateCheck = budgetGate.canProceed();
    if (!gateCheck) {
      const err = new Error('Budget limit exceeded');
      err.budgetExceeded = true;
      throw err;
    }

    return {
      ...context,
      budgetGate: { passed: true },
    };
  };
};

/**
 * concurrencyStep — 동시성 제어.
 * 활성 요청 수, 세션 풀 크기 관리.
 * → Gateway의 "④.5 동시성 체크" 대응.
 *
 * @param {object} context
 * @param {ConcurrencyGovernor} governor - 외부에서 주입
 * @returns {Promise<object>} context
 */
const concurrencyStep = (governor) => {
  return async (context) => {
    log.debug('concurrencyStep 실행');

    if (!governor) {
      throw new Error('concurrencyStep requires ConcurrencyGovernor instance');
    }

    const userId = context.sender?.id;
    const sessionId = context.sessionId;

    if (!governor.acquire(userId)) {
      const err = new Error('Concurrency limit exceeded');
      err.concurrencyExceeded = true;
      throw err;
    }

    return {
      ...context,
      concurrency: { acquired: true },
      _release: () => governor.release(userId), // 정리 함수
    };
  };
};

/**
 * reflectionStep — 자기 개선 (Reflection).
 * 교정 감지, 학습된 교훈 적용, Outcome 추적.
 * → Gateway의 "⑥.9 Reflection" 대응.
 *
 * @param {object} context
 * @param {object} reflection - { detectCorrection, getOutcomeTracker, ... }
 * @returns {Promise<object>} context
 */
const reflectionStep = (reflection) => {
  return async (context) => {
    log.debug('reflectionStep 실행');

    if (!reflection) {
      throw new Error('reflectionStep requires reflection instance');
    }

    // NOTE: 실제 감지 로직은 외부에서 수행.
    // 이 스텝은 반사 상태 마킹.

    return {
      ...context,
      reflection: {
        processed: true,
      },
    };
  };
};

/**
 * 표준 Effy 파이프라인 구성요소 export.
 */
module.exports = {
  // 기본 스텝 (설정 불필요)
  authStep,
  rateLimitStep,
  coalesceStep,
  routeStep,
  contextBuildStep,
  runtimeStep,
  memoryPersistStep,
  logStep,

  // 팩토리 함수 (외부 의존성 주입)
  circuitBreakerStep,
  modelRouterStep,
  budgetGateStep,
  concurrencyStep,
  reflectionStep,

  // 유틸리티
  getRateLimiter,
  getCoalescer,
};
