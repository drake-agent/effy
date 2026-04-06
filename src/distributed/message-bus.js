/**
 * message-bus.js — 에이전트 간 메시지 버스.
 *
 * 모드:
 *  - local: 직접 함수 호출 (기본, 현재 동작 유지)
 *  - redis: Pub/Sub 기반 분산 메시징
 *
 * CE-4 LIMITATION: Redis Pub/Sub has no message persistence. If a subscriber
 * is disconnected when a message is published, that message is lost permanently.
 * This means agent-to-agent messages can be silently dropped during network
 * partitions, restarts, or scaling events. For production reliability, consider
 * migrating to Redis Streams (XADD/XREADGROUP) which provides:
 *   - Message persistence and replay (consumer groups with acknowledgment)
 *   - At-least-once delivery guarantees
 *   - Backpressure via consumer group lag monitoring
 *
 * 메시지 형식:
 * {
 *   from: string (에이전트 ID)
 *   to: string (에이전트 ID) | "*" (브로드캐스트)
 *   type: string (request, response, event, broadcast)
 *   payload: object
 *   correlationId: string (요청-응답 상관관계)
 *   timestamp: number (ISO timestamp)
 * }
 *
 * 지원:
 * - Request-Reply 패턴 (타임아웃 포함)
 * - 브로드캐스트 (팬아웃)
 * - 이벤트 발행
 */

const { createLogger } = require('../shared/logger');
const EventEmitter = require('events');
const crypto = require('crypto');

const log = createLogger('message-bus');

/**
 * LocalMessageBus: 프로세스 내 메시지 버스 (직접 호출).
 */
class LocalMessageBus extends EventEmitter {
  constructor() {
    super();
    this.mode = 'local';
    this.handlers = new Map(); // { agentId: handlerFn }
    this.pendingRequests = new Map(); // { correlationId: { resolve, reject, timer } }
    this.requestTimeoutMs = 30000; // 30초
  }

  /**
   * 에이전트 핸들러 등록.
   * @param {string} agentId
   * @param {function} handler - (message) => Promise<response>
   */
  register(agentId, handler) {
    this.handlers.set(agentId, handler);
    log.debug(`Handler registered: ${agentId}`);
  }

  /**
   * 에이전트 핸들러 제거.
   * @param {string} agentId
   */
  unregister(agentId) {
    this.handlers.delete(agentId);
    log.debug(`Handler unregistered: ${agentId}`);
  }

  /**
   * 메시지 전송 (요청-응답).
   * @param {string} from
   * @param {string} to
   * @param {string} type
   * @param {object} payload
   * @param {object} options - { timeoutMs }
   * @returns {Promise<object>} response
   */
  async request(from, to, type, payload, options = {}) {
    const correlationId = this._generateCorrelationId();
    const timeoutMs = options.timeoutMs || this.requestTimeoutMs;

    const message = {
      from,
      to,
      type,
      payload,
      correlationId,
      timestamp: Date.now(),
    };

    // 로컬 핸들러 직접 호출
    const handler = this.handlers.get(to);
    if (!handler) {
      const err = new Error(`No handler registered for agent: ${to}`);
      log.warn(err.message);
      throw err;
    }

    try {
      log.debug(`Request: ${from} → ${to} (${type}), correlationId=${correlationId}`);
      const response = await handler(message);

      return {
        ...response,
        correlationId,
        timestamp: Date.now(),
      };
    } catch (err) {
      log.error(`Request failed: ${from} → ${to}, error=${err.message}`);
      throw err;
    }
  }

  /**
   * 메시지 발행 (이벤트, 응답 없음).
   * @param {string} from
   * @param {string} to - 에이전트 ID 또는 "*" (브로드캐스트)
   * @param {string} type
   * @param {object} payload
   */
  async publish(from, to, type, payload) {
    const message = {
      from,
      to,
      type,
      payload,
      correlationId: this._generateCorrelationId(),
      timestamp: Date.now(),
    };

    if (to === '*') {
      // 브로드캐스트
      log.debug(`Broadcast: ${from} (${type}) → all agents`);
      const promises = [];
      for (const [agentId, handler] of this.handlers) {
        if (agentId !== from) {
          promises.push(
            handler(message).catch((err) => {
              log.warn(`Broadcast delivery failed to ${agentId}: ${err.message}`);
            })
          );
        }
      }
      await Promise.all(promises);
    } else {
      // 단일 대상
      const handler = this.handlers.get(to);
      if (handler) {
        log.debug(`Publish: ${from} → ${to} (${type})`);
        await handler(message).catch((err) => {
          log.warn(`Publish delivery failed: ${err.message}`);
        });
      } else {
        log.warn(`No handler for publish target: ${to}`);
      }
    }
  }

