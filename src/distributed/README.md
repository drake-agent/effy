# Effy Phase 2: Distributed Architecture

Effy Phase 2는 단일 프로세스를 넘어 확장 가능한 분산 아키텍처를 제공합니다. 각 에이전트를 독립적인 마이크로서비스로 운영할 수 있습니다.

## 개요

### 아키텍처 컴포넌트

```
┌─────────────────────────────────────────────────────┐
│          Effy Gateway (HTTP Entry Point)             │
├─────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Agent Svc 1  │  │ Agent Svc 2  │  │Agent Svc N │ │
│  │ (Express)    │  │ (Express)    │  │(Express)   │ │
│  └──────────────┘  └──────────────┘  └────────────┘ │
├─────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────┐ │
│  │    Message Bus (Local | Redis)                  │ │
│  │  Request-Reply + Broadcast + Event Publishing  │ │
│  └─────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────┐ │
│  │   Session Store (Local Map | Redis)            │ │
│  │   TTL-based distributed session management     │ │
│  └─────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────┐ │
│  │   Service Discovery (Static | Kubernetes)       │ │
│  │   Health Monitoring + Circuit Breaker          │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### 모드별 동작

#### 1. **Local Mode** (기본값, Phase 1 호환)
- 모든 컴포넌트가 프로세스 내 실행
- 메모리 기반 메시지 버스 (직접 함수 호출)
- Node.js Map 기반 세션 저장
- 0번 거버넌스 변동
- **설정**: `distributed.enabled: false` (기본값)

#### 2. **Redis Mode** (확장성)
- Redis Pub/Sub 기반 메시지 버스
- Redis 기반 세션 저장 (TTL 자동)
- 여러 호스트에서 에이전트 독립 실행 가능
- 부하 분산 가능
- **설정**: `distributed.mode: redis`, `redis.url: ...`

#### 3. **Kubernetes Mode** (프로덕션)
- K8s DNS 기반 자동 서비스 발견
- 동적 Pod 스케일링 대응
- 헬스 체크 + Circuit Breaker
- **설정**: `distributed.mode: kubernetes`, `kubernetes.namespace: effy`

## 모듈 설명

### 1. `agent-service.js` — Agent-as-a-Service

각 에이전트를 HTTP 마이크로서비스로 노출.

**엔드포인트:**
- `GET /health` — 헬스 체크
- `GET /metrics` — Prometheus 메트릭
- `GET /info` — 에이전트 정보
- `POST /execute` — 도구 호출 실행
- `POST /chat` — 메시지 처리
- `GET /session/:sessionId` — 세션 조회

**예시:**
```javascript
const { AgentService } = require('./agent-service');

const service = new AgentService(agentInstance, 3101, {
  sessionStore: sessionStore,
  messageBus: messageBus,
  mode: 'local',
});

await service.start();
// GET http://localhost:3101/health
// POST http://localhost:3101/chat { message, sessionId }
```

**메트릭:**
- `requests`: 총 요청 수
- `errors`: 에러 수
- `avgResponseTimeMs`: 평균 응답 시간
- `health`: up/down 상태

### 2. `message-bus.js` — Inter-Agent Message Bus

에이전트 간 통신 추상화.

**메시지 형식:**
```javascript
{
  from: 'general',           // 발신 에이전트
  to: 'code',                // 수신 에이전트 (또는 '*' 브로드캐스트)
  type: 'request',           // request|response|event|broadcast
  payload: {...},            // 메시지 데이터
  correlationId: 'abc123',   // 요청-응답 상관관계
  timestamp: 1234567890,     // ISO timestamp
}
```

**사용 패턴:**

```javascript
const { createMessageBus } = require('./message-bus');

// 생성
const messageBus = createMessageBus({ mode: 'local' });

// 핸들러 등록
messageBus.register('general', async (message) => {
  console.log(`Received: ${message.type} from ${message.from}`);
  return { success: true, result: '...' };
});

