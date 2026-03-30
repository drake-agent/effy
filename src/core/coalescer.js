/**
 * coalescer.js — Message Coalescing.
 *
 * 빠른 연속 메시지를 채널별 독립 타이머로 배치 처리.
 * DM은 즉시 flush (bypass).
 */
const { config } = require('../config');

class MessageCoalescer {
  constructor(opts = {}) {
    const coalescerCfg = config.coalescer || {};
    this.debounceMs = coalescerCfg.debounceMs || 150;
    this.dmBypass = coalescerCfg.dmBypass !== false;
    this.enabled = coalescerCfg.enabled !== false;
    // R3-PERF-4: global pending message cap
    this.maxTotalPending = opts.maxTotalPending ?? coalescerCfg.maxTotalPending ?? 1000;

    /** @type {Map<string, { timer: NodeJS.Timeout|null, messages: object[], flushCallback: function }>} */
    this._channels = new Map();
  }

  /**
   * 메시지 추가.
   * @param {string} channelId
   * @param {boolean} isDM
   * @param {object} msg - NormalizedMessage
   * @param {function} flushCallback - (msgs[]) => Promise<void>
   */
  add(channelId, isDM, msg, flushCallback) {
    if (!this.enabled) { flushCallback([msg]); return; }
    if (isDM && this.dmBypass) { flushCallback([msg]); return; }

    // R3-PERF-4: global pending cap — 초과 시 즉시 flush (drop 방지)
    let totalPending = 0;
    for (const [, b] of this._channels) totalPending += b.messages.length;
    if (totalPending >= this.maxTotalPending) {
      flushCallback([msg]);
      return;
    }

    let bucket = this._channels.get(channelId);
    if (!bucket) {
      bucket = { timer: null, messages: [], flushCallback };
      this._channels.set(channelId, bucket);
    }

    bucket.messages.push(msg);
    bucket.flushCallback = flushCallback;

    if (bucket.timer) clearTimeout(bucket.timer);
    bucket.timer = setTimeout(() => {
      const msgs = bucket.messages;
      this._channels.delete(channelId);
      if (msgs.length > 0) flushCallback(msgs);
    }, this.debounceMs);
  }

  /** 모든 채널 즉시 flush (graceful shutdown / 테스트용). */
  flushAll() {
    for (const [, bucket] of this._channels) {
      if (bucket.timer) clearTimeout(bucket.timer);
      if (bucket.messages.length > 0 && bucket.flushCallback) {
        bucket.flushCallback(bucket.messages);
      }
    }
    this._channels.clear();
  }

  get pendingChannels() { return this._channels.size; }
}

module.exports = { MessageCoalescer };
