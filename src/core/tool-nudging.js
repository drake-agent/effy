/**
 * tool-nudging.js — 사용자 메시지 분석 → 관련 도구 프로액티브 제안.
 *
 * User message analysis → proactive relevant tool suggestions.
 */

const { createLogger } = require('../shared/logger');
const { config } = require('../config');

class ToolNudgingEngine {
  /**
   * 초기화 — 도구 제안 엔진 구성
   * Initialize - tool suggestion engine configuration
   *
   * @param {Object} opts - 옵션 / Options
   * @param {string} [opts.policy] - 정책 ('aggressive', 'moderate', 'passive', 'off') / Policy mode
   */
  constructor(opts = {}) {
    this.log = createLogger('ToolNudgingEngine');

    const policyName = opts.policy ?? config.nudge?.policy ?? 'moderate';
    this.policy = new ToolNudgePolicy(policyName);

    // 패턴 매칭을 위한 키워드 맵 / Keyword patterns for matching
    this.patterns = {
      fileRead: {
        keywords: ['파일', 'file', '읽', 'read', '확인', 'check', '.csv', '.json', '.txt', '.md'],
        confidence: 0.7
      },
      fileWrite: {
        keywords: ['파일', 'file', '쓰', 'write', '저장', 'save', '만들', 'create', '.csv', '.json'],
        confidence: 0.75
      },
      webSearch: {
        keywords: ['찾', 'search', '검색', 'find', 'url', 'http', 'https', '웹', 'web', 'google'],
        confidence: 0.6
      },
      shellExecute: {
        keywords: ['터미널', 'shell', 'command', '명령', 'bash', 'sh', 'deploy', '배포', 'run'],
        confidence: 0.65
      },
      searchKnowledge: {
        keywords: ['검색', 'search', '찾', 'find', '코드', 'code', 'bug', '버그', 'pr', 'merge'],
        confidence: 0.55
      },
      taskCreate: {
        keywords: ['할일', '해야할', 'todo', 'task', 'deadline', '기한', '마감', '완료', 'complete'],
        confidence: 0.68
      },
      taskList: {
        keywords: ['할일', '해야할', 'todo', 'task', '목록', 'list', '보기', 'show'],
        confidence: 0.65
      },
      saveKnowledge: {
        keywords: ['기억해', '저장', 'save', 'remember', 'keep', '보관', 'store', 'note'],
        confidence: 0.7
      },
      cronSchedule: {
        keywords: ['매일', '크론', 'cron', 'schedule', '매주', 'weekly', 'daily', '예약', 'recurring'],
        confidence: 0.72
      },
      webBrowser: {
        keywords: ['사이트', 'website', 'browse', 'click', 'page', '페이지', 'url', 'http'],
        confidence: 0.6
      }
    };

    this.log.info('ToolNudgingEngine initialized', {
      policy: this.policy.mode,
      patterns: Object.keys(this.patterns).length
    });
  }

  /**
   * 사용자 메시지 분석 및 도구 제안
   * Analyze message and suggest relevant tools
   *
   * @param {string} message - 사용자 메시지 / User message
   * @param {Object[]} availableTools - 사용 가능한 도구 배열 / Available tools
   * @param {string} availableTools[].name - 도구 이름 / Tool name
   * @param {string} [availableTools[].description] - 도구 설명 / Tool description
   * @returns {Object[]} 제안된 도구 배열 / Suggested tools with confidence scores
   * @returns {string} [].toolName - 도구 이름
   * @returns {number} [].confidence - 신뢰도 점수 (0-1) / Confidence score
   * @returns {string} [].reason - 제안 이유 / Reason for suggestion
   */
  analyzeAndSuggest(message, availableTools = []) {
    try {
      if (!message || typeof message !== 'string') {
        this.log.warn('Invalid message for tool nudging', { type: typeof message });
        return [];
      }

      const normalizedMsg = message.toLowerCase();
      const suggestions = [];
      const matchedPatterns = new Map();

      // 각 패턴에 대해 메시지 검사 / Scan message against each pattern
      for (const [toolName, pattern] of Object.entries(this.patterns)) {
        let matchCount = 0;
        const matchedKeywords = [];

        // 키워드 매칭 / Match keywords
        for (const kw of pattern.keywords) {
          if (normalizedMsg.includes(kw.toLowerCase())) {
            matchCount++;
            matchedKeywords.push(kw);
          }
        }

        // 매치 점수 계산 / Calculate match score
        if (matchCount > 0) {
          // 매치 개수에 기반한 신뢰도 가중치 / Boost confidence with multiple matches
          const matchBoost = Math.min(matchCount * 0.1, 0.3);
          const confidence = Math.min(pattern.confidence + matchBoost, 0.99);

          matchedPatterns.set(toolName, {
            confidence,
            matchCount,
            keywords: matchedKeywords
          });
        }
      }

      // 정책에 따라 필터링 / Filter by policy thresholds
      const threshold = this.policy.getThreshold();
      for (const [toolName, match] of matchedPatterns.entries()) {
        if (match.confidence >= threshold) {
          suggestions.push({
            toolName,
            confidence: Math.round(match.confidence * 100) / 100,
            reason: `Matched keywords: ${match.keywords.slice(0, 3).join(', ')}`
          });
        }
      }

      // 신뢰도 내림차순 정렬 / Sort by confidence descending
      suggestions.sort((a, b) => b.confidence - a.confidence);

      this.log.debug('Tools analyzed', {
        messageLength: message.length,
        suggestionCount: suggestions.length,
        policy: this.policy.mode
      });

      return suggestions;
    } catch (err) {
      this.log.error('Error analyzing message for tool nudging', err);
      return [];
    }
  }

