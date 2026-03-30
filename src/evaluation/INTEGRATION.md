# 평가 프레임워크 통합 가이드

Effy 기존 시스템과 평가 프레임워크를 통합하는 방법을 설명합니다.

## 1. gateway/gateway.js 통합

게이트웨이 시작 시 평가 시스템을 초기화합니다.

```javascript
// src/gateway/gateway.js

const evaluation = require('../evaluation');

async function startGateway() {
  // ... 기존 초기화 코드 ...

  // 평가 시스템 초기화
  const collector = await evaluation.initialize();
  log.info('[gateway] Evaluation framework initialized');

  // Express 미들웨어 추가 (요청 추적)
  app.use(evaluation.middleware());

  // 평가 대시보드 API 마운트
  app.use('/api/evaluation', evaluation.getRouter());

  // ... 나머지 시작 코드 ...
}
```

## 2. agents/runtime.js 훅 (선택사항)

평가 시스템은 이미 `executeTool`을 자동으로 훅합니다.
명시적 통합이 필요한 경우:

```javascript
// src/agents/runtime.js

const evaluation = require('../evaluation');

async function executeTool(toolName, toolInput, ctx = {}) {
  const sessionId = ctx.messageContext?.threadId;

  // 기존 도구 실행 코드
  const result = await _executeToolImpl(toolName, toolInput, ctx);

  // (옵션) 명시적 기록
  if (sessionId) {
    evaluation.recordToolCall(sessionId, {
      name: toolName,
      latencyMs: result.latency || 0,
      success: !result.error,
    });
  }

  return result;
}
```

## 3. shared/llm-client.js 훅 (선택사항)

평가 시스템은 이미 `createMessage`를 자동으로 훅합니다.
명시적 통합이 필요한 경우:

```javascript
// src/shared/llm-client.js

const evaluation = require('../evaluation');

async function createMessage(params) {
  const sessionId = params.sessionId;
  const startTime = Date.now();

  const response = await anthropicClient.messages.create(params);

  const latencyMs = Date.now() - startTime;
  if (sessionId && response.usage) {
    evaluation.recordLLMCall(sessionId, {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      costUsd: _estimateCost(params.model, response.usage),
      latencyMs,
    });
  }

  return response;
}
```

## 4. 세션 컨텍스트 전달

`messageContext`에 세션 정보를 추가합니다.

```javascript
// src/agents/runtime.js::runAgent()

async function runAgent(params) {
  const sessionId = params.sessionId || `session_${Date.now()}`;

  // 평가 실행 시작
  const runId = evaluation.startRun(sessionId, {
    agentId: params.agentId,
    modelTier: params.modelTier || 'opus',
  });

  try {
    // ... 에이전트 실행 ...

    // 복잡도 평가 (선택사항)
    const complexity = _classifyComplexity(params.input);
    evaluation.setComplexity(sessionId, complexity);

    // 실행 완료
    await evaluation.completeRun(sessionId, { status: 'completed' });
  } catch (err) {
    await evaluation.completeRun(sessionId, { status: 'error' });
    throw err;
  }
}

function _classifyComplexity(input) {
  // 1: 간단 (단순 질문)
  // 2: 낮음 (검색 필요)
  // 3: 중간 (다단계 실행)
  // 4: 높음 (멀티 에이전트)
  // 5: 매우 높음 (복잡한 워크플로우)

  if (input.length < 50) return 1;
  if (input.includes('search') || input.includes('find')) return 2;
  if (input.split(' ').length > 30) return 3;
  return 3; // 기본값
}
```

## 5. 설정 추가

`effy.config.yaml`에 평가 섹션을 추가합니다.

```yaml
evaluation:
  enabled: true
  sampleRate: 1.0              # 1.0 = 100% (모든 요청 추적)
  retentionDays: 30             # 30일 이상 된 데이터 자동 삭제
  benchmarks:
    dir: ./benchmarks           # 벤치마크 테스트 케이스 디렉토리
```

## 6. DB 마이그레이션

기존 DB 초기화 시 evaluation_runs 테이블이 자동 생성됩니다.

```javascript
// src/db/sqlite.js::createTables()

function createTables(db) {
  // ... 기존 테이블들 ...

  // 평가 테이블은 프레임워크에서 자동으로 생성됨
  // 명시적 생성이 필요한 경우 _ensureTable() 참조
}
```

## 7. 대시보드 API 예제

### 전역 메트릭 조회