// 요청-응답
const response = await messageBus.request(
  'code',
  'general',
  'analyze',
  { code: '...' }
);

// 이벤트 발행 (응답 없음)
await messageBus.publish('code', 'general', 'tool_executed', { tool: 'test' });

// 브로드캐스트 (모든 에이전트)
await messageBus.publish('general', '*', 'system_event', { event: 'reload' });
```

**LocalMessageBus:**
- 직접 함수 호출 (지연 없음)
- 프로세스 메모리 기반
- 기본값

**RedisMessageBus:**
- Redis Pub/Sub (분산)
- 요청 타임아웃: 30초 (설정 가능)
- 장애 복구 자동

### 3. `session-store.js` — Distributed Session Storage

세션 상태 공유 저장소.

**사용 패턴:**

```javascript
const { createSessionStore } = require('./session-store');

// 생성
const store = createSessionStore({
  mode: 'local',
  defaultTtlMs: 86400000, // 24시간
});

// 세션 저장
await store.set('session-123', {
  userId: 'user@example.com',
  messages: [...],
  memory: {...},
}, 3600000); // 1시간 TTL

// 세션 로드
const session = await store.get('session-123');

// 세션 마이그레이션 (에이전트 간 이동)
await store.migrateSession(
  'session-123',
  'general',   // 출발 에이전트
  'code'       // 목표 에이전트
);

// 통계
const stats = await store.stats();
// { mode: 'local', totalSessions: 42, activeSessions: 35 }
```

**LocalSessionStore:**
- Node.js Map 기반
- TTL 자동 정리 (5분 간격)
- 프로세스 재시작 시 손실

**RedisSessionStore:**
- Redis SETEX (자동 TTL)
- 분산 공유
- 영속성

### 4. `discovery.js` — Service Discovery

에이전트 위치 관리 및 헬스 모니터링.

**사용 패턴:**

```javascript
const { createServiceDiscovery } = require('./discovery');

// 생성 (Static)
const discovery = createServiceDiscovery({
  mode: 'static',
  agents: {
    general: { host: 'localhost', port: 3101, replicas: 2 },
    code: { host: 'localhost', port: 3102, replicas: 1 },
  },
});

// 에이전트 주소 확인
const addr = discovery.resolveAgent('general');
// { host: 'localhost', port: 3101, url: 'http://localhost:3101' }

// 헬스 상태
const health = discovery.getHealthStatus('general');
// { status: 'up', lastCheck: ..., circuitState: 'CLOSED' }

// 모든 에이전트 조회
const agents = discovery.listAgents();
// [{ id: 'general-0', host: '...', port: 3101, status: 'up' }, ...]
```

**Circuit Breaker:**
```
CLOSED ─(3회 실패)→ OPEN ─(30초 쿨다운)→ HALF_OPEN ─(2회 성공)→ CLOSED
```

**StaticServiceDiscovery:**
- 설정 파일 기반
- 복제본 지원 (round-robin)
- 헬스 체크 30초 간격

**KubernetesServiceDiscovery:**
- K8s DNS: `{agentId}-agent.{namespace}.svc.cluster.local:{port}`
- 자동 발견
- Pod 동적 확장 대응

## 설정 예시

### Phase 1 (기본값, 호환)
```yaml
distributed:
  enabled: false  # 분산 비활성화, 현재 동작 유지
```

### Phase 2 Local
```yaml
distributed:
  enabled: true
  mode: local    # 프로세스 내 메모리 기반
  agents:
    general:
      host: localhost
      port: 3101
      replicas: 2
```

### Phase 2 Redis
```yaml
distributed:
  enabled: true
  mode: redis
  redis:
    url: redis://localhost:6379
    prefix: effy:
  agents:
    general: { host: redis-agent-1.local, port: 3101, replicas: 1 }
    code: { host: redis-agent-2.local, port: 3102, replicas: 1 }
