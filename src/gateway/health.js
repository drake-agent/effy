/**
 * gateway/health.js — 헬스 체크 엔드포인트
 *
 * 컨테이너 오케스트레이션용 GET /health, GET /health/detailed 엔드포인트.
 * - /health: 간단한 상태 (K8s liveness probe용)
 * - /health/detailed: 각 컴포넌트 상태 + 지연시간 (K8s readiness probe용)
 *
 * 컴포넌트 등록:
 *   health.register('database', {
 *     check: async () => ({ ok: true, details: '...' }),
 *     critical: true
 *   });
 */
const { createLogger } = require('../shared/logger');
const log = createLogger('gateway:health');

class HealthCheck {
  constructor(opts = {}) {
    /**
     * @type {Map<string, { check: Function, critical: boolean }>}
     * 헬스 체크 컴포넌트 맵
     */
    this.components = new Map();

    this.startupTime = Date.now();
    this.lastDetailedCheck = null;
    this._state = 'starting'; // 'starting' | 'ready'
    this._gracePeriodMs = 30000; // 30s grace period during startup
  }

  /**
   * 헬스 체크 컴포넌트 등록
   *
   * @param {string} name - e.g., 'database', 'memory', 'cortex', 'llm'
   * @param {Object} component - { check: async () => ({ ok, details }), critical: bool }
   */
  register(name, component) {
    if (!component.check || typeof component.check !== 'function') {
      throw new Error(`Component '${name}' must have async check() function`);
    }
    const critical = component.critical !== false;
    this.components.set(name, { check: component.check, critical });
    log.debug('Registered health check', { name, critical });
  }

  /**
   * 간단한 헬스 체크 (K8s liveness probe용)
   * 빠르게 응답하고 critical 컴포넌트만 확인 (cached results)
   *
   * @returns {{ status: 'ok'|'degraded'|'unhealthy', uptime: number }}
   */
  check() {
    let status = 'ok';
    const uptime = Date.now() - this.startupTime;

    // Grace period: during startup (first 30s), always report ok for liveness
    if (this._state === 'starting') {
      if (uptime < this._gracePeriodMs) {
        return { status: 'ok', uptime };
      }
      this._state = 'ready';
    }

    // 마지막 상세 체크 결과를 사용 (비동기 호출 없음)
    if (this.lastDetailedCheck) {
      for (const [name, comp] of this.components) {
        if (comp.critical) {
          try {
            const result = this.lastDetailedCheck[name];
            if (result && !result.ok) {
              status = 'degraded';
              break;
            }
          } catch (err) {
            log.error(`Health check '${name}' failed`, err);
            status = 'degraded';
          }
        }
      }
    } else {
      // 상세 체크가 아직 실행되지 않음 but past grace period
      status = 'degraded';
    }

    return { status, uptime };
  }

  /**
   * 상세 헬스 체크 (K8s readiness probe용)
   * 모든 컴포넌트를 비동기로 확인하고 지연시간 측정
   *
   * @returns {Promise<{ status, uptime, components: { [name]: { ok, details, latencyMs } } }>}
   */
  async checkDetailed() {
    const status = {};
    const results = {};
    let allOk = true;

    const promises = Array.from(this.components.entries()).map(async ([name, comp]) => {
      const start = Date.now();
      try {
        const result = await Promise.race([
          comp.check(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 5000)
          ),
        ]);
        const latencyMs = Date.now() - start;
        results[name] = {
          ok: result.ok === true,
          details: result.details || '',
          latencyMs,
        };
        if (!result.ok && comp.critical) {
          allOk = false;
        }
      } catch (err) {
        const latencyMs = Date.now() - start;
        results[name] = {
          ok: false,
          details: err.message || 'unknown error',
          latencyMs,
        };
        if (comp.critical) {
          allOk = false;
        }
        log.warn(`Health check '${name}' failed`, { latencyMs, error: err.message });
      }
    });

    await Promise.all(promises);
    this.lastDetailedCheck = results;

    return {
      status: allOk ? 'ok' : 'degraded',
      uptime: Date.now() - this.startupTime,
      components: results,
    };
  }

  /**
   * Express/Fastify 미들웨어 팩토리
   *
   * @returns {Function} (req, res, next)
   */
  middleware() {
    return async (req, res, next) => {
      try {
        if (req.path === '/health' || req.url === '/health') {
          const result = this.check();
          res.status(result.status === 'ok' ? 200 : 503).json(result);
        } else if (req.path === '/health/detailed' || req.url === '/health/detailed') {
          const result = await this.checkDetailed();
          res.status(result.status === 'ok' ? 200 : 503).json(result);
        } else {
          next();
        }
      } catch (err) {
        log.error('Health middleware error', err);
        res.status(500).json({ status: 'error', message: err.message });
      }
    };
  }
}

module.exports = { HealthCheck };
