/**
 * discovery.js — 서비스 디스커버리 (Service Discovery).
 *
 * 모드:
 *  - static: 설정에서 에이전트 위치 정의
 *  - kubernetes: K8s DNS 기반 자동 발견
 *
 * 기능:
 * - resolveAgent(agentId): 에이전트 주소 확인
 * - getHealthStatus(agentId): 헬스 상태 조회
 * - listAgents(): 모든 에이전트 나열
 * - Circuit Breaker 패턴 (실패 후 빠른 실패)
 */

const { createLogger } = require('../shared/logger');
const http = require('http');

const log = createLogger('discovery');

/**
 * CircuitBreaker: 에이전트별 장애 관리.
 *
 * 상태: CLOSED → OPEN → HALF_OPEN → CLOSED
 */
class CircuitBreaker {
  constructor(agentId, options = {}) {
    this.agentId = agentId;
    this.state = 'CLOSED'; // CLOSED | OPEN | HALF_OPEN
    this.failureCount = 0;
    this.failureThreshold = options.failureThreshold || 3;
    this.cooldownMs = options.cooldownMs || 30000; // 30초
    this.successThreshold = options.successThreshold || 2;
    this.successCount = 0;
    this.openedAt = null;
  }

  /**
   * 요청 시도.
   * @returns {boolean} 요청 허용 여부
   */
  canAttempt() {
    if (this.state === 'CLOSED') {
      return true;
    }

    if (this.state === 'OPEN') {
      // 쿨다운 확인
      if (Date.now() - this.openedAt > this.cooldownMs) {
        this.state = 'HALF_OPEN';
        this.successCount = 0;
        log.info(`CircuitBreaker[${this.agentId}]: HALF_OPEN (retry)`);
        return true;
      }
      return false;
    }

    // HALF_OPEN: 시도 허용
    return true;
  }

  /**
   * 요청 성공.
   */
  recordSuccess() {
    if (this.state === 'CLOSED') {
      this.failureCount = 0;
    } else if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = 'CLOSED';
        this.failureCount = 0;
        log.info(`CircuitBreaker[${this.agentId}]: CLOSED (recovered)`);
      }
    }
  }

  /**
   * 요청 실패.
   */
  recordFailure() {
    this.failureCount++;

    if (this.state === 'HALF_OPEN') {
      // HALF_OPEN에서 실패 → 다시 OPEN
      this.state = 'OPEN';
      this.openedAt = Date.now();
      log.warn(`CircuitBreaker[${this.agentId}]: OPEN (recovery failed)`);
    } else if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      log.warn(`CircuitBreaker[${this.agentId}]: OPEN (threshold exceeded: ${this.failureCount})`);
    }
  }

  /**
   * 상태 조회.
   * @returns {string}
   */
  getState() {
    return this.state;
  }
}

/**
 * StaticServiceDiscovery: 정적 서비스 발견.
 *
 * 설정 파일에서 에이전트 위치 정의.
 */
class StaticServiceDiscovery {
  constructor(config = {}) {
    this.mode = 'static';
    this.agents = new Map(); // { agentId: { host, port, replica } }
    this.breakers = new Map(); // { agentId: CircuitBreaker }
    this.healthChecks = new Map(); // { agentId: { status, lastCheck } }
    this.healthCheckIntervalMs = config.healthCheckIntervalMs || 30000;

    // 에이전트 설정 파싱
    this._parseConfig(config.agents || {});

    // 헬스 체크 시작
    this._startHealthChecks();

    log.info(`StaticServiceDiscovery initialized with ${this.agents.size} agent(s)`);
  }

