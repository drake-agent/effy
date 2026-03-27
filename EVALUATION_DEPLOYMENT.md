# Effy 평가 프레임워크 - 배포 가이드

생성된 평가 프레임워크를 Effy 시스템에 배포하고 활성화하는 방법.

## 파일 배포 상태

```
✓ /tmp/effy-push/src/evaluation/
  ├── framework.js        (21KB) — 메인 엔진
  ├── metrics.js          (13KB) — 타입화 메트릭
  ├── collector.js        (12KB) — 자동 수집 및 훅
  ├── index.js            (3.9KB) — 공개 API
  ├── examples.js         (5.2KB) — 10개 사용 예제
  ├── README.md           — 사용 설명서
  ├── INTEGRATION.md      — 통합 가이드
  └── SUMMARY.md          — 기술 요약
```

**상태**: 모든 파일 생성 완료, 문법 검증 완료 ✓

## 1단계: 설정 추가

`effy.config.yaml`에 다음을 추가:

```yaml
evaluation:
  enabled: true
  sampleRate: 1.0              # 100% 수집
  retentionDays: 30             # 30일 보존
  benchmarks:
    dir: ./benchmarks
```

## 2단계: gateway.js에 통합

`src/gateway/gateway.js`의 `startGateway()` 함수에 추가:

```javascript
async function startGateway() {
  // ... 기존 코드 ...

  // 평가 프레임워크 초기화
  const evaluation = require('../evaluation');
  const collector = await evaluation.initialize();
  log.info('[gateway] Evaluation framework initialized');

  // Express 미들웨어 추가
  app.use(evaluation.middleware());

  // 평가 대시보드 API 마운트
  app.use('/api/evaluation', evaluation.getRouter());

  // ... 나머지 코드 ...
}
```

## 3단계: 런타임 통합 (선택사항)

자동 훅만으로도 충분하지만, 명시적 통합이 필요하면:

### agents/runtime.js (선택사항)

```javascript
// 파일 상단에 추가
const evaluation = require('../evaluation');

// runAgent 함수에서
async function runAgent(params) {
  const sessionId = params.sessionId || `session_${Date.now()}`;
  
  // 실행 시작
  const runId = evaluation.startRun(sessionId, {
    agentId: params.agentId,
    modelTier: params.modelTier || 'opus',
  });

  try {
    // ... 기존 에이전트 실행 코드 ...

    // 복잡도 평가
    const complexity = _classifyComplexity(params.input);
    evaluation.setComplexity(sessionId, complexity);

    // 완료
    await evaluation.completeRun(sessionId, { status: 'completed' });
  } catch (err) {
    await evaluation.completeRun(sessionId, { status: 'error' });
    throw err;
  }
}

function _classifyComplexity(input) {
  if (input.length < 50) return 1;
  if (input.includes('search') || input.includes('find')) return 2;
  return 3; // 기본값
}
```

## 4단계: 복잡도 분류 헬퍼 통합

`src/evaluation/examples.js`에서 `classifyComplexity` 함수를 참조하여 구현.

## 5단계: 벤치마크 테스트 케이스 생성

`benchmarks/test-1.json` 생성:

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
    "name": "Complex Search",
    "input": "Search for recent AI papers and summarize key findings",
    "expectedAgent": "opus",
    "expectedTokensLessThan": 5000,
    "expectedLatencyLessThanMs": 30000,
    "minSuccessRate": 0.95
  }
]
```

## 6단계: 대시보드 API 확인

서버 시작 후 다음 엔드포인트 테스트:

```bash
# 평가 시스템 상태
curl http://localhost:3100/api/evaluation/status

# 전역 메트릭
curl http://localhost:3100/api/evaluation/metrics/global?hours=24

# 최근 실행
curl http://localhost:3100/api/evaluation/runs?limit=10

# 벤치마크 실행
curl -X POST http://localhost:3100/api/evaluation/benchmark

