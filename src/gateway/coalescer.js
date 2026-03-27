/**
 * gateway/coalescer.js — 메시지 병합 (Message Coalescing)
 *
 * 빠른 연속 메시지를 단일 LLM 턴으로 배치:
 * - 디바운스 윈도우: 2초 (설정 가능)
 * - 최대 배치 크기: 10개
 * - DM 제외 (bypassDM=true)
 *
 * 반환 형식:
 *   { messages: [...], coalesced: true, timingGapMs: [100, 200, ...] }
 *
 * LLM 컨텍스트용 포매팅:
 *   "[12:34:56] @user1: message 1"
 *   "[12:34:57] @user2: message 2 (gap: 1000ms)"
 */
const { createLogger } = require('../shared/logger');
const log = createLogger('gateway:coalescer');

class MessageCoalescer {
  constructor(opts = {}) {
    /** @type {number} 배치 윈도우 (ms) */
    this.debounceMs = opts.debounceMs ?? 2000;

    /** @type {number} 최대 배치 크기 */
    this.maxBatchSize = opts.maxBatchSize ?? 10;

    /** @type {boolean} DM 제외 */
    this.bypassDM = opts.bypassDM ?? true;

    /**
     * @type {Map<string, { messages: Object[], timer: NodeJS.Timeout|null, resolve: Function|null }>}
     * 채널별 대기 메시지
     */
    this._pending = new Map();
  }

  /**
   * 메시지 제출 (병합 대기)
   * 반환된 Promise는 배치 완료 시 resolve
   *
   * @param {Object} message - { channelId, content, userId, timestamp, isDM }
   * @returns {Promise<{ messages: Object[], coalesced: boolean, timingGapMs: number[] }>}
   */
  async submit(message) {
    const { channelId, content, userId, timestamp = Date.now(), isDM = false } = message;

    if (!channelId) {
      throw new Error('message.channelId is required');
    }

    // DM 제외
    if (isDM && this.bypassDM) {
      log.debug('Bypassing coalescing for DM', { userId, channelId });
      return { messages: [message], coalesced: false, timingGapMs: [] };
    }

    // 대기 중인 배치 조회 또는 생성
    let pending = this._pending.get(channelId);
    if (!pending) {
      pending = { messages: [], timer: null, resolve: null };
      this._pending.set(channelId, pending);
    }

    // 메시지 추가
    pending.messages.push({
      ...message,
      timestamp,
      _submittedAt: Date.now(),
    });

    // 배치 크기 도달 시 즉시 flush
    if (pending.messages.length >= this.maxBatchSize) {
      return await this._flush(channelId);
    }

    // 첫 메시지인 경우 타이머 설정
    if (pending.messages.length === 1) {
      return await new Promise((resolve) => {
        pending.resolve = resolve;
        pending.timer = setTimeout(() => {
          this._flush(channelId).then(resolve);
        }, this.debounceMs);
      });
    }

    // 이미 타이머가 실행 중인 경우, 마지막 메시지일 때만 resolve
    return await new Promise((resolve) => {
      const originalResolve = pending.resolve;
      pending.resolve = (result) => {
        resolve(result);
        if (originalResolve) originalResolve(result);
      };
    });
  }

  /**
   * 채널의 대기 메시지 즉시 flush
   *
   * @param {string} channelId
   * @returns {Promise<{ messages: Object[], coalesced: boolean, timingGapMs: number[] }>}
   * @private
   */
  async _flush(channelId) {
    const pending = this._pending.get(channelId);
    if (!pending || pending.messages.length === 0) {
      return { messages: [], coalesced: false, timingGapMs: [] };
    }

    // 타이머 정리
    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    const messages = pending.messages;
    const timingGapMs = [];

    // 타이밍 갭 계산
    if (messages.length > 1) {
      for (let i = 1; i < messages.length; i++) {
        const gap = messages[i].timestamp - messages[i - 1].timestamp;
        timingGapMs.push(gap);
      }
    }

    this._pending.delete(channelId);

    const result = {
      messages,
      coalesced: messages.length > 1,
      timingGapMs,
    };

    log.debug('Batch flushed', {
      channelId,
      count: messages.length,
      coalesced: result.coalesced,
    });

    // resolve 콜백 호출
    if (pending.resolve) {
      pending.resolve(result);
    }

    return result;
  }

  /**
   * 채널 메시지 강제 flush
   *
   * @param {string} channelId
   */
  async flush(channelId) {
    return await this._flush(channelId);
  }

  /**
   * 병합된 메시지를 LLM 컨텍스트용으로 포매팅
   *
   * @param {Object} batch - submit() 반환값
   * @returns {string} 포매팅된 텍스트
   */
  formatForLLM(batch) {
    if (!batch.messages || batch.messages.length === 0) {
      return '';
    }

    const lines = [];
    for (let i = 0; i < batch.messages.length; i++) {
      const msg = batch.messages[i];
      const time = new Date(msg.timestamp).toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

      let line = `[${time}] @${msg.userId || 'unknown'}: ${msg.content}`;

      // 타이밍 갭 추가 (첫 메시지 제외)
      if (i > 0 && batch.timingGapMs[i - 1] > 0) {
        line += ` (gap: ${batch.timingGapMs[i - 1]}ms)`;
      }

      lines.push(line);
    }

    if (batch.coalesced) {
      lines.unshift(`[COALESCED ${batch.messages.length} messages]`);
    }

    return lines.join('\n');
  }

  /**
   * 모든 대기 타이머 정리 (shutdown 시)
   */
  destroy() {
    for (const [channelId, pending] of this._pending) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      if (pending.resolve) {
        pending.resolve({
          messages: pending.messages,
          coalesced: pending.messages.length > 1,
          timingGapMs: [],
        });
      }
    }
    this._pending.clear();
    log.info('Coalescer destroyed');
  }

  /**
   * 통계
   *
   * @returns {{ pendingChannels: number, totalMessages: number }}
   */
  getStats() {
    let totalMessages = 0;
    for (const pending of this._pending.values()) {
      totalMessages += pending.messages.length;
    }
    return {
      pendingChannels: this._pending.size,
      totalMessages,
    };
  }
}

module.exports = { MessageCoalescer };
