/**
 * observer/index.js — Ambient Intelligence Orchestrator.
 *
 * Layer 0~4를 조립하고 생명주기를 관리.
 * Gateway 부팅 시 init(), 종료 시 destroy() 호출.
 *
 * 주기적 처리 루프:
 * - PassiveListener가 배치 트리거 → PatternDetector.analyze()
 * - 주기적 타이머(intervalMs)로도 ProactiveEngine.process() 실행
 * - Change Control이 CRITICAL/HIGH 변경을 게이팅
 */
const { PassiveListener } = require('./passive-listener');
const { PatternDetector } = require('./pattern-detector');
const { InsightStore } = require('./insight-store');
const { ProactiveEngine } = require('./proactive-engine');
const { FeedbackLoop } = require('./feedback-loop');
const { createLogger } = require('../shared/logger');

const log = createLogger('observer');

let _instance = null;

class Observer {
  constructor() {
    this.listener = null;
    this.detector = null;
    this.insightStore = null;
    this.proactive = null;
    this.feedback = null;
    this._timer = null;
    this._initialized = false;
  }

  /**
   * 초기화.
   *
   * @param {object} opts
   * @param {object} opts.config - config.observer 섹션
   * @param {object} opts.episodic - episodic memory 모듈
   * @param {object} opts.semantic - semantic memory 모듈
   * @param {object} opts.graph - MemoryGraph 인스턴스
   * @param {object} opts.slackClient - Slack WebClient
   */
  init(opts = {}) {
    const observerConfig = opts.config || {};
    if (observerConfig.enabled === false) {
      log.info('Observer disabled by config');
      return;
    }

    // Layer 2: Insight Store
    this.insightStore = new InsightStore({
      graph: opts.graph,
      ttlMs: observerConfig.feedback?.autoExpireMs,
    });

    // Layer 4: Feedback Loop
    this.feedback = new FeedbackLoop({
      insightStore: this.insightStore,
      dismissThreshold: observerConfig.feedback?.dismissThreshold,
    });

    // Layer 1: Pattern Detector
    this.detector = new PatternDetector({
      insightStore: this.insightStore,
      config: observerConfig.detection,
    });

    // Layer 0: Passive Listener
    this.listener = new PassiveListener({
      config: observerConfig,
      episodic: opts.episodic,
      onBatchReady: (channelId, batch) => {
        // 비활성화된 패턴 제외하고 분석
        if (this.detector) {
          this.detector.analyze(channelId, batch);
        }
      },
    });

    // Layer 3: Proactive Engine
    this.proactive = new ProactiveEngine({
      config: observerConfig.proactive,
      insightStore: this.insightStore,
      slackClient: opts.slackClient,
      semantic: opts.semantic,
    });

    // 주기적 처리 루프
    const intervalMs = observerConfig.detection?.intervalMs || 300000;  // 5분
    this._timer = setInterval(() => {
      this.proactive.process().catch(err => {
        log.warn('Proactive processing error', { error: err.message });
      });
    }, intervalMs);

    this._initialized = true;
    log.info('Observer initialized', {
      channels: observerConfig.channels || ['*'],
      interval: `${intervalMs / 1000}s`,
      defaultLevel: observerConfig.proactive?.defaultLevel || 1,
    });
  }

  /**
   * Slack message 이벤트를 PassiveListener로 전달.
   * slack.js adapter에서 호출.
   */
  onMessage(event) {
    if (!this._initialized || !this.listener) return;
    this.listener.onMessage(event);
  }

  /**
   * 사용자 피드백 처리 (👍/👎 리액션).
   *
   * @param {string} reaction - 'thumbsup' | 'thumbsdown'
   * @param {string} insightId
   * @returns {object}
   */
  handleFeedback(reaction, insightId) {
    if (!this.feedback) return { success: false, error: 'Observer not initialized' };

    if (reaction === 'thumbsup' || reaction === '+1') {
      return this.feedback.accept(insightId);
    }
    if (reaction === 'thumbsdown' || reaction === '-1') {
      return this.feedback.dismiss(insightId);
    }
    return { success: false, error: `Unknown reaction: ${reaction}` };
  }

  /**
   * 전체 통계.
   */
  getStats() {
    return {
      initialized: this._initialized,
      listener: this.listener?.getStats(),
      detector: this.detector?.getStats(),
      insights: this.insightStore?.getStats(),
      proactive: this.proactive?.getStats(),
      feedback: this.feedback?.getStats(),
    };
  }

  /**
   * 정리.
   */
  destroy() {
    if (this._timer) clearInterval(this._timer);
    if (this.listener) this.listener.destroy();
    this._initialized = false;
    log.info('Observer destroyed');
  }
}

/**
 * 싱글톤 getter.
 */
function getObserver() {
  if (!_instance) _instance = new Observer();
  return _instance;
}

module.exports = { Observer, getObserver };