```bash
curl http://localhost:3100/api/evaluation/metrics/global?hours=24
```

응답:

```json
{
  "runCount": 150,
  "avgLatencyMs": 2500,
  "totalCostUsd": 0.45,
  "successRate": 98
}
```

### 에이전트별 메트릭

```bash
curl http://localhost:3100/api/evaluation/metrics/agent/agent-1?hours=24
```

### 최근 실행 조회

```bash
curl http://localhost:3100/api/evaluation/runs?limit=50&agentId=agent-1
```

### 벤치마크 실행

```bash
curl -X POST http://localhost:3100/api/evaluation/benchmark
```

## 8. 모니터링 대시보드 구성

dashboard 모듈에서 평가 데이터를 시각화합니다.

```javascript
// src/dashboard/api/metrics.js

router.get('/evaluation', async (req, res) => {
  const evaluation = require('../../evaluation');

  const [global, recentRuns] = await Promise.all([
    evaluation.getGlobalMetrics({ hours: 24 }),
    evaluation.getRecentRuns({ limit: 20 }),
  ]);

  return res.json({
    global,
    recentRuns,
    trends: {
      costTrend: _calculateTrend(global),
      latencyTrend: _calculateTrend(global),
    },
  });
});
```

## 9. 로깅 통합

평가 시스템의 로그는 자동으로 기존 로거와 통합됩니다.

```javascript
// src/shared/logger.js (기존)

// evaluation 모듈의 로그도 동일한 형식으로 출력됨:
// [2024-01-01T12:00:00Z] [INFO ] [evaluation] Framework initialized

// 로그 레벨 제어:
const { setLevel } = require('./logger');
setLevel('debug'); // evaluation의 debug 로그도 출력됨
```

## 10. 에러 처리

평가 시스템은 graceful degradation을 따릅니다.

```javascript
// 평가 시스템 오류 → 메인 요청 처리 계속

try {
  evaluation.recordToolCall(sessionId, { ... });
} catch (err) {
  // 로그만 기록, 요청 실패 없음
  log.error('[evaluation] Metric collection failed', { error: err.message });
}
```

## 11. 테스트

평가 프레임워크 테스트:

```javascript
// test/evaluation.test.js

describe('Evaluation Framework', () => {
  let evaluation;

  before(async () => {
    evaluation = await require('../src/evaluation').initialize();
  });

  it('should record and retrieve metrics', async () => {
    const sessionId = 'test-session';

    evaluation.recordToolCall(sessionId, {
      name: 'search',
      latencyMs: 100,
      success: true,
    });

    evaluation.recordLLMCall(sessionId, {
      inputTokens: 500,
      outputTokens: 200,
      costUsd: 0.003,
      latencyMs: 1200,
    });

    await evaluation.completeRun(sessionId, { status: 'completed' });

    const runs = await evaluation.getRecentRuns({ limit: 1 });
    expect(runs[0].latencyMs).to.be.greaterThan(0);
  });
});
```

## 12. 성능 튜닝

### 샘플링 조정

모든 요청을 추적하지 않으려면:

```yaml
evaluation:
  sampleRate: 0.1  # 10% 샘플링
```

### 데이터 보존 정책

```yaml
evaluation:
  retentionDays: 7  # 7일만 유지
```

### DB 정리 수동 실행

```javascript
const evaluation = require('./evaluation');
await evaluation.cleanup(7);  // 7일 이상 된 데이터 삭제
```

## 13. 문제 해결

### 메트릭이 기록되지 않음

1. 설정 확인:
   ```javascript
   const status = require('./evaluation').getStatus();
   console.log(status);
   ```

2. 훅 확인:
   ```bash
   LOG_LEVEL=debug node src/gateway/gateway.js
   ```

### DB 오류

1. DB 경로 확인:
   ```javascript
   const { config } = require('./config');
   console.log(config.db.sqlitePath);
   ```

2. 테이블 생성 확인:
   ```javascript
   const { getDb } = require('./db/sqlite');
   const db = getDb();
   const tables = db.prepare(
     "SELECT name FROM sqlite_master WHERE type='table'"
   ).all();
   console.log(tables);
   ```

## 참고 문헌

- `src/evaluation/README.md` — 기본 사용법
- `src/evaluation/framework.js` — 구현 상세
- `src/evaluation/metrics.js` — 메트릭 타입 정의
- `src/evaluation/collector.js` — 수집기 구현