  /**
   * 상관 ID 생성.
   * @returns {string}
   */
  _generateCorrelationId() {
    return crypto.randomBytes(8).toString('hex');
  }
}

/**
 * RedisMessageBus: Redis Pub/Sub 기반 메시지 버스 (분산).
 */
class RedisMessageBus extends EventEmitter {
  constructor(redisClient, options = {}) {
    super();
    this.mode = 'redis';
    this.redis = redisClient;
    this.pubClient = redisClient;
    this.subClient = null;
    this.prefix = options.prefix || 'effy:mbus:';
    this.handlers = new Map();
    this.pendingRequests = new Map();
    this.requestTimeoutMs = options.requestTimeoutMs || 30000;
    this.agentId = options.agentId || 'unknown';

    // CE-5 fix: Idempotency — track recently processed correlationIds
    // to prevent duplicate execution on Redis partition/reconnect.
    this._processedIds = new Set();
    this._PROCESSED_IDS_MAX = 10000;
    this._PROCESSED_IDS_TTL_MS = 60000; // 1 minute
  }

  /**
   * 초기화.
   * @returns {Promise<void>}
   */
  async init() {
    // Pub/Sub용 별도 구독 클라이언트 생성
    if (typeof this.redis.duplicate === 'function') {
      this.subClient = this.redis.duplicate();
    } else {
      // 폴백: 동일 클라이언트 사용 (일부 Redis 라이브러리)
      this.subClient = this.redis;
    }

    // 응답 채널 구독
    const responseChannel = `${this.prefix}response:${this.agentId}`;
    await this.subClient.subscribe(responseChannel, (message) => {
      this._handleResponse(message);
    });

    // Subscribe to broadcast channel
    const broadcastChannel = `${this.prefix}broadcast`;
    await this.subClient.subscribe(broadcastChannel, (message) => {
      // Dispatch broadcast to all registered handlers
      for (const [, handler] of this.handlers) {
        this._handleRequest(message, handler).catch((err) => {
          log.error(`Broadcast handler failed: ${err.message}`);
        });
      }
    });

    log.info(`RedisMessageBus initialized (agent=${this.agentId})`);
  }

  /**
   * 에이전트 핸들러 등록.
   * @param {string} agentId
   * @param {function} handler
   */
  async register(agentId, handler) {
    this.handlers.set(agentId, handler);
    const channel = `${this.prefix}request:${agentId}`;
    await this.subClient.subscribe(channel, (message) => {
      this._handleRequest(message, handler).catch((err) => {
        log.error(`Request handler failed: ${err.message}`);
      });
    });
    log.debug(`RedisMessageBus: Handler registered (${agentId})`);
  }

  /**
   * 핸들러 제거.
   * @param {string} agentId
   */
  async unregister(agentId) {
    this.handlers.delete(agentId);
    const channel = `${this.prefix}request:${agentId}`;
    await this.subClient.unsubscribe(channel);
    log.debug(`RedisMessageBus: Handler unregistered (${agentId})`);
  }

