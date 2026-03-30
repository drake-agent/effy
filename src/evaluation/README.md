# Evaluation Framework

Effy의 평가 시스템. 에이전트 응답 품질을 체계적으로 측정합니다.

## 개요

평가 프레임워크는 다음을 측정합니다:

- **응답 지연시간 (Latency)**: 요청 ~ 응답 총 소요시간 (ms)
- **토큰 사용량**: 입력/출력 토큰 수
- **비용**: 예상 API 호출 비용 (USD)
- **도구 호출 효율성**: 도구 성공률, 호출 횟수, 오버헤드
- **복잡도 분류**: 1~5 범위의 요청 복잡도
- **정확도**: 기대 결과 vs 실제 결과
- **관련성**: 응답의 쿼리 관련성 (0~1)

## 구조

```
src/evaluation/
├── framework.js      # 메인 평가 엔진
├── metrics.js        # 타입화된 메트릭 정의
├── collector.js      # 자동 수집 및 런타임 훅
├── index.js          # 공개 API 내보내기
└── README.md         # 이 문서
```

### framework.js

**EvaluationFramework 클래스**

메인 엔진. SQLite에 메트릭을 저장하고 집계 쿼리를 제공합니다.

핵심 API:

```javascript
const framework = require('./framework').getInstance();

// 세션 시작
const runId = framework.startRun(sessionId, {
  agentId: 'agent-1',
  modelTier: 'opus',
});

// 도구 호출 기록
framework.recordToolCall(sessionId, {
  name: 'search',
  latencyMs: 100,
  success: true,
  metadata: { query: '...' },
});

// LLM 호출 기록
framework.recordLLMCall(sessionId, {
  inputTokens: 500,
  outputTokens: 200,
  costUsd: 0.003,
  latencyMs: 1200,
});

// 세션 완료
await framework.completeRun(sessionId, { status: 'completed' });

// 메트릭 조회
const metrics = await framework.getGlobalMetrics({ hours: 24 });
```

### metrics.js

**타입화된 메트릭**

모든 메트릭은 카테고리별로 정의됩니다:

```javascript
const { MetricFactory } = require('./metrics');

// 정확도 메트릭
const accuracy = MetricFactory.accuracy(0.95, {
  expected: 'agent-a',
  actual: 'agent-a',
});

// 지연시간 메트릭
const latency = MetricFactory.latency(1500, {
  llmMs: 1000,
  toolMs: 500,
  otherMs: 0,
});

// 비용 메트릭
const cost = MetricFactory.cost(0.003, {
  llmCost: 0.0025,
  toolCost: 0.0005,
});

// 도구 효율성
const toolEff = MetricFactory.toolEfficiency({
  callCount: 3,
  successCount: 3,
  totalLatencyMs: 300,
  avgCallLatencyMs: 100,
  toolsUsed: ['search', 'summarize'],
});

// 복잡도
const complexity = MetricFactory.complexity(3, {
  factors: ['multi_agent', 'multi_step'],
});
```

### collector.js

**자동 수집 및 런타임 훅**

런타임 모듈과 연동하여 자동으로 메트릭을 수집합니다.

```javascript
const collector = require('./collector').getInstance();
await collector.initialize();

// Express 미들웨어로 마운트
app.use(collector.middleware());

// 평가 대시보드 API
app.use('/evaluation', collector.getRouter());
```

## 사용법

### 1. 초기화

```javascript
// app.js 또는 gateway.js에서
const evaluation = require('./evaluation');
await evaluation.initialize();
```

### 2. Express 통합

```javascript
// 미들웨어 추가
app.use(evaluation.middleware());

// 평가 대시보드 API 마운트
app.use('/api/evaluation', evaluation.getRouter());
```

### 3. 런타임에서 메트릭 기록

```javascript
// executeTool 호출 시
evaluation.recordToolCall(sessionId, {
  name: 'search',
  latencyMs: 150,
  success: true,
});

// createMessage 호출 시
evaluation.recordLLMCall(sessionId, {
  inputTokens: 500,
  outputTokens: 200,
  costUsd: 0.003,
  latencyMs: 1200,
});
```

### 4. 메트릭 조회

```javascript
// 전역 메트릭 (최근 24시간)
const globalMetrics = await evaluation.getGlobalMetrics({ hours: 24 });

// 에이전트별 메트릭
const agentMetrics = await evaluation.getAgentMetrics('agent-1', { hours: 24 });

// 모델별 메트릭
const modelMetrics = await evaluation.getModelMetrics('opus', { hours: 24 });

// 최근 실행 목록
const runs = await evaluation.getRecentRuns({ limit: 50 });
```

### 5. 벤치마크 실행

벤치마크 디렉토리에 JSON 테스트 케이스를 배치하고 실행합니다.

벤치마크 파일 형식 (`./benchmarks/test-1.json`):

```json
[
  {
    "name": "Simple Query",
    "input": "What is 2+2?",
    "expectedAgent": "haiku",
    "expectedTokensLessThan": 200,
    "expectedLatencyLessThanMs": 5000,
    "minSuccessRate": 0.99
  },
  {
    "name": "Complex Multi-step",
    "input": "Search for recent AI papers and summarize",
    "expectedAgent": "opus",
    "expectedTokensLessThan": 5000,
    "expectedLatencyLessThanMs": 30000,
    "minSuccessRate": 0.95
  }
]
```

실행:

