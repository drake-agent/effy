/**
 * passive-listener.js — Layer 0: Passive Message Observer.
 *
 * Slack public 채널의 모든 메시지를 수신하여 L2 Episodic에 observation 모드로 저장.
 * 에이전트 파이프라인에 진입하지 않으며, LLM 비용 $0.
 *
 * 역할:
 * - message.channels 이벤트 수신 (public 채널 전량)
 * - 필터링: 봇 메시지, 시스템 메시지, DM, 빈 메시지 제외
 * - L2 Episodic에 source='observed' 로 저장
 * - 채널별 토픽 버퍼 유지 (PatternDetector에 제공)
 * - 메시지 카운터 관리 (분석 트리거용)
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('observer:listener');

class PassiveListener {
  /**
   * @param {object} opts
   * @param {object} opts.config - observer config 섹션
   * @param {object} opts.episodic - episodic memory 모듈
   * @param {function} opts.onBatchReady - 메시지 배치 콜백 (PatternDetector로 전달)
   */
  constructor(opts = {}) {
    this.config = opts.config || {};
    this.episodic = opts.episodic || null;
    this.onBatchReady = opts.onBatchReady || null;

    // 채널 설정
    this.observeAll = (this.config.channels || ['*']).includes('*');
    this.includeChannels = new Set(this.config.channels || []);
    this.excludeChannels = new Set(this.config.excludeChannels || []);

    // 채널별 메시지 버퍼 (PatternDetector에 전달용)
    this.channelBuffers = new Map();  // channelId → [{ userId, text, ts }]
    this.batchSize = this.config.detection?.batchSize || 20;

    // 통계
    this.stats = { observed: 0, filtered: 0, batches: 0 };
  }

  /**
   * Slack 메시지 이벤트 수신 (slack.js에서 호출).
   *
   * @param {object} event - Slack message 이벤트
   */
  onMessage(event) {
    // ─── 필터링 ───
    if (!event || !event.channel || !event.text) { this.stats.filtered++; return; }
    if (event.bot_id || event.subtype) { this.stats.filtered++; return; }
    if (event.channel_type === 'im') { this.stats.filtered++; return; }  // DM 절대 관찰 안 함

    // 채널 허용 체크
    const ch = event.channel;
    if (this.excludeChannels.has(ch)) { this.stats.filtered++; return; }
    if (!this.observeAll && !this.includeChannels.has(ch)) { this.stats.filtered++; return; }

    // 텍스트 최소 길이 (이모지만, 단어 1개 등 필터)
    const text = event.text.trim();
    if (text.length < 5) { this.stats.filtered++; return; }

    this.stats.observed++;

    // ─── L2 Episodic 저장 (observed 모드) ───
    if (this.episodic) {
      try {
        const convKey = `observed:${ch}`;
        this.episodic.save(
          convKey,
          event.user || 'unknown',
          ch,
          event.thread_ts || null,
          'observed',  // role = 'observed' (기존 'user'/'assistant'와 구분)
          text,
          '',          // agentType 없음
          'passive',   // functionType = 'passive'
        ).catch(() => {});
      } catch (err) {
        log.debug('Episodic save failed for observed message', { error: err.message });
      }
    }

    // ─── 채널 버퍼에 추가 ───
    if (!this.channelBuffers.has(ch)) {
      this.channelBuffers.set(ch, []);
    }
    const buf = this.channelBuffers.get(ch);
    buf.push({
      userId: event.user || 'unknown',
      text,
      ts: event.ts || String(Date.now()),
      threadTs: event.thread_ts || null,
    });

    // 버퍼 크기 제한 (최근 100개만 유지)
    if (buf.length > 100) buf.splice(0, buf.length - 100);

    // 배치 트리거: batchSize 도달 시 PatternDetector에 전달
    if (buf.length >= this.batchSize && this.onBatchReady) {
      this.stats.batches++;
      const batch = buf.splice(0, this.batchSize);  // batchSize만큼만 추출
      try {
        this.onBatchReady(ch, batch);
      } catch (err) {
        log.warn('Batch callback error', { channel: ch, error: err.message });
      }
    }
  }

  /**
   * 채널 관찰 추가 (Change Control 승인 후 호출).
   */
  addChannel(channelId) {
    this.excludeChannels.delete(channelId);
    if (!this.observeAll) this.includeChannels.add(channelId);
    log.info('Channel observation added', { channel: channelId });
  }

  /**
   * 채널 관찰 제거 (Change Control 승인 후 호출).
   */
  removeChannel(channelId) {
    this.excludeChannels.add(channelId);
    this.includeChannels.delete(channelId);
    this.channelBuffers.delete(channelId);
    log.info('Channel observation removed', { channel: channelId });
  }

  /**
   * 특정 채널의 최근 메시지 버퍼 조회 (PatternDetector 수동 분석용).
   */
  getBuffer(channelId) {
    return this.channelBuffers.get(channelId) || [];
  }

  /**
   * 통계 조회.
   */
  getStats() {
    return {
      ...this.stats,
      channels: this.channelBuffers.size,
      bufferSizes: Object.fromEntries(
        [...this.channelBuffers.entries()].map(([ch, buf]) => [ch, buf.length])
      ),
    };
  }

  /**
   * 정리.
   */
  destroy() {
    this.channelBuffers.clear();
    this.stats = { observed: 0, filtered: 0, batches: 0 };
  }
}

module.exports = { PassiveListener };