  /**
   * 설정 파싱.
   * @private
   */
  _parseConfig(agentsConfig) {
    for (const [agentId, agentConfig] of Object.entries(agentsConfig)) {
      const { replicas = 1, port = 3100 + Object.keys(agentsConfig).indexOf(agentId) } = agentConfig;

      for (let i = 0; i < replicas; i++) {
        const replicaId = replicas > 1 ? `${agentId}-${i}` : agentId;
        const addr = {
          agentId,
          host: agentConfig.host || 'localhost',
          port: port + i,
          replicaIndex: i,
        };

        this.agents.set(replicaId, addr);
        this.breakers.set(replicaId, new CircuitBreaker(replicaId));
        this.healthChecks.set(replicaId, { status: 'unknown', lastCheck: null });
      }
    }
  }

  /**
   * 에이전트 주소 확인.
   * @param {string} agentId
   * @returns {object|null} { host, port }
   */
  resolveAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      log.warn(`Agent not found: ${agentId}`);
      return null;
    }

    const breaker = this.breakers.get(agentId);
    if (!breaker.canAttempt()) {
      log.warn(`Agent circuit open, not attempting: ${agentId}`);
      return null;
    }

    return {
      host: agent.host,
      port: agent.port,
      url: `http://${agent.host}:${agent.port}`,
    };
  }

  /**
   * 헬스 상태 조회.
   * @param {string} agentId
   * @returns {object} { status, lastCheck, circuitState }
   */
  getHealthStatus(agentId) {
    const check = this.healthChecks.get(agentId);
    const breaker = this.breakers.get(agentId);

    return {
      agentId,
      status: check?.status || 'unknown',
      lastCheck: check?.lastCheck,
      circuitState: breaker?.getState() || 'CLOSED',
    };
  }

  /**
   * 모든 에이전트 나열.
   * @returns {array}
   */
  listAgents() {
    const agents = [];
    for (const [replicaId, addr] of this.agents) {
      const health = this.getHealthStatus(replicaId);
      agents.push({
        id: replicaId,
        agentId: addr.agentId,
        host: addr.host,
        port: addr.port,
        ...health,
      });
    }
    return agents;
  }

  /**
   * 헬스 체크 시작.
   * @private
   */
  _startHealthChecks() {
    setInterval(() => {
      for (const agentId of this.agents.keys()) {
        this._checkHealth(agentId).catch((err) => {
          log.debug(`Health check error for ${agentId}: ${err.message}`);
        });
      }
    }, this.healthCheckIntervalMs);
  }

  /**
   * 개별 헬스 체크.
   * @private
   */
  async _checkHealth(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    try {
      const url = `http://${agent.host}:${agent.port}/health`;
      const result = await this._httpGet(url, 5000);

      if (result.statusCode === 200) {
        this.healthChecks.set(agentId, {
          status: 'up',
          lastCheck: Date.now(),
        });
        this.breakers.get(agentId).recordSuccess();
      } else {
        this.healthChecks.set(agentId, {
          status: 'down',
          lastCheck: Date.now(),
        });
        this.breakers.get(agentId).recordFailure();
      }
    } catch (err) {
      this.healthChecks.set(agentId, {
        status: 'down',
        lastCheck: Date.now(),
      });
      this.breakers.get(agentId).recordFailure();
    }
  }

  /**
   * HTTP GET (간단한 유틸).
   * @private
   */
  _httpGet(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: data });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });

      req.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * 종료.
   */
  async close() {
    log.info('StaticServiceDiscovery closed');
  }
}

/**
 * KubernetesServiceDiscovery: K8s DNS 기반 발견.
 *
 * K8s 클러스터에서 DNS 기반 자동 발견.
 * 예: general-agent.effy.svc.cluster.local:3101
 */
class KubernetesServiceDiscovery {
  constructor(config = {}) {
    this.mode = 'kubernetes';
    this.namespace = config.namespace || 'effy';
    this.domain = config.domain || 'svc.cluster.local';
    this.agents = config.agents || {};
    this.breakers = new Map();
    this.healthChecks = new Map();
    this.healthCheckIntervalMs = config.healthCheckIntervalMs || 30000;

    // Circuit Breaker 초기화
    for (const agentId of Object.keys(this.agents)) {
      this.breakers.set(agentId, new CircuitBreaker(agentId));
      this.healthChecks.set(agentId, { status: 'unknown', lastCheck: null });
    }

    // 헬스 체크 시작
    this._startHealthChecks();

    log.info(`KubernetesServiceDiscovery initialized (namespace=${this.namespace})`);
  }