```javascript
const result = await evaluation.runBenchmark();
console.log(result.summary); // { total: 2, passed: 2, failed: 0, passRate: '100%' }
```

## DB 스키마

```sql
CREATE TABLE evaluation_runs (
  runId TEXT PRIMARY KEY,              -- 각 실행의 고유 ID
  agentId TEXT NOT NULL,               -- 에이전트 식별자
  modelTier TEXT NOT NULL,             -- 사용된 모델 (haiku, sonnet, opus)
  totalTokensIn INTEGER,               -- 입력 토큰
  totalTokensOut INTEGER,              -- 출력 토큰
  costUsd REAL,                        -- 추정 비용 (USD)
  latencyMs INTEGER,                   -- 총 지연시간 (ms)
  toolCallCount INTEGER,               -- 도구 호출 횟수
  toolSuccessCount INTEGER,            -- 성공한 도구 호출 횟수
  complexityScore INTEGER,             -- 1~5 복잡도
  status TEXT,                         -- 'pending', 'completed', 'error', 'timeout'
  createdAt TEXT,                      -- 시작 시간 (ISO 8601)
  completedAt TEXT,                    -- 완료 시간
  metadata TEXT                        -- JSON 추가 데이터
);

CREATE INDEX idx_eval_agent ON evaluation_runs(agentId, createdAt DESC);
CREATE INDEX idx_eval_model ON evaluation_runs(modelTier, createdAt DESC);
CREATE INDEX idx_eval_status ON evaluation_runs(status);
```

## 설정

`effy.config.yaml`:

```yaml
evaluation:
  enabled: true                    # 평가 시스템 활성화
  sampleRate: 1.0                  # 샘플링 비율 (1.0 = 100%)
  retentionDays: 30                # 데이터 보존 기간 (일)
  benchmarks:
    dir: ./benchmarks              # 벤치마크 테스트 케이스 디렉토리
```

## API 엔드포인트

### `GET /api/evaluation/status`

수집기 상태 조회.

```json
{
  "enabled": true,
  "initialized": true,
  "tablePrepared": true,
  "activeSessions": 5,
  "sampleRate": 1.0,
  "retentionDays": 30
}
```

### `GET /api/evaluation/metrics/global?hours=24`

전역 메트릭.

```json
{
  "runCount": 150,
  "agentCount": 3,
  "modelCount": 3,
  "avgLatencyMs": 2500,
  "maxLatencyMs": 15000,
  "minLatencyMs": 500,
  "avgTokensIn": 800,
  "avgTokensOut": 300,
  "totalCostUsd": 0.45,
  "avgToolCallCount": 2,
  "successRate": 98,
  "avgComplexity": 2.5
}
```

### `GET /api/evaluation/metrics/agent/:agentId?hours=24`

에이전트별 메트릭.

### `GET /api/evaluation/metrics/model/:modelTier?hours=24`

모델별 메트릭.

### `GET /api/evaluation/runs?limit=50&agentId=agent-1&status=completed`

최근 실행 조회.

```json
[
  {
    "runId": "run_1704067200000_abc1234",
    "agentId": "agent-1",
    "modelTier": "opus",
    "totalTokensIn": 500,
    "totalTokensOut": 200,
    "costUsd": 0.003,
    "latencyMs": 1500,
    "toolCallCount": 2,
    "toolSuccessCount": 2,
    "complexityScore": 3,
    "status": "completed",
    "createdAt": "2024-01-01T12:00:00Z",
    "completedAt": "2024-01-01T12:00:02Z"
  }
]
```

### `POST /api/evaluation/benchmark`

벤치마크 실행.

### `GET /api/evaluation/stream`

SSE 메트릭 스트림 (실시간).

```
data: {"type":"global","data":{...}}

data: {"type":"recent","data":[...]}
```

## 성능 고려사항

- **샘플링**: `sampleRate`을 조정하여 오버헤드 제어 (기본값: 1.0 = 100%)
- **DB 정리**: 자동으로 24시간마다 실행 (retention policy)
- **메모리**: 활성 세션만 메모리에 유지 (완료 후 즉시 DB 저장)

## 에러 처리

프레임워크는 graceful degradation을 따릅니다:

- DB 오류 → 경고 로그, 계속 진행
- 훅 설치 실패 → 경고 로그, 계속 진행
- 메트릭 수집 실패 → 로그, 요청은 계속 처리

평가 시스템 장애가 메인 시스템을 중단하지 않습니다.

## 예제

### 완전한 사용 예제

```javascript
// 1. 초기화
const evaluation = require('./evaluation');
await evaluation.initialize();

// 2. Express 앱에 통합
app.use(evaluation.middleware());
app.use('/api/evaluation', evaluation.getRouter());

// 3. 런타임 에서 메트릭 기록 (자동화됨)
// → framework.js의 훅이 자동으로 수집

// 4. 메트릭 조회
app.get('/my-metrics', async (req, res) => {
  const metrics = await evaluation.getGlobalMetrics({ hours: 24 });
  res.json({
    success: metrics.successRate,
    avgLatency: metrics.avgLatencyMs,
    costUsd: metrics.totalCostUsd,
  });
});

// 5. 벤치마크 실행
app.post('/run-benchmark', async (req, res) => {
  const result = await evaluation.runBenchmark();
  res.json(result);
});
```

## 추가 리소스

- `framework.js` — 메인 엔진 구현
- `metrics.js` — 메트릭 타입 정의
- `collector.js` — 런타임 훅 및 Express 통합
