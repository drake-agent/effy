/**
 * smart-search.js — 스마트 검색 기능 모음.
 *
 * Gateway 파이프라인에서 에이전트 응답 전에 자동으로 실행되는 검색 기능:
 *
 * 1. Expert Finder: "이 주제를 누가 알아?" → Entity + Episodic 기반 전문가 추천
 * 2. Duplicate Detector: "이 질문 전에도 나왔어?" → L2/L3 유사도 검색
 * 3. File Finder: "이 파일 어디 있었지?" → L2 파일 첨부 이력 검색
 *
 * 각 기능은 독립적으로 사용 가능하며,
 * 에이전트의 system prompt에 <smart_context> 섹션으로 주입됩니다.
 */
const { createLogger } = require('../shared/logger');
const { sanitizeFtsQuery } = require('../shared/fts-sanitizer');

const log = createLogger('features:smart-search');

// ═══════════════════════════════════════════════════════
// 1. Expert Finder — "이 주제 누가 알아?"
// ═══════════════════════════════════════════════════════

/**
 * 특정 토픽에 대해 가장 많이 대화한 사용자를 찾는다.
 *
 * @param {string} query - 검색 키워드
 * @param {object} episodic - L2 Episodic memory
 * @param {object} entity - L4 Entity memory
 * @param {number} limit - 최대 결과 수
 * @returns {Array<{ userId, name, score, context }>}
 */
function findExperts(query, episodic, entity, limit = 3) {
  if (!query || !episodic) return [];

  try {
    const fts = sanitizeFtsQuery(query);
    if (fts.words.length < 2) return [];

    // L2에서 관련 대화 검색
    const results = episodic.search?.(fts.query, { limit: 30 }) || [];
    if (results.length === 0) return [];

    // 사용자별 관련도 집계
    const userScores = new Map();  // userId → { count, latestContent, latestDate }
    for (const r of results) {
      if (!r.user_id || r.role === 'assistant') continue;
      const existing = userScores.get(r.user_id) || { count: 0, latestContent: '', latestDate: '' };
      existing.count++;
      if (r.created_at > existing.latestDate) {
        existing.latestDate = r.created_at;
        existing.latestContent = r.content?.slice(0, 100) || '';
      }
      userScores.set(r.user_id, existing);
    }

    // 점수 순 정렬 + Entity 이름 조회
    return [...userScores.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, limit)
      .map(([userId, data]) => {
        const profile = entity?.get?.('user', userId);
        return {
          userId,
          name: profile?.name || userId,
          role: profile?.properties?.role || '',
          score: data.count,
          context: data.latestContent,
          when: data.latestDate,
        };
      });
  } catch (err) {
    log.debug('Expert finder error', { error: err.message });
    return [];
  }
}

// ═══════════════════════════════════════════════════════
// 2. Duplicate Question Detector — "이거 전에도 물어봤는데"
// ═══════════════════════════════════════════════════════

/**
 * 현재 질문과 유사한 과거 질문+답변을 찾는다.
 *
 * @param {string} question - 현재 질문 텍스트
 * @param {object} semantic - L3 Semantic memory
 * @param {object} episodic - L2 Episodic memory
 * @param {number} threshold - 유사도 임계값 (기본 3.0)
 * @returns {{ found: boolean, matches: Array<{ question, answer, channel, date }> }}
 */
function findDuplicateQuestions(question, semantic, episodic, threshold = 3.0) {
  if (!question || question.length < 10) return { found: false, matches: [] };

  try {
    const fts = sanitizeFtsQuery(question.slice(0, 100));
    if (fts.words.length < 2) return { found: false, matches: [] };

    const matches = [];

    // L3 Semantic 검색 (지식베이스에서)
    if (semantic) {
      const semResults = semantic.searchWithPools?.(fts.query, ['team'], 3) || [];
      for (const r of semResults) {
        if (r.score >= threshold) {
          matches.push({
            source: 'knowledge',
            content: r.content?.slice(0, 200),
            score: r.score,
            channel: r.channel_id || '',
          });
        }
      }
    }

    // L2 Episodic 검색 (과거 대화에서)
    if (episodic) {
      const epiResults = episodic.search?.(fts.query, { limit: 5 }) || [];
      for (const r of epiResults) {
        if (r.score >= threshold && r.role === 'assistant') {
          matches.push({
            source: 'conversation',
            content: r.content?.slice(0, 200),
            score: r.score,
            channel: r.channel_id || '',
            date: r.created_at || '',
          });
        }
      }
    }

    return {
      found: matches.length > 0,
      matches: matches.sort((a, b) => b.score - a.score).slice(0, 3),
    };
  } catch (err) {
    log.debug('Duplicate detector error', { error: err.message });
    return { found: false, matches: [] };
  }
}

// ═══════════════════════════════════════════════════════
// 3. File/Link Finder — "이 파일 어디 있었지?"
// ═══════════════════════════════════════════════════════

