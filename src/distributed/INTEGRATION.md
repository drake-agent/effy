# Effy Phase 2 Integration Guide

빠른 시작 및 Gateway 통합 가이드.

## Phase 1 상태 유지 (기본값)

기존 동작을 100% 유지하려면 아무것도 변경하지 마세요.

```yaml
# effy.config.yaml
distributed:
  enabled: false  # 기본값 — Phase 1 동작 그대로
```

## Phase 2 로컬 테스트

프로세스 내에서 분산 아키텍처 추상화를 테스트합니다.

### 1. 설정 변경

```yaml
# effy.config.yaml
distributed:
  enabled: true
  mode: local  # 프로세스 내, 메모리 기반
  discovery:
    mode: static
  agents:
    general:
      host: localhost
      port: 3101
      replicas: 1
```

### 2. Gateway 부팅 시 초기화

```javascript
// src/app.js (기존 코드 후, 4번 단계 후)

const { initDistributedArchitecture } = require('./distributed');

// Graceful shutdown 전
(async () => {
  try {
    // ... 기존 부팅 단계 ...

    // Phase 2: 분산 아키텍처 초기화
    const distConfig = config.distributed || { enabled: false };
    let distributed = null;

    if (distConfig.enabled) {
      distributed = await initDistributedArchitecture(distConfig, {
        redis: null,  // local 모드에서는 불필요
        agentId: 'gateway',
      });
      log.info(`DistributedArchitecture initialized: ${distributed.mode}`);
    }

    // ... 기존 채널 어댑터, 웹훅, 대시보드 ...

    // 6. 상태 출력 전 분산 아키텍처 정보 추가
    if (distributed?.enabled) {
      const distStatus = await distributed.getStatus();
      console.log(`  ─── Phase 2 Distributed ───`);
      console.log(`  Mode:       ${distStatus.mode}`);
      console.log(`  Components: MessageBus(${distStatus.components.messageBus}), SessionStore(${distStatus.components.sessionStore}), Discovery(${distStatus.components.discovery})`);
    }

    // Graceful shutdown에서 distributed 정리
    // SF-3: 상단에서 let distributed_ref = null; 선언 필요
  } catch (err) {
    log.error(`Fatal error: ${err.message}`);
    process.exit(1);
  }
})();

// SF-3: Graceful shutdown
async function gracefulShutdown(signal) {
  log.info(`${signal} received, shutting down...`);

  // ... 기존 shutdown 단계 ...

  // Phase 2 정리
  if (distributed_ref) {
    try {
      await distributed_ref.shutdown();
    } catch (err) {
      log.warn(`Error shutting down distributed: ${err.message}`);
    }
  }

  // ... 나머지 정리 ...
}
```

### 3. 모듈 검증

```bash
# 분산 모듈 로드 테스트
node -e "const d = require('./src/distributed'); console.log('OK', Object.keys(d).length, 'exports')"
```

예상 출력:
```
OK 12 exports
```

## Phase 2 Redis 배포

확장 가능한 분산 처리를 위해 Redis를 사용합니다.

### 1. Redis 설치

```bash
# Docker
docker run -d -p 6379:6379 --name effy-redis redis:latest

# 또는 로컬 설치
brew install redis  # macOS
# apt-get install redis-server  # Ubuntu
redis-server
```

### 2. 설정 변경

```yaml
# effy.config.yaml
distributed:
  enabled: true
  mode: redis  # Redis 기반 분산

  redis:
    url: redis://localhost:6379
    prefix: effy:

  sessionStore:
    defaultTtlMs: 86400000  # 24시간

  agents:
    general:
      host: localhost
      port: 3101
      replicas: 1
    code:
      host: localhost
      port: 3102
      replicas: 1
```

### 3. Redis 클라이언트 준비

```javascript
// src/app.js
const redis = require('redis');

(async () => {
  // Redis 클라이언트 생성
  const redisClient = redis.createClient({
    url: config.distributed?.redis?.url || 'redis://localhost:6379'
  });

  redisClient.on('error', (err) => log.error('Redis error: ' + err));
  await redisClient.connect();

  log.info('Redis connected');

  // Phase 2 초기화 시 redis 전달
  if (distConfig.enabled) {
    distributed = await initDistributedArchitecture(distConfig, {
      redis: redisClient,
      agentId: 'gateway',
    });
  }

  // Graceful shutdown
  // ...
  await redisClient.quit();
})();
```

## Phase 2 마이크로서비스 배포

각 에이전트를 독립 프로세스로 실행합니다.

### 1. 에이전트 서비스 진입점 (agent-bootstrap.js)