  /**
   * 제안된 도구들을 인간-친화적 문자열로 포맷
   * Format suggestions as human-readable Korean string
   *
   * @param {Object[]} suggestions - 제안 배열 / Suggestions array
   * @returns {string} 포맷된 제안 문자열 / Formatted suggestion string
   */
  formatSuggestion(suggestions) {
    try {
      if (!suggestions || suggestions.length === 0) {
        return '';
      }

      const toolLabels = {
        fileRead: '파일 읽기',
        fileWrite: '파일 쓰기',
        webSearch: '웹 검색',
        shellExecute: '터미널 명령',
        searchKnowledge: '지식 검색',
        taskCreate: '할일 생성',
        taskList: '할일 목록',
        saveKnowledge: '지식 저장',
        cronSchedule: '스케줄 설정',
        webBrowser: '웹 브라우저'
      };

      const parts = suggestions.slice(0, 3).map(s => {
        const label = toolLabels[s.toolName] || s.toolName;
        const confidence = Math.round(s.confidence * 100);
        return `• ${label} (${confidence}%)`;
      });

      return `다음 도구를 사용하시는 것을 추천드립니다:\n${parts.join('\n')}`;
    } catch (err) {
      this.log.error('Error formatting suggestion', err);
      return '';
    }
  }

  /**
   * 정책 변경
   * Change nudging policy
   *
   * @param {'aggressive'|'moderate'|'passive'|'off'} mode - 새로운 정책 모드 / New policy mode
   */
  setPolicy(mode) {
    try {
      this.policy = new ToolNudgePolicy(mode);
      this.log.info('Policy changed', { mode });
    } catch (err) {
      this.log.error('Error changing policy', err);
    }
  }

  /**
   * 현재 정책 조회
   * Get current policy
   *
   * @returns {string} 정책 모드 / Policy mode
   */
  getPolicy() {
    return this.policy.mode;
  }
}

/**
 * 도구 제안 정책 컨트롤러
 * Tool Nudge Policy controller
 */
class ToolNudgePolicy {
  /**
   * @param {'aggressive'|'moderate'|'passive'|'off'} mode - 정책 모드 / Policy mode
   */
  constructor(mode = 'moderate') {
    const validModes = ['aggressive', 'moderate', 'passive', 'off'];

    if (!validModes.includes(mode)) {
      throw new Error(`Invalid tool nudge policy mode: ${mode}. Must be one of: ${validModes.join(', ')}`);
    }

    this.mode = mode;

    // 정책별 신뢰도 임계값 / Confidence thresholds per policy
    this.thresholds = {
      aggressive: 0.3,  // 약한 매치도 제안
      moderate: 0.6,    // 중간 매치 이상 제안
      passive: 0.8,     // 강한 매치만 제안
      off: 1.0          // 제안 안 함
    };
  }

  /**
   * 현재 정책의 신뢰도 임계값 반환
   * Get confidence threshold for current policy
   *
   * @returns {number} 임계값 (0-1) / Threshold
   */
  getThreshold() {
    return this.thresholds[this.mode] ?? 0.6;
  }

  /**
   * 정책 설명
   * Get policy description
   *
   * @returns {string} 설명 / Description
   */
  describe() {
    const descriptions = {
      aggressive: 'Suggest on any pattern match (confidence >= 30%)',
      moderate: 'Suggest on strong matches (confidence >= 60%)',
      passive: 'Only suggest explicit mentions (confidence >= 80%)',
      off: 'Never suggest tools'
    };
    return descriptions[this.mode] || 'Unknown policy';
  }
}

module.exports = { ToolNudgingEngine, ToolNudgePolicy };