# 실시간 스트림
curl http://localhost:3100/api/evaluation/stream
```

## 7단계: 모니터링 및 튜닝

### 로그 확인

```bash
LOG_LEVEL=debug node src/gateway/gateway.js
```

예상 로그:
```
[2024-01-01T12:00:00Z] [INFO ] [evaluation:collector] Telemetry collector initialized
[2024-01-01T12:00:01Z] [DEBUG] [evaluation:collector] Hooks installed
[2024-01-01T12:00:02Z] [DEBUG] [evaluation:collector] executeTool hook installed
```

### 성능 모니터링

```javascript
// 주기적으로 상태 확인
setInterval(() => {
  const status = require('./evaluation').getStatus();
  console.log('Active sessions:', status.framework.activeSessions);
}, 60000); // 1분마다
```

### DB 크기 모니터링

```bash
ls -lh data/effy.db
```

## 8단계: 대시보드 UI 구성 (선택사항)

`src/dashboard/pages/evaluation.html` 생성:

```html
<!DOCTYPE html>
<html>
<head>
  <title>Evaluation Metrics</title>
  <style>
    .metric-card { border: 1px solid #ddd; padding: 10px; margin: 10px; }
    .metric-value { font-size: 24px; font-weight: bold; }
    .metric-label { color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Evaluation Metrics</h1>
  
  <div id="global-metrics"></div>
  
  <script>
    async function loadMetrics() {
      const resp = await fetch('/api/evaluation/metrics/global?hours=24');
      const metrics = await resp.json();
      
      document.getElementById('global-metrics').innerHTML = `
        <div class="metric-card">
          <div class="metric-label">Average Latency</div>
          <div class="metric-value">${metrics.avgLatencyMs}ms</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Total Cost</div>
          <div class="metric-value">$${metrics.totalCostUsd.toFixed(4)}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Success Rate</div>
          <div class="metric-value">${metrics.successRate}%</div>
        </div>
      `;
    }
    
    loadMetrics();
    setInterval(loadMetrics, 60000); // 1분마다 갱신
  </script>
</body>
</html>
```

## 9단계: 성능 튜닝

### 샘플링 조정 (로드 감소)

```yaml
evaluation:
  sampleRate: 0.1  # 10%만 추적 (개발 환경)
```

### 데이터 보존 정책 조정

```yaml
evaluation:
  retentionDays: 7  # 7일만 유지 (용량 절약)
```

### 데이터 정리 수동 실행

```javascript
const evaluation = require('./evaluation');
await evaluation.cleanup(7); // 7일 이상 된 데이터 삭제
```

## 10단계: 문제 해결

### 메트릭이 기록되지 않음

1. 설정 확인:
```javascript
const status = require('./evaluation').getStatus();
console.log(status);
// expected: { enabled: true, initialized: true, tablePrepared: true }
```

2. DB 확인:
```bash
sqlite3 data/effy.db ".tables"
# 출력: evaluation_runs ...
```

3. 훅 확인:
```bash
LOG_LEVEL=debug node src/gateway/gateway.js 2>&1 | grep -i "hook\|collector"
```

### DB 오류

```javascript
const { getDb } = require('./db/sqlite');
const db = getDb();
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='evaluation_runs'"
).all();
console.log('evaluation_runs exists:', tables.length > 0);
```

### 성능 저하

1. 샘플링 조정:
```yaml
evaluation:
  sampleRate: 0.5  # 50%로 감소
```

2. 자동 정리 확인:
```bash
# 로그에서 정리 이벤트 확인
LOG_LEVEL=debug node src/gateway/gateway.js 2>&1 | grep -i cleanup
```

## 11단계: 검증 체크리스트

배포 전 다음을 확인:

- [ ] 모든 파일이 `/tmp/effy-push/src/evaluation/`에 있음
- [ ] `effy.config.yaml`에 `evaluation` 섹션 추가
- [ ] `gateway.js`에서 `evaluation.initialize()` 호출
- [ ] `/api/evaluation/status` 엔드포인트 응답
- [ ] 요청 처리 후 DB에 메트릭 저장됨
- [ ] `/api/evaluation/metrics/global` API 작동
- [ ] SSE 스트림 엔드포인트 작동
- [ ] 벤치마크 디렉토리 생성 및 테스트 케이스 배치

## 12단계: 프로덕션 배포

### 환경 변수

```bash
# .env
EVALUATION_ENABLED=true
EVALUATION_SAMPLE_RATE=1.0
EVALUATION_RETENTION_DAYS=30
BENCHMARKS_DIR=./benchmarks
```

### 권장 설정

**개발 환경:**
```yaml
evaluation:
  enabled: true
  sampleRate: 1.0
  retentionDays: 7
```

**스테이징 환경:**
```yaml
evaluation:
  enabled: true
  sampleRate: 0.5
  retentionDays: 14
```

**프로덕션 환경:**
```yaml
evaluation:
  enabled: true
  sampleRate: 0.1
  retentionDays: 30
```

### 모니터링 설정

- Cloudwatch/Datadog에서 `/api/evaluation/metrics/global` 폴링
- 메트릭 대시보드 구성
- 알림 설정 (cost > threshold, success_rate < 95%)

## 13단계: 성능 벤치마크

배포 후 성능 측정:

```javascript
const { performance } = require('perf_hooks');
const evaluation = require('./evaluation');

const start = performance.now();
await evaluation.getGlobalMetrics({ hours: 24 });
const duration = performance.now() - start;
console.log(`Query latency: ${duration}ms`);
// 예상: <100ms
```

## 다음 단계

1. **대시보드 UI 개발**: 메트릭 시각화
2. **알림 시스템**: 비정상 감지
3. **머신러닝 통합**: 복잡도 자동 분류
4. **비용 최적화**: 모델 선택 제안
5. **분산 추적**: 멀티 에이전트 추적

## 지원 문서

- `README.md` — 기본 사용법
- `INTEGRATION.md` — 상세 통합 가이드
- `examples.js` — 10개 사용 예제
- `SUMMARY.md` — 기술 사양

## 문의

코드 및 구조 관련 문의: `src/evaluation/` 디렉토리의 JSDoc 주석 참조
