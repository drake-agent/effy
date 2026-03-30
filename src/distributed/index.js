/**
 * distributed/index.js — Distributed Architecture 모듈 내보내기.
 *
 * Phase 2: 단일 프로세스를 넘어 확장 가능한 분산 아키텍처.
 * - 각 에이전트는 독립적인 마이크로서비스로 운영 가능
 * - 메시지 버스로 에이전트 간 통신
 * - 분산 세션 저장소로 상태 공유
 * - 서비스 디스커버리로 자동 발견
 *
 * 모드별 동작:
 * - local: 모든 컴포넌트가 프로세스 내에서 실행 (현재 v3.5 동작 유지)
 * - redis: Redis 기반 분산 처리 (확장성)
 * - kubernetes: K8s 클러스터 배포 (프로덕션 대규모)
 *
 * 하위 호환성:
 * - distributed.enabled = false (기본값): 현재 동작 100% 유지
 * - local 모드: 0번 변동
 */

const { AgentService } = require('./agent-service');
const {
  LocalMessageBus,
  RedisMessageBus,
  createMessageBus,
} = require('./message-bus');
const {
  LocalSessionStore,
  RedisSessionStore,
  createSessionStore,
} = require('./session-store');
const {
  StaticServiceDiscovery,
  KubernetesServiceDiscovery,
  createServiceDiscovery,
  CircuitBreaker,
} = require('./discovery');
const { createLogger } = require('../shared/logger');

const log = createLogger('distributed');

/**
 * DistributedArchitecture: Phase 2 분산 아키텍처 매니저.
 *
 * Gateway 부팅 중 활성화 (enabled: true 시).
 * 모든 컴포넌트를 조율하고 생명주기 관리.
 */
class DistributedArchitecture {
  constructor(config = {}) {
    this.config = config;
    this.enabled = config.enabled || false;
    this.mode = config.mode || 'local';

    this.messageBus = null;
    this.sessionStore = null;
    this.discovery = null;
    this.services = new Map(); // { agentId: AgentService }

    log.info(`DistributedArchitecture: mode=${this.mode}, enabled=${this.enabled}`);
  }

  /**
   * 초기화.
   * @param {object} options - { redis?, gateway? }
   * @returns {Promise<void>}
   */
  async init(options = {}) {
    if (!this.enabled) {
      log.info('Distributed architecture disabled, using local mode');
      return;
    }

    try {
      // 1. 메시지 버스 생성
      this.messageBus = createMessageBus({
        mode: this.mode,
        redis: options.redis,
        agentId: options.agentId,
      });

      if (this.messageBus instanceof RedisMessageBus) {
        await this.messageBus.init();
      }

      log.info(`MessageBus initialized: ${this.mode}`);

      // 2. 세션 저장소 생성
      this.sessionStore = createSessionStore({
        mode: this.mode,
        redis: options.redis,
        defaultTtlMs: this.config.sessionStore?.defaultTtlMs,
        cleanupIntervalMs: this.config.sessionStore?.cleanupIntervalMs,
        prefix: this.config.redis?.prefix,
      });

      log.info(`SessionStore initialized: ${this.mode}`);

      // 3. 서비스 디스커버리 생성
      this.discovery = createServiceDiscovery({
        mode: this.config.discovery?.mode || 'static',
        agents: this.config.agents || {},
        namespace: this.config.kubernetes?.namespace,
        domain: this.config.kubernetes?.domain,
        healthCheckIntervalMs: this.config.discovery?.healthCheckIntervalMs,
      });

      log.info(`ServiceDiscovery initialized: ${this.config.discovery?.mode || 'static'}`);
    } catch (err) {
      log.error(`DistributedArchitecture init failed: ${err.message}`, { error: err });
      throw err;
    }
  }