```

### Phase 2 Kubernetes
```yaml
distributed:
  enabled: true
  mode: kubernetes
  kubernetes:
    namespace: effy
    domain: svc.cluster.local
  agents:
    general: { port: 3101, replicas: 3 }
    code: { port: 3102, replicas: 2 }
    ops: { port: 3103, replicas: 1 }
```

## 통합 (Gateway 부팅)

```javascript
// src/app.js
const {
  getDistributedArchitecture,
  initDistributedArchitecture,
} = require('./distributed');

// 부팅 중
const distConfig = config.distributed || { enabled: false };
const distributed = await initDistributedArchitecture(
  distConfig,
  { redis: redisClient, gateway: gateway }
);

// 각 에이전트 마이크로서비스 생성
if (distributed.enabled) {
  for (const agent of agents) {
    const port = 3101 + agents.indexOf(agent);
    await distributed.createAgentService(agent, port);
  }
}

// Graceful shutdown
await distributed.shutdown();
```

## 마이그레이션 경로

### Phase 1 → Phase 2

1. **step 1:** `distributed.enabled: false` 유지 (기본값)
   - 100% 호환성
   - 0번 변동

2. **step 2:** `distributed.enabled: true`, `mode: local` 설정
   - 분산 추상화 활용
   - 프로세스 내 동작 (메모리 기반)
   - 테스트용

3. **step 3:** Redis 배포
   ```bash
   docker run -d -p 6379:6379 redis:latest
   ```
   설정: `mode: redis`, `redis.url: redis://localhost:6379`

4. **step 4:** 에이전트 분리
   ```bash
   # 각 에이전트별 독립 프로세스
   node agent-service.js --agent=general --port=3101
   node agent-service.js --agent=code --port=3102
   ```

5. **step 5:** Kubernetes 배포
   ```yaml
   # effy-agent-deployment.yaml
   apiVersion: apps/v1
   kind: Deployment
   metadata:
     name: effy-general-agent
   spec:
     replicas: 3
     containers:
     - name: agent
       env:
       - name: AGENT_ID
         value: general
       - name: REDIS_URL
         value: redis://effy-redis:6379
   ```

## 성능 특성

| 모드 | 레이턴시 | 처리량 | 확장성 | 메모리 |
|------|---------|--------|--------|--------|
| Local | 0-1ms | 매우 높음 | 단일 프로세스 | 낮음 |
| Redis | 5-10ms | 높음 | 수평 확장 가능 | 중간 |
| Kubernetes | 10-20ms | 중간-높음 | 자동 스케일링 | 높음 |

## 모니터링

```javascript
// 분산 아키텍처 상태
const status = await distributed.getStatus();
console.log(status);
// {
//   enabled: true,
//   mode: 'redis',
//   components: {
//     messageBus: 'redis',
//     sessionStore: 'redis',
//     discovery: 'static'
//   },
//   services: [
//     { agentId: 'general', running: true, metrics: {...} }
//   ],
//   agents: [
//     { id: 'general', host: 'localhost', port: 3101, status: 'up' }
//   ]
// }
```

## 문제 해결

### Redis 연결 실패
```
Error: connect ECONNREFUSED 127.0.0.1:6379
```
→ Redis 서버 실행 확인: `redis-cli ping`

### Circuit Breaker 열림
```
Agent circuit open, not attempting: general
```
→ 에이전트 헬스 확인: `GET http://localhost:3101/health`

### 세션 마이그레이션 실패
```
Session not found for migration: session-123
```
→ 세션 TTL 만료 확인 또는 원본 에이전트 확인

## 다음 단계

- [ ] Redis 자동 페일오버 (Sentinel)
- [ ] 부하 분산기 (nginx, Envoy)
- [ ] 분산 추적 (Jaeger)
- [ ] 메트릭 대시보드 (Prometheus + Grafana)
- [ ] 자동 스케일링 (K8s HPA)