/**
 * 과거 대화에서 공유된 파일/링크를 검색.
 *
 * @param {string} query - 파일명 또는 키워드
 * @param {object} episodic - L2 Episodic memory
 * @returns {Array<{ filename, channel, date, snippet }>}
 */
function findFiles(query, episodic) {
  if (!query || !episodic) return [];

  try {
    const fts = sanitizeFtsQuery(query);
    if (fts.words.length < 1) return [];

    // L2에서 파일 관련 대화 검색
    // NOTE: FTS5는 한글 토크나이징이 제한적 → LIKE fallback으로 동작 가능
    const results = episodic.search?.(fts.query, { limit: 10 }) || [];

    const files = [];
    for (const r of results) {
      // "[첨부파일: filename.csv]" 패턴 추출
      const fileMatch = r.content?.match(/\[첨부파일:\s*([^\]]+)\]/);
      if (fileMatch) {
        files.push({
          filename: fileMatch[1].trim(),
          channel: r.channel_id || '',
          date: r.created_at || '',
          snippet: r.content?.slice(0, 150),
        });
      }
    }

    // URL 패턴도 같은 결과에서 추출 (R11-BUG-2: 중복 검색 제거)
    for (const r of results) {
      const urlMatch = r.content?.match(/https?:\/\/[^\s>]+/);
      if (urlMatch && !files.some(f => f.filename === urlMatch[0])) {
        files.push({
          filename: urlMatch[0],
          channel: r.channel_id || '',
          date: r.created_at || '',
          snippet: r.content?.slice(0, 150),
          type: 'link',
        });
      }
    }

    return files.slice(0, 5);
  } catch (err) {
    log.debug('File finder error', { error: err.message });
    return [];
  }
}

// ═══════════════════════════════════════════════════════
// 통합: 에이전트 컨텍스트에 스마트 검색 결과 주입
// ═══════════════════════════════════════════════════════

/**
 * 사용자 메시지를 분석하여 관련 스마트 검색을 실행하고,
 * 에이전트 컨텍스트에 주입할 텍스트를 생성.
 *
 * @param {string} text - 사용자 메시지
 * @param {object} deps - { episodic, semantic, entity }
 * @returns {string} XML 형태 스마트 컨텍스트 (빈 문자열이면 없음)
 */
function buildSmartContext(text, deps) {
  // R11-SEC-1: 짧은 메시지나 인사에서는 검색 안 함 (DB 부하 방지)
  if (!text || text.length < 20) return '';
  // 단순 인사/감사 패턴 스킵
  if (/^(안녕|hi|hello|thanks|감사|ㅎㅇ|ㅋㅋ|ㅇㅇ|ok|ㅇㅋ)/i.test(text.trim())) return '';

  const parts = [];

  // 질문인지 감지
  const isQuestion = /\?|어떻게|방법|누가|뭐|어디|왜|언제|how|what|who|where|why/i.test(text);

  if (isQuestion) {
    // 중복 질문 체크
    const dup = findDuplicateQuestions(text, deps.semantic, deps.episodic);
    if (dup.found) {
      parts.push('<previous_answers>');
      parts.push('이 질문과 유사한 이전 답변이 있습니다:');
      for (const m of dup.matches) {
        parts.push(`  - [${m.source}] ${m.content}`);
      }
      parts.push('이전 답변을 참고하되, 최신 정보가 있으면 업데이트하세요.');
      parts.push('</previous_answers>');
    }

    // 전문가 추천
    const experts = findExperts(text, deps.episodic, deps.entity);
    if (experts.length > 0) {
      parts.push('<relevant_experts>');
      parts.push('이 주제에 대해 팀에서 가장 잘 아는 사람:');
      for (const e of experts) {
        parts.push(`  - ${e.name} (${e.role}) — ${e.score}건 관련 대화, 최근: "${e.context}"`);
      }
      parts.push('</relevant_experts>');
    }
  }

  // 파일 관련 질문 감지
  if (/파일|file|csv|문서|doc|링크|link|url|어디/i.test(text)) {
    const files = findFiles(text, deps.episodic);
    if (files.length > 0) {
      parts.push('<found_files>');
      parts.push('관련 파일/링크가 과거 대화에서 발견되었습니다:');
      for (const f of files) {
        const ch = f.channel ? `<#${f.channel}>` : '';
        parts.push(`  - ${f.filename} ${ch} (${f.date})`);
      }
      parts.push('</found_files>');
    }
  }

  return parts.join('\n');
}

const HELP_ENTRY = {
  icon: '🔍',
  title: '전문가 찾기 & 중복 질문 감지',
  lines: [
    '"이거 누가 잘 알아?" → 대화 히스토리를 분석해서 전문가를 찾아드립니다.',
    '"이거 전에도 물어봤는데..." → 유사 질문을 자동으로 찾아 연결해드립니다.',
  ],
  order: 20,
};

module.exports = {
  findExperts,
  findDuplicateQuestions,
  findFiles,
  buildSmartContext,
  HELP_ENTRY,
};