  /**
   * 에이전트 주소 확인.
   * @param {string} agentId
   * @returns {object|null} { host, port }
   */
  resolveAgent(agentId) {
    const agentConfig = this.agents[agentId];
    if (!agentConfig) {
      log.warn(`Agent not found: ${agentId}`);
      return null;
    }

    const breaker = this.breakers.get(agentId);
    if (!breaker.canAttempt()) {
      log.warn(`Agent circuit open, not attempting: ${agentId}`);
      return null;
    }

    // K8s DNS 주소: service-name.namespace.domain
    const host = `${agentId}-agent.${this.namespace}.${this.domain}`;
    const port = agentConfig.port || 3101;

    return {
      host,
      port,
      url: `http://${host}:${port}`,
    };
  }

  /**
   * 헬스 상태 조회.
   * @param {string} agentId
   * @returns {object}
   */
  getHealthStatus(agentId) {
    const check = this.healthChecks.get(agentId);
    const breaker = this.breakers.get(agentId);

    return {
      agentId,
      status: check?.status || 'unknown',
      lastCheck: check?.lastCheck,
      circuitState: breaker?.getState() || 'CLOSED',
    };
  }

  /**
   * 모든 에이전트 나열.
   * @returns {array}
   */
  listAgents() {
    const agents = [];
    for (const agentId of Object.keys(this.agents)) {
      const resolved = this.resolveAgent(agentId);
      const health = this.getHealthStatus(agentId);
      agents.push({
        id: agentId,
        host: resolved?.host,
        port: resolved?.port,
        ...health,
      });
    }
    return agents;
  }

  /**
   * 헬스 체크 시작.
   * @private
   */
  _startHealthChecks() {
    setInterval(() => {
      for (const agentId of Object.keys(this.agents)) {
        this._checkHealth(agentId).catch((err) => {
          log.debug(`Health check error for ${agentId}: ${err.message}`);
        });
      }
    }, this.healthCheckIntervalMs);
  }

  /**
   * 개별 헬스 체크.
   * @private
   */
  async _checkHealth(agentId) {
    const resolved = this.resolveAgent(agentId);
    if (!resolved) return;

    try {
      const url = `${resolved.url}/health`;
      const result = await this._httpGet(url, 5000);

      if (result.statusCode === 200) {
        this.healthChecks.set(agentId, {
          status: 'up',
          lastCheck: Date.now(),
        });
        this.breakers.get(agentId).recordSuccess();
      } else {
        this.healthChecks.set(agentId, {
          status: 'down',
          lastCheck: Date.now(),
        });
        this.breakers.get(agentId).recordFailure();
      }
    } catch (err) {
      this.healthChecks.set(agentId, {
        status: 'down',
        lastCheck: Date.now(),
      });
      this.breakers.get(agentId).recordFailure();
    }
  }

  /**
   * HTTP GET.
   * @private
   */
  _httpGet(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: data });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });

      req.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * 종료.
   */
  async close() {
    log.info('KubernetesServiceDiscovery closed');
  }
}

/**
 * ServiceDiscovery 팩토리.
 * @param {object} config - { mode, agents, namespace?, ... }
 * @returns {StaticServiceDiscovery|KubernetesServiceDiscovery}
 */
function createServiceDiscovery(config = {}) {
  const mode = config.mode || 'static';

  if (mode === 'kubernetes') {
    return new KubernetesServiceDiscovery(config);
  }

  return new StaticServiceDiscovery(config);
}

module.exports = {
  StaticServiceDiscovery,
  KubernetesServiceDiscovery,
  createServiceDiscovery,
  CircuitBreaker,
};
