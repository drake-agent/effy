/**
 * Memory Bulletin — Tier 1 모듈
 * 잠금 없는 메모리 공유 캐시 (주기적 동기화)
 * SpaceBot-inspired: 영점 비용 읽기를 위한 동결된 스냅샷
 */

const { createLogger } = require('../shared/logger');

class MemoryBulletin {
  /**
   * 초기화 — 메모리 공지사항 캐시 구성
   * @param {Object} opts - 옵션
   * @param {number} opts.refreshIntervalMs - 갱신 간격 (ms)
   * @param {Function} opts.refreshFn - async (agentId) => string
   */
  constructor(opts = {}) {
    this.log = createLogger('MemoryBulletin');

    this.refreshIntervalMs = opts.refreshIntervalMs ?? 3600000; // 60분
    this._bulletins = new Map(); // agentId → frozen bulletin
    this._timestamps = new Map(); // agentId → last generation timestamp
    this._timer = null;
    this._refreshFn = opts.refreshFn ?? null;

    this.log.info('MemoryBulletin initialized', {
      refreshIntervalMs: this.refreshIntervalMs
    });
  }

  /**
   * 에이전트의 현재 공지사항 조회 (영점 비용 읽기)
   * 동결된(frozen) 스냅샷을 반환하므로 변경 불가능
   * @param {string} agentId - 에이전트 ID
   * @returns {{ content: string, generatedAt: number, stale: boolean }}
   */
  get(agentId) {
    try {
      const bulletin = this._bulletins.get(agentId);

      if (!bulletin) {
        return {
          content: '',
          generatedAt: null,
          stale: true
        };
      }

      // 공지사항 생성 이후의 경과 시간 계산
      const elapsed = Date.now() - (this._timestamps.get(agentId) || 0);
      const stale = elapsed > this.refreshIntervalMs;

      return {
        content: bulletin.content,
        generatedAt: this._timestamps.get(agentId),
        stale
      };
    } catch (err) {
      this.log.error('Error getting bulletin', err);
      return { content: '', generatedAt: null, stale: true };
    }
  }

  /**
   * 강제 갱신 — 특정 에이전트의 공지사항 재생성
   * @param {string} agentId - 에이전트 ID
   * @returns {Promise<string>} 새 공지사항 콘텐츠
   */
  async refresh(agentId) {
    try {
      if (!this._refreshFn) {
        this.log.warn('No refreshFn provided, cannot refresh bulletin');
        return '';
      }

      this.log.debug('Refreshing bulletin', { agentId });

      const content = await this._refreshFn(agentId);
      this._swap(agentId, content);

      this.log.info('Bulletin refreshed', { agentId, contentLength: content.length });

      return content;
    } catch (err) {
      this.log.error('Error refreshing bulletin', err);
      return '';
    }
  }

  /**
   * 자동 주기 갱신 시작
   * @param {string[]} agentIds - 갱신할 에이전트 ID 배열
   */
  startAutoRefresh(agentIds = []) {
    try {
      if (this._timer) {
        clearInterval(this._timer);
      }

      this.log.info('Starting auto-refresh', { agentCount: agentIds.length, intervalMs: this.refreshIntervalMs });

      this._timer = setInterval(async () => {
        for (const agentId of agentIds) {
          try {
            await this.refresh(agentId);
          } catch (err) {
            this.log.error('Error in auto-refresh cycle', err);
          }
        }
      }, this.refreshIntervalMs);

      // 초기 갱신
      for (const agentId of agentIds) {
        this.refresh(agentId).catch(err =>
          this.log.error('Error in initial refresh', err)
        );
      }
    } catch (err) {
      this.log.error('Error starting auto-refresh', err);
    }
  }

  /**
   * 자동 갱신 중지
   */
  stopAutoRefresh() {
    try {
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
        this.log.info('Auto-refresh stopped');
      }
    } catch (err) {
      this.log.error('Error stopping auto-refresh', err);
    }
  }

  /**
   * 공지사항 원자적 교체 (스냅샷 동결)
   * @private
   * @param {string} agentId - 에이전트 ID
   * @param {string} content - 새 공지사항 콘텐츠
   */
  _swap(agentId, content) {
    try {
      // 새로운 공지사항 객체 생성 및 동결
      const bulletin = Object.freeze({
        content,
        length: content.length,
        version: 1
      });

      this._bulletins.set(agentId, bulletin);
      this._timestamps.set(agentId, Date.now());

      this.log.debug('Bulletin swapped', { agentId, contentLength: content.length });
    } catch (err) {
      this.log.error('Error swapping bulletin', err);
    }
  }

  /**
   * 특정 에이전트의 캐시 비우기
   * @param {string} agentId - 에이전트 ID
   */
  clear(agentId) {
    this._bulletins.delete(agentId);
    this._timestamps.delete(agentId);
    this.log.debug('Bulletin cleared', { agentId });
  }

  /**
   * 모든 캐시 비우기
   */
  clearAll() {
    this._bulletins.clear();
    this._timestamps.clear();
    this.log.info('All bulletins cleared');
  }

  /**
   * 캐시 통계 조회
   * @returns {Object} 통계
   */
  stats() {
    const staleCount = Array.from(this._timestamps.entries()).filter(
      ([, ts]) => (Date.now() - ts) > this.refreshIntervalMs
    ).length;

    return {
      totalBulletins: this._bulletins.size,
      staleCount,
      refreshIntervalMs: this.refreshIntervalMs,
      isAutoRefreshActive: this._timer !== null
    };
  }
}

module.exports = { MemoryBulletin };