  /**
   * 에이전트 마이크로서비스 생성.
   * @param {object} agentInstance - 에이전트 인스턴스
   * @param {number} port - HTTP 포트
   * @returns {Promise<AgentService>}
   */
  async createAgentService(agentInstance, port) {
    if (!this.enabled) {
      // 비활성화 시 null 반환 (게이트웨이가 직접 관리)
      return null;
    }

    try {
      const service = new AgentService(agentInstance, port, {
        sessionStore: this.sessionStore,
        messageBus: this.messageBus,
        mode: this.mode,
      });

      await service.start();
      this.services.set(agentInstance.id, service);

      log.info(`AgentService created: ${agentInstance.id}:${port}`);
      return service;
    } catch (err) {
      log.error(`Failed to create AgentService: ${err.message}`);
      throw err;
    }
  }

  /**
   * 메시지 버스 에이전트 핸들러 등록.
   * @param {string} agentId
   * @param {function} handler
   * @returns {Promise<void>}
   */
  async registerMessageHandler(agentId, handler) {
    if (!this.messageBus) {
      return; // 비활성화 시 무시
    }

    if (this.messageBus instanceof LocalMessageBus) {
      this.messageBus.register(agentId, handler);
    } else if (this.messageBus instanceof RedisMessageBus) {
      await this.messageBus.register(agentId, handler);
    }
  }

  /**
   * 분산 아키텍처 상태 조회.
   * @returns {object}
   */
  async getStatus() {
    const status = {
      enabled: this.enabled,
      mode: this.mode,
      components: {
        messageBus: this.messageBus ? this.messageBus.mode : null,
        sessionStore: this.sessionStore ? this.sessionStore.mode : null,
        discovery: this.discovery ? this.discovery.mode : null,
      },
      services: [],
      agents: [],
    };

    // 마이크로서비스 상태
    for (const [agentId, service] of this.services) {
      status.services.push({
        agentId,
        running: service.running,
        metrics: service.getMetrics(),
      });
    }

    // 서비스 디스커버리 상태
    if (this.discovery) {
      status.agents = this.discovery.listAgents();
    }

    // 세션 저장소 통계
    if (this.sessionStore) {
      status.sessionStats = await this.sessionStore.stats?.();
    }

    return status;
  }

  /**
   * 종료.
   * @returns {Promise<void>}
   */
  async shutdown() {
    log.info('DistributedArchitecture shutting down...');

    // 마이크로서비스 종료
    for (const [agentId, service] of this.services) {
      try {
        await service.stop();
      } catch (err) {
        log.warn(`Error stopping service ${agentId}: ${err.message}`);
      }
    }

    // 메시지 버스 종료
    if (this.messageBus instanceof RedisMessageBus) {
      try {
        await this.messageBus.close();
      } catch (err) {
        log.warn(`Error closing message bus: ${err.message}`);
      }
    }

    // 세션 저장소 종료
    if (this.sessionStore) {
      try {
        await this.sessionStore.close();
      } catch (err) {
        log.warn(`Error closing session store: ${err.message}`);
      }
    }

    // 서비스 디스커버리 종료
    if (this.discovery) {
      try {
        await this.discovery.close();
      } catch (err) {
        log.warn(`Error closing discovery: ${err.message}`);
      }
    }

    log.info('DistributedArchitecture shut down');
  }
}

/**
 * 싱글톤 인스턴스 관리.
 */
let instance = null;

/**
 * DistributedArchitecture 싱글톤 조회/생성.
 * @param {object} config
 * @returns {DistributedArchitecture}
 */
function getDistributedArchitecture(config = {}) {
  if (!instance) {
    instance = new DistributedArchitecture(config);
  }
  return instance;
}

/**
 * 싱글톤 초기화.
 * @param {object} config
 * @param {object} options
 * @returns {Promise<void>}
 */
async function initDistributedArchitecture(config, options) {
  instance = new DistributedArchitecture(config);
  await instance.init(options);
  return instance;
}

/**
 * 싱글톤 제거.
 */
function resetDistributedArchitecture() {
  instance = null;
}

module.exports = {
  DistributedArchitecture,
  AgentService,
  LocalMessageBus,
  RedisMessageBus,
  createMessageBus,
  LocalSessionStore,
  RedisSessionStore,
  createSessionStore,
  StaticServiceDiscovery,
  KubernetesServiceDiscovery,
  createServiceDiscovery,
  CircuitBreaker,
  getDistributedArchitecture,
  initDistributedArchitecture,
  resetDistributedArchitecture,
};