```javascript
/**
 * agent-bootstrap.js — 독립 에이전트 마이크로서비스 부트스트래퍼.
 *
 * 사용:
 *   node agent-bootstrap.js --agent=general --port=3101 --redis=redis://localhost:6379
 */

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const redis = require('redis');
const { Gateway } = require('./src/gateway/gateway');
const { initDistributedArchitecture } = require('./src/distributed');
const { createLogger } = require('./src/shared/logger');

const log = createLogger('agent-bootstrap');

const argv = yargs(hideBin(process.argv))
  .option('agent', { describe: 'Agent ID', type: 'string', default: 'general' })
  .option('port', { describe: 'HTTP port', type: 'number', default: 3101 })
  .option('redis', { describe: 'Redis URL', type: 'string', default: 'redis://localhost:6379' })
  .argv;

(async () => {
  try {
    // 1. Redis 연결
    const redisClient = redis.createClient({ url: argv.redis });
    await redisClient.connect();
    log.info(`Redis connected: ${argv.redis}`);

    // 2. Gateway 초기화 (마이크로서비스용 최소화)
    const gateway = new Gateway();
    log.info(`Gateway created for agent: ${argv.agent}`);

    // 3. 분산 아키텍처 초기화
    const distributed = await initDistributedArchitecture(
      { enabled: true, mode: 'redis', agents: {} },
      { redis: redisClient, agentId: argv.agent }
    );

    // 4. 에이전트 마이크로서비스 생성
    const agentInstance = gateway.agents.get(argv.agent);
    if (!agentInstance) {
      throw new Error(`Agent not found: ${argv.agent}`);
    }

    const service = await distributed.createAgentService(agentInstance, argv.port);
    log.info(`Agent microservice started: ${argv.agent}:${argv.port}`);

    // 5. Graceful shutdown
    process.on('SIGTERM', async () => {
      log.info('SIGTERM received, shutting down...');
      await distributed.shutdown();
      await redisClient.quit();
      process.exit(0);
    });
  } catch (err) {
    log.error(`Fatal error: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
})();
```

### 2. Docker 배포

```dockerfile
# Dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .

ENV AGENT_ID=general
ENV AGENT_PORT=3101
ENV REDIS_URL=redis://redis:6379

EXPOSE 3101

CMD ["node", "agent-bootstrap.js", \
     "--agent=$AGENT_ID", \
     "--port=$AGENT_PORT", \
     "--redis=$REDIS_URL"]
```

### 3. Docker Compose

```yaml
version: '3.8'

services:
  redis:
    image: redis:latest
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data

  effy-general:
    build: .
    ports:
      - "3101:3101"
    environment:
      AGENT_ID: general
      AGENT_PORT: 3101
      REDIS_URL: redis://redis:6379
    depends_on:
      - redis

  effy-code:
    build: .
    ports:
      - "3102:3102"
    environment:
      AGENT_ID: code
      AGENT_PORT: 3102
      REDIS_URL: redis://redis:6379
    depends_on:
      - redis

  effy-gateway:
    build: .
    ports:
      - "3100:3100"
    environment:
      DISTRIBUTED_ENABLED: "true"
      DISTRIBUTED_MODE: "redis"
      REDIS_URL: redis://redis:6379
    depends_on:
      - redis

volumes:
  redis-data:
```

실행:
```bash
docker-compose up -d
```

## Phase 2 Kubernetes 배포

프로덕션 규모 Kubernetes 클러스터에서의 자동 확장.

### 1. Kubernetes 설정

```yaml
# k8s/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: effy

---
# k8s/redis-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: effy-redis
  namespace: effy
spec:
  replicas: 1
  selector:
    matchLabels:
      app: effy-redis
  template:
    metadata:
      labels:
        app: effy-redis
    spec:
      containers:
      - name: redis
        image: redis:latest
        ports:
        - containerPort: 6379

---
apiVersion: v1
kind: Service
metadata:
  name: effy-redis
  namespace: effy
spec:
  selector:
    app: effy-redis
  ports:
  - port: 6379
  clusterIP: None

---
# k8s/agent-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: effy-general-agent
  namespace: effy
spec:
  replicas: 3  # 자동 확장 대상
  selector:
    matchLabels:
      app: effy-agent
      agent-type: general
  template:
    metadata:
      labels:
        app: effy-agent
        agent-type: general
    spec:
      containers:
      - name: agent
        image: effy-agent:latest
        ports:
        - containerPort: 3101
        env:
        - name: AGENT_ID
          value: general
        - name: AGENT_PORT
          value: "3101"
        - name: REDIS_URL
          value: redis://effy-redis:6379
        livenessProbe:
          httpGet:
            path: /health
            port: 3101
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 3101
          initialDelaySeconds: 5
          periodSeconds: 5

---
# k8s/agent-hpa.yaml (자동 스케일링)
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: effy-general-agent-hpa
  namespace: effy
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: effy-general-agent
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

배포:
```bash
kubectl apply -f k8s/

# 확인
kubectl get pods -n effy
kubectl get svc -n effy
```

## 모니터링

### Prometheus 메트릭 수집

```yaml
# prometheus.yml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'effy-agents'
    static_configs:
      - targets:
        - 'localhost:3101'  # general
        - 'localhost:3102'  # code
        - 'localhost:3103'  # ops
    metrics_path: '/metrics'
```

### Health Check

```bash
# 에이전트 헬스 확인
curl http://localhost:3101/health

# 모든 에이전트
for port in 3101 3102 3103; do
  echo "Agent :$port"
  curl -s http://localhost:$port/health | jq .
done
```

## 문제 해결

### 모드 변경 시 기존 세션 마이그레이션

Local → Redis 전환 시 세션 손실 주의:

```javascript
// Phase 1 → Phase 2 마이그레이션 스크립트
const { LocalSessionStore, RedisSessionStore } = require('./distributed');
const redis = require('redis');

(async () => {
  const localStore = new LocalSessionStore();
  const redisClient = redis.createClient({ url: 'redis://localhost:6379' });
  const redisStore = new RedisSessionStore(redisClient);

  // 모든 세션 마이그레이션
  for (const [sessionId, entry] of localStore.sessions) {
    await redisStore.set(sessionId, entry.data);
    console.log(`Migrated: ${sessionId}`);
  }

  console.log('Migration complete');
  await redisClient.quit();
})();
```

## 다음 단계

1. **모니터링 강화**: Prometheus + Grafana
2. **자동 페일오버**: Redis Sentinel
3. **부하 분산**: Nginx Ingress
4. **로그 집계**: ELK Stack
5. **분산 추적**: Jaeger