  /**
   * 요청 전송.
   * @param {string} from
   * @param {string} to
   * @param {string} type
   * @param {object} payload
   * @param {object} options
   * @returns {Promise<object>}
   */
  async request(from, to, type, payload, options = {}) {
    const correlationId = this._generateCorrelationId();
    const timeoutMs = options.timeoutMs || this.requestTimeoutMs;

    const message = {
      from,
      to,
      type,
      payload,
      correlationId,
      timestamp: Date.now(),
    };

    // 응답 대기 설정
    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        reject(new Error(`Request timeout (${timeoutMs}ms): ${from} → ${to}`));
      }, timeoutMs);

      this.pendingRequests.set(correlationId, { resolve, reject, timer });
    });

    // 요청 발행
    const channel = `${this.prefix}request:${to}`;
    await this.pubClient.publish(channel, JSON.stringify(message));

    log.debug(`Request published: ${from} → ${to} (${type}), cid=${correlationId}`);

    return responsePromise;
  }

  /**
   * 메시지 발행.
   * @param {string} from
   * @param {string} to
   * @param {string} type
   * @param {object} payload
   */
  async publish(from, to, type, payload) {
    const message = {
      from,
      to,
      type,
      payload,
      correlationId: this._generateCorrelationId(),
      timestamp: Date.now(),
    };

    if (to === '*') {
      // 브로드캐스트
      const channel = `${this.prefix}broadcast`;
      await this.pubClient.publish(channel, JSON.stringify(message));
      log.debug(`Broadcast published: ${from} (${type})`);
    } else {
      // 단일 대상
      const channel = `${this.prefix}publish:${to}`;
      await this.pubClient.publish(channel, JSON.stringify(message));
      log.debug(`Publish: ${from} → ${to} (${type})`);
    }
  }

  /**
   * 요청 처리.
   * CE-5 fix: Check correlationId for idempotency before executing.
   * @private
   */
  async _handleRequest(messageJson, handler) {
    try {
      const message = JSON.parse(messageJson);

      // CE-5: Idempotency check — skip if already processed
      const dedupKey = message.correlationId;
      if (dedupKey && this._processedIds.has(dedupKey)) {
        log.debug(`Duplicate message skipped: correlationId=${dedupKey}`);
        return;
      }
      if (dedupKey) {
        this._processedIds.add(dedupKey);
        // Evict old entries when set grows too large
        if (this._processedIds.size > this._PROCESSED_IDS_MAX) {
          const removeCount = Math.floor(this._PROCESSED_IDS_MAX * 0.2);
          let removed = 0;
          for (const id of this._processedIds) {
            if (removed >= removeCount) break;
            this._processedIds.delete(id);
            removed++;
          }
        }
        // TTL cleanup for this entry
        setTimeout(() => this._processedIds.delete(dedupKey), this._PROCESSED_IDS_TTL_MS);
      }

      const response = await handler(message);
      const responseChannel = `${this.prefix}response:${message.from}`;
      const responseMsg = {
        ...response,
        correlationId: message.correlationId,
        timestamp: Date.now(),
      };
      await this.pubClient.publish(responseChannel, JSON.stringify(responseMsg));
    } catch (err) {
      log.error(`_handleRequest failed: ${err.message}`);
    }
  }

  /**
   * 응답 처리.
   * @private
   */
  _handleResponse(messageJson) {
    try {
      const response = JSON.parse(messageJson);
      const { correlationId } = response;
      const pending = this.pendingRequests.get(correlationId);

      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(correlationId);
        pending.resolve(response);
      }
    } catch (err) {
      log.error(`_handleResponse failed: ${err.message}`);
    }
  }

  /**
   * 상관 ID 생성.
   * @returns {string}
   */
  _generateCorrelationId() {
    return crypto.randomBytes(8).toString('hex');
  }

  /**
   * 종료.
   * @returns {Promise<void>}
   */
  async close() {
    // Reject all pending request promises before clearing
    for (const [correlationId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MessageBus closing: request aborted'));
    }
    this.pendingRequests.clear();

    if (this.subClient && this.subClient !== this.redis) {
      await this.subClient.quit();
    }
    log.info('RedisMessageBus closed');
  }
}

/**
 * MessageBus 팩토리.
 * @param {object} options - { mode, redis?, agentId? }
 * @returns {LocalMessageBus|RedisMessageBus}
 */
function createMessageBus(options = {}) {
  const mode = options.mode || 'local';

  if (mode === 'redis') {
    if (!options.redis) {
      throw new Error('Redis client required for redis mode');
    }
    return new RedisMessageBus(options.redis, options);
  }

  return new LocalMessageBus();
}

module.exports = {
  LocalMessageBus,
  RedisMessageBus,
  createMessageBus,
};
