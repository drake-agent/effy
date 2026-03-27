/**
 * compaction.js — Context Compaction Engine (v4 Port).
 *
 * 컨텍스트가 80% 초과 시 배경 압축 실행.
 * 1. 오래된 턴을 Haiku로 요약
 * 2. 결정사항/사실 추출 → Memory Graph에 저장
 * 3. 요약 + 최근 N턴으로 교체
 *
 * v3.5 통합: WorkingMemory의 messages 배열에 대해 동작.
 */
const { EventEmitter } = require('events');
const { estimateTokens: estimateTokensUtil } = require('../shared/utils');
const { createLogger } = require('../shared/logger');

const log = createLogger('memory:compaction');

class CompactionEngine extends EventEmitter {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.threshold=0.8] - 압축 트리거 임계값 (0.0~1.0)
   * @param {number} [opts.keepRecentTurns=10] - 보관할 최근 턴 수
   * @param {number} [opts.maxSummaryTokens=500] - 요약 최대 토큰
   * @param {Object} [opts.graph] - DI-1: MemoryGraph 인스턴스 주입 (싱글톤 공유)
   */
  constructor(opts = {}) {
    super();
    // R4-BUG-1 fix: || → ?? — 명시적 0 설정이 falsy로 무시되는 문제 방지
    this.threshold = opts.threshold ?? 0.8;
    this.keepRecentTurns = opts.keepRecentTurns ?? 10;
    this.maxSummaryTokens = opts.maxSummaryTokens ?? 500;
    // DI-1: 외부 주입 또는 lazy require (순환 참조 방지)
    this.graph = opts.graph || null;

    // v3.8: 3-tier compaction strategy
    this.tierThresholds = {
      background: opts.backgroundThreshold ?? 0.80,   // Tier 1: 배경 압축
      aggressive: opts.aggressiveThreshold ?? 0.85,    // Tier 2: 적극적 압축
      emergency: opts.emergencyThreshold ?? 0.95,      // Tier 3: 긴급 절단
    };
    this.emergencyKeepTurns = opts.emergencyKeepTurns ?? 5;
  }

  /**
   * 컨텍스트 크기 체크 → 압축 필요 여부.
   * @param {Array<Object>} messages - { role, content }
   * @param {number} contextLimit - 토큰 한도
   * @returns {boolean}
   */
  needsCompaction(messages, contextLimit) {
    if (!Array.isArray(messages) || messages.length === 0) return false;

    try {
      // HI-1 fix: utils.estimateTokens()를 단일 소스로 사용
      let totalTokens = 0;
      for (const msg of messages) {
        totalTokens += 4; // role overhead
        totalTokens += estimateTokensUtil(msg.content || '');
      }

      const usageRatio = totalTokens / contextLimit;
      const needs = usageRatio >= this.threshold;

      log.debug('Compaction check', {
        tokens: totalTokens,
        limit: contextLimit,
        ratio: parseFloat(usageRatio.toFixed(3)),
        needed: needs,
      });

      return needs;
    } catch (err) {
      log.error('Compaction check failed', { error: err.message });
      return false;
    }
  }

  /**
   * 3-tier 압축 등급 판정.
   * - background (80%): 일반 요약 압축
   * - aggressive (85%): 적극적 압축 (keepRecent 절반)
   * - emergency (95%): 긴급 절단 (최근 5턴만 유지, 요약 없이)
   * - none: 압축 불필요
   *
   * @param {Array<Object>} messages
   * @param {number} contextLimit
   * @returns {{ tier: string, usageRatio: number, action: string }}
   */
  getCompactionTier(messages, contextLimit) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return { tier: 'none', usageRatio: 0, action: 'none' };
    }

    try {
      let totalTokens = 0;
      for (const msg of messages) {
        totalTokens += 4;
        totalTokens += estimateTokensUtil(msg.content || '');
      }
      const usageRatio = totalTokens / contextLimit;

      if (usageRatio >= this.tierThresholds.emergency) {
        return { tier: 'emergency', usageRatio, action: `긴급 절단: 최근 ${this.emergencyKeepTurns}턴만 유지` };
      }
      if (usageRatio >= this.tierThresholds.aggressive) {
        return { tier: 'aggressive', usageRatio, action: `적극적 압축: 최근 ${Math.floor(this.keepRecentTurns / 2)}턴 유지` };
      }
      if (usageRatio >= this.tierThresholds.background) {
        return { tier: 'background', usageRatio, action: `배경 압축: 최근 ${this.keepRecentTurns}턴 유지` };
      }

      return { tier: 'none', usageRatio, action: 'none' };
    } catch (err) {
      log.error('Tier check failed', { error: err.message });
      return { tier: 'none', usageRatio: 0, action: 'error' };
    }
  }

  /**
   * 3-tier 압축 실행 (tier에 따라 전략 변경).
   * @param {Array<Object>} messages
   * @param {Object} anthropicClient
   * @param {string} model
   * @param {number} contextLimit
   * @param {Object} [context]
   * @returns {Promise<Object>}
   */
  async compactByTier(messages, anthropicClient, model, contextLimit, context = {}) {
    const { tier, usageRatio } = this.getCompactionTier(messages, contextLimit);

    log.info('Tiered compaction', { tier, usageRatio: parseFloat(usageRatio.toFixed(3)) });

    if (tier === 'none') {
      return { tier, summary: '', extractedMemories: [], keptMessages: messages };
    }

    if (tier === 'emergency') {
      // Emergency: 즉시 절단, LLM 호출 없이
      const keptMessages = messages.slice(-this.emergencyKeepTurns);
      const removedTurns = messages.length - keptMessages.length;
      log.warn('Emergency truncation', {
        original: messages.length,
        kept: keptMessages.length,
        dropped: removedTurns,
      });

      // Emit emergency compaction event
      this.emit('compaction:complete', {
        tier: 'emergency',
        removedTurns,
        summaryTokens: 50, // Emergency truncation has minimal summary
        timestamp: Date.now(),
      });

      return { tier, summary: '[Emergency truncation — context limit exceeded]', extractedMemories: [], keptMessages };
    }

    if (tier === 'aggressive') {
      // Aggressive: keepRecent 절반으로 줄여서 압축
      const origKeep = this.keepRecentTurns;
      this.keepRecentTurns = Math.floor(origKeep / 2);
      try {
        const result = await this.compact(messages, anthropicClient, model, { ...context, tier: 'aggressive' });
        return { tier, ...result };
      } finally {
        this.keepRecentTurns = origKeep;
      }
    }

    // Background: 일반 압축
    const result = await this.compact(messages, anthropicClient, model, { ...context, tier: 'background' });
    return { tier, ...result };
  }

  /**
   * 대화 압축 실행.
   *
   * @param {Array<Object>} messages - Messages to compact
   * @param {Object} anthropicClient - Anthropic SDK client
   * @param {string} model - Summarization model (e.g., haiku)
   * @param {Object} [context] - { channelId, userId } for graph storage
   * @returns {Promise<Object>} { summary, extractedMemories, keptMessages }
   */
  async compact(messages, anthropicClient, model, context = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return { summary: '', extractedMemories: [], keptMessages: messages };
    }

    try {
      const cutoffIndex = Math.max(0, messages.length - this.keepRecentTurns);
      const oldMessages = messages.slice(0, cutoffIndex);
      const keptMessages = messages.slice(cutoffIndex);

      if (oldMessages.length === 0) {
        log.debug('No old messages to compact');
        return { summary: '', extractedMemories: [], keptMessages: messages };
      }

      const conversationText = oldMessages
        .map(msg => `${msg.role}: ${msg.content}`)
        .join('\n');

      // R3-PERF-1 fix: 독립적인 LLM 호출 병렬화 — 압축 지연 ~50% 절감
      const [summary, extractedMemories] = await Promise.all([
        this._summarize(conversationText, anthropicClient, model),
        this._extractMemories(conversationText, anthropicClient, model),
      ]);

      // 3. 추출된 메모리를 그래프에 저장 (DI-1: lazy require)
      if (!this.graph) {
        const { MemoryGraph } = require('./graph');
        this.graph = new MemoryGraph();
      }
      for (const memory of extractedMemories) {
        try {
          this.graph.create({
            ...memory,
            sourceChannel: context.channelId || '',
            sourceUser: context.userId || '',
          });
        } catch (err) {
          log.warn('Failed to save extracted memory', { error: err.message, type: memory.type });
        }
      }

      log.info('Compaction completed', {
        original: messages.length,
        compacted: oldMessages.length,
        kept: keptMessages.length,
        summaryLen: summary.length,
        memories: extractedMemories.length,
      });

      // Emit compaction:complete event with statistics
      const summaryTokens = Math.ceil(summary.length / 4); // Rough token estimate
      // Determine which tier was used based on context
      const tier = context.tier || 'background';
      this.emit('compaction:complete', {
        tier,
        removedTurns: oldMessages.length,
        summaryTokens,
        timestamp: Date.now(),
      });

      return { summary, extractedMemories, keptMessages };
    } catch (err) {
      log.error('Compaction failed', { error: err.message });
      return { summary: '', extractedMemories: [], keptMessages: messages };
    }
  }

  /**
   * @private
   * PERF-9: Add timeout wrapper around LLM calls to prevent indefinite hangs.
   */
  async _summarize(conversationText, anthropicClient, model) {
    try {
      const timeoutMs = 30000;  // 30-second timeout
      const summarizePromise = anthropicClient.messages.create({
        model,
        max_tokens: this.maxSummaryTokens,
        system: 'You are a concise summarizer. Summarize the conversation in bullet points, focusing on key decisions, questions, and important facts. Keep it brief and factual.',
        messages: [{ role: 'user', content: `Summarize this conversation:\n\n${conversationText}` }],
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Summarization timeout (30s)')), timeoutMs)
      );

      const response = await Promise.race([summarizePromise, timeoutPromise]);

      const summary = response.content[0]?.type === 'text' ? response.content[0].text : '';
      log.debug('Conversation summarized', { originalLen: conversationText.length, summaryLen: summary.length });
      return summary;
    } catch (err) {
      log.error('Summarization failed', { error: err.message });
      return '';
    }
  }

  /**
   * @private
   * PERF-9: Add timeout wrapper around LLM calls to prevent indefinite hangs.
   */
  async _extractMemories(conversationText, anthropicClient, model) {
    try {
      const timeoutMs = 30000;  // 30-second timeout
      const extractPromise = anthropicClient.messages.create({
        model,
        max_tokens: 2000,
        system: `Extract structured memories from the conversation. Return a JSON array:
[{ "type": "fact|decision|observation|event", "content": "specific memory", "importance": 0.0-1.0 }]
Guidelines:
- "decision": Explicit decisions made
- "fact": Important factual statements
- "observation": Insights about the situation
- "event": Significant events or milestones
- Keep content under 200 characters
- Only include memories important for future context
Return ONLY valid JSON array, no additional text.`,
        messages: [{ role: 'user', content: `Extract memories:\n\n${conversationText}` }],
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Memory extraction timeout (30s)')), timeoutMs)
      );

      const response = await Promise.race([extractPromise, timeoutPromise]);

      const responseText = response.content[0]?.type === 'text' ? response.content[0].text : '[]';

      // CR-2 fix: JSON 추출 (마크다운 코드 블록 + 배열 경계 처리) + 명시적 파싱 방어
      let jsonStr = responseText.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      }
      // 코드 블록이 없으면 첫 [ ~ 마지막 ] 범위 추출 시도
      if (!codeBlockMatch) {
        const arrayStart = jsonStr.indexOf('[');
        const arrayEnd = jsonStr.lastIndexOf(']');
        if (arrayStart !== -1 && arrayEnd > arrayStart) {
          jsonStr = jsonStr.substring(arrayStart, arrayEnd + 1);
        }
      }

      let memories;
      try {
        memories = JSON.parse(jsonStr);
      } catch (parseErr) {
        log.warn('Memory extraction JSON parse failed, attempting regex fallback', {
          error: parseErr.message,
          responseLen: responseText.length,
        });
        // Fallback: 개별 JSON 객체 추출 — SEC-5 fix: limit input size + use bounded quantifier
        memories = [];
        const safeText = responseText.length > 10000 ? responseText.slice(0, 10000) : responseText;
        const objPattern = /\{[^{}]{1,500}"type"\s*:\s*"[^"]{1,50}"\s*,[^{}]{0,500}"content"\s*:\s*"[^"]{1,200}"\s*[^{}]{0,200}\}/g;
        let match;
        while ((match = objPattern.exec(safeText)) !== null) {
          try { memories.push(JSON.parse(match[0])); } catch (_) {}
        }
      }

      if (!Array.isArray(memories)) {
        log.warn('[compaction] extractMemories: LLM returned non-array. Skipping.', { type: typeof memories });
        return [];
      }

      memories = memories.filter(m => m && typeof m === 'object' && typeof m.content === 'string' && m.content.length > 0);

      const validMemories = memories
        .filter(m =>
          m.type &&
          ['fact', 'decision', 'observation', 'event'].includes(m.type) &&
          m.content &&
          m.content.length > 0 &&
          m.content.length <= 500
        )
        .map(m => ({
          type: m.type,
          content: m.content.trim(),
          importance: Math.min(Math.max(m.importance || 0.5, 0), 1),
          metadata: m.metadata || {},
        }));

      log.info('Memories extracted', { total: memories.length, valid: validMemories.length });
      return validMemories;
    } catch (err) {
      log.error('Memory extraction failed', { error: err.message });
      return [];
    }
  }

  /**
   * 설정 업데이트.
   * @param {Object} opts
   */
  updateConfig(opts = {}) {
    if (opts.threshold !== undefined) this.threshold = opts.threshold;
    if (opts.keepRecentTurns !== undefined) this.keepRecentTurns = opts.keepRecentTurns;
    if (opts.maxSummaryTokens !== undefined) this.maxSummaryTokens = opts.maxSummaryTokens;
    log.info('Compaction config updated', { threshold: this.threshold, keepRecentTurns: this.keepRecentTurns });
  }
}

module.exports = { CompactionEngine };
