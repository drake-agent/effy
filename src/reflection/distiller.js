/**
 * distiller.js — NightlyDistiller: 주기적 메모리 증류 엔진.
 *
 * 설계 도면 Layer 3 (PROMOTE) 차용:
 * - Nightly Distillation: daily L2 에피소딕 → L3 시맨틱 승격 판단
 * - Anti-Bloat: 상한 초과 시 자동 아카이브 (결정사항 제외)
 *
 * BUG-2 fix: schedule() 중복 호출 방어 + _running 안전성 강화
 * SEC-2 fix: LLM 추출 콘텐츠 sanitizeForPrompt 처리
 */
const { config } = require('../config');
const { client } = require('../shared/anthropic');
const { createLogger } = require('../shared/logger');
const { sanitizeForPrompt, validateSchema } = require('./sanitize');
// Self-improving: delegation pattern analysis uses episodic_memory directly
// const { getDelegationTracer } = require('../agents/delegation-tracer');

const log = createLogger('reflection:distiller');

// ─── LLM 후보 스키마 (SEC-2 fix: 화이트리스트 검증) ───
const CANDIDATE_SCHEMA = {
  content: 'string',
  reason: 'string',
  memoryType: 'string',
  tags: 'array',
  pool: 'string',
};
const CANDIDATE_DEFAULTS = { content: '', reason: '', memoryType: 'Fact', tags: [], pool: 'team' };
const VALID_MEMORY_TYPES = ['Decision', 'Fact', 'Observation', 'Goal', 'Preference', 'Event'];

class NightlyDistiller {
  constructor({ semantic, episodic, entity, committee, config: distillConfig = {} }) {
    this.semantic = semantic;
    this.episodic = episodic;
    this.entity = entity;
    this.committee = committee || null;

    this.maxDailyPromotions = distillConfig.maxDailyPromotions ?? 10;
    this.maxSemanticEntries = distillConfig.maxSemanticEntries ?? 500;
    this.archiveDays = distillConfig.archiveDays ?? 90;
    this.distillModel = distillConfig.model || config.anthropic?.defaultModel || 'claude-haiku-4-5-20251001';

    // BUG-2 fix: 단일 타이머 보장
    this._timer = null;
    this._running = false;
  }

  // ═══════════════════════════════════════════════════════
  // Nightly Distillation
  // ═══════════════════════════════════════════════════════

  async runDaily() {
    if (this._running) {
      log.warn('Distillation already running, skipping');
      return { promotions: 0, archived: 0, skipped: true };
    }

    this._running = true;
    const startMs = Date.now();
    let promotionCount = 0;
    let archivedCount = 0;

    try {
      log.info('Nightly distillation started');

      const recentMessages = this._getRecentEpisodic(24);
      if (recentMessages.length < 5) {
        log.info('Not enough messages for distillation');
        return { promotions: 0, archived: 0, skipped: true };
      }

      const candidates = await this._extractCandidates(recentMessages);

      // R3-ARCH-3: partial failure tracking
      let skipped = 0;
      let failed = 0;

      for (const candidate of candidates.slice(0, this.maxDailyPromotions)) {
        if (await this._isDuplicate(candidate.content)) { skipped++; continue; }

        // Committee 투표 경유
        let shouldPromote = true;
        if (this.committee?.enabled) {
          try {
            const result = await this.committee.proposeAndVote({
              title: `Nightly Promotion: ${candidate.content.slice(0, 80)}`,
              description: candidate.content,
              type: 'lesson_promotion',
              proposedBy: 'distiller',
            });

            // BUG-3 fix: 유효 투표 수 체크 — 전부 실패(defer)면 승격하지 않음
            const hasRealVotes = result.votes?.some(v => v.vote !== 'defer' || !v.reasoning?.startsWith('투표 실패'));
            shouldPromote = (result.status === 'approved' || result.status === 'auto_approved') && hasRealVotes !== false;

            if (!shouldPromote) {
              skipped++;
              log.info(`Committee ${result.status}: "${candidate.content.slice(0, 50)}..."`);
            }
          } catch (committeeErr) {
            log.warn(`Committee vote failed, auto-approving: ${committeeErr.message}`);
          }
        }

        if (!shouldPromote) continue;

        // R3-ARCH-3: individual save wrapped in try/catch
        try {
          await this.semantic.save({
            // SEC-2 fix: 콘텐츠 sanitize 후 저장
            content: sanitizeForPrompt(candidate.content, 500),
            sourceType: 'distillation',
            channelId: candidate.channelId || null,
            userId: candidate.userId || null,
            tags: candidate.tags || [],
            promotionReason: `Nightly distillation: ${candidate.reason}`,
            poolId: candidate.pool || 'team',
            memoryType: candidate.memoryType || 'Fact',
          });
          promotionCount++;
        } catch (err) {
          failed++;
          log.warn(`Distillation save failed: ${err.message}`);
        }
      }

      // ─── Self-improving: 위임 패턴 분석 → Lesson 승격 ───
      const delegationLessons = await this._extractDelegationPatterns();
      promotionCount += delegationLessons;

      archivedCount = this._enforceGlobalAntiBloat();

      const durationMs = Date.now() - startMs;
      log.info(`Nightly distillation complete: ${promotionCount} promotions, ${archivedCount} archived, ${skipped} skipped, ${failed} failed (${durationMs}ms)`);

      return { promotions: promotionCount, archived: archivedCount, skipped: skipped, failed };
    } catch (err) {
      log.error(`Nightly distillation error: ${err.message}`);
      return { promotions: 0, archived: 0, skipped: false };
    } finally {
      this._running = false;
    }
  }

  /** @private */
  async _getRecentEpisodic(hours = 24) {
    try {
      const { getDb } = require('../db');
      const db = getDb();
      const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      return await db.prepare(`
        SELECT conversation_key, user_id, channel_id, role, content, agent_type, function_type, created_at
        FROM episodic_memory WHERE created_at > ? ORDER BY created_at ASC LIMIT 500
      `).all(since);
    } catch (err) {
      log.warn(`Episodic query failed: ${err.message}`);
      return [];
    }
  }

  /**
   * LLM 추출 + SEC-2 fix: 스키마 검증 + sanitize.
   * @private
   */
  async _extractCandidates(messages) {
    const sessions = new Map();
    for (const msg of messages) {
      const key = msg.conversation_key;
      if (!sessions.has(key)) sessions.set(key, []);
      sessions.get(key).push(msg);
    }

    const summaries = [];
    for (const [key, msgs] of sessions) {
      if (msgs.length < 2) continue;
      const text = msgs.map(m => `[${m.role}] ${(m.content || '').slice(0, 200)}`).join('\n');
      summaries.push({ key, text: text.slice(0, 1500), channelId: msgs[0].channel_id, userId: msgs[0].user_id });
    }

    if (summaries.length === 0) return [];

    const inputText = summaries.map((s, i) => `--- 세션 ${i + 1} ---\n${s.text}`).join('\n\n');

    try {
      const response = await client.messages.create({
        model: this.distillModel,
        max_tokens: 1000,
        system: `오늘 Effy 에이전트 대화에서 장기 보존 가치가 있는 지식을 추출하세요.

승격 기준: ① 결정사항 ② 반복 참조 토픽 ③ 아키텍처/정책/프로세스 ④ 실수→교정 교훈
추출하지 않는 것: 인사/잡담, 일회성 질문, 기존 사실 반복

출력: JSON 배열 [{ "content": "지식", "reason": "기준①~④", "memoryType": "Decision|Fact|Observation|Goal", "tags": [], "pool": "team" }]
없으면 []`,
        messages: [{ role: 'user', content: inputText.slice(0, 6000) }],
      });

      const text = response.content[0]?.text || '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];

      // SEC-2 fix: 화이트리스트 스키마 검증 + sanitize
      return parsed
        .map(c => validateSchema(c, CANDIDATE_SCHEMA, CANDIDATE_DEFAULTS))
        .filter(c => c.content && c.content.length > 10)
        .map(c => ({
          ...c,
          content: sanitizeForPrompt(c.content, 500),
          reason: String(c.reason).slice(0, 100),
          memoryType: VALID_MEMORY_TYPES.includes(c.memoryType) ? c.memoryType : 'Fact',
          tags: (c.tags || []).slice(0, 10),
        }));
    } catch (err) {
      log.error(`Candidate extraction failed: ${err.message}`);
      return [];
    }
  }

  /** @private 유사 콘텐츠 중복 체크 */
  async _isDuplicate(content) {
    try {
      const results = await this.semantic.searchWithPools(content.slice(0, 100), ['team', 'reflection'], 3);
      const contentLower = content.toLowerCase();
      for (const r of results) {
        if (this._lcsLength(contentLower, (r.content || '').toLowerCase()) >= 50) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** @private 최장 공통 부분 문자열 길이 (슬라이딩 윈도우 근사) */
  _lcsLength(a, b) {
    if (!a || !b) return 0;
    const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
    const windowSize = Math.min(60, shorter.length);
    for (let i = 0; i <= Math.max(0, shorter.length - windowSize); i += 10) {
      if (longer.includes(shorter.slice(i, i + windowSize))) return windowSize;
    }
    return 0;
  }

  // ═══════════════════════════════════════════════════════
  // Self-Improving: Delegation Pattern Analysis
  // ═══════════════════════════════════════════════════════

  /**
   * DelegationTracer의 완료된 트레이스를 분석하여 반복 실패 패턴,
   * 비효율적 위임 경로 등을 감지하고 Lesson으로 승격.
   *
   * 분석 대상:
   * - 동일 에이전트 쌍(A→B)의 반복 실패 → "B에게 위임 시 context를 더 상세하게"
   * - 불필요한 3+ depth 위임 체인 → "직접 C에게 위임하는 것이 효율적"
   * - 특정 에이전트의 높은 실패율 → "해당 에이전트 prompt/tool 개선 필요"
   *
   * @returns {number} 승격된 Lesson 수
   * @private
   */
  async _extractDelegationPatterns() {
    let promoted = 0;

    try {
      const { getDb } = require('../db/sqlite');
      const db = getDb();

      // 최근 24시간 위임 이력 조회 (episodic_memory에서 agent 간 통신 패턴 추출)
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const delegations = db.prepare(`
        SELECT agent_type, function_type, conversation_key, role, content, created_at
        FROM episodic_memory
        WHERE created_at > ? AND agent_type IS NOT NULL
        ORDER BY created_at ASC LIMIT 300
      `).all(since);

      if (delegations.length < 10) return 0;

      // 에이전트별 요청/응답 패턴 집계
      const agentStats = new Map();  // agentId → { total, failures }

      for (const d of delegations) {
        const agent = d.agent_type;
        if (!agent) continue;

        const stat = agentStats.get(agent) || { total: 0, failures: 0 };
        stat.total++;
        // 실패 감지: 에러 키워드 포함 여부
        if (d.content && /(?:error|실패|failed|timeout|unable|cannot)/i.test(d.content)) {
          stat.failures++;
        }
        agentStats.set(agent, stat);
      }

      // LLM에게 패턴 분석 의뢰
      const statsText = [...agentStats.entries()]
        .filter(([, s]) => s.total >= 3)
        .map(([agent, s]) => `${agent}: ${s.total}건 (실패 ${s.failures}건, ${Math.round(s.failures / s.total * 100)}%)`)
        .join('\n');

      if (!statsText) return 0;

      const response = await client.messages.create({
        model: this.distillModel,
        max_tokens: 500,
        system: `에이전트 위임 패턴을 분석하여 개선 교훈을 추출하세요.

분석 대상: 실패율 20% 이상인 에이전트, 반복 실패 패턴, 비효율적 경로.
출력: JSON 배열 [{ "content": "교훈 내용", "agentId": "대상 에이전트", "reason": "근거" }]
교훈이 없으면 빈 배열 []. 최대 3개.`,
        messages: [{ role: 'user', content: `최근 24시간 에이전트 활동:\n${statsText}` }],
      });

      const text = response.content[0]?.text || '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return 0;

      let lessons;
      try {
        lessons = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        log.warn(`Delegation lesson JSON parse failed: ${parseErr.message}`);
        return 0;
      }
      if (!Array.isArray(lessons)) return 0;

      // REVIEW-FIX: Schema validation for LLM output (SEC-SLIM-1)
      const DELEGATION_SCHEMA = { content: 'string', agentId: 'string', reason: 'string' };
      const DELEGATION_DEFAULTS = { content: '', agentId: 'general', reason: '' };

      // R3-ARCH-3 fix: Track per-lesson outcomes for accurate reporting.
      let skipped = 0;
      let failed = 0;
      for (const rawLesson of lessons.slice(0, 3)) {
        const lesson = validateSchema(rawLesson, DELEGATION_SCHEMA, DELEGATION_DEFAULTS);
        if (!lesson.content || lesson.content.length < 10) { skipped++; continue; }

        const content = sanitizeForPrompt(lesson.content, 300);
        // REVIEW-FIX: Sanitize agentId — alphanumeric, underscore, hyphen only (SEC-SLIM-3)
        const agentId = String(lesson.agentId || 'general').slice(0, 30).replace(/[^a-zA-Z0-9_-]/g, '_');

        // 중복 체크
        if (this._isDuplicate(content)) { skipped++; continue; }

        // Committee 투표
        let shouldPromote = true;
        if (this.committee?.enabled) {
          try {
            const result = await this.committee.proposeAndVote({
              title: `Delegation Pattern: ${content.slice(0, 60)}`,
              description: content,
              type: 'delegation_lesson',
              proposedBy: 'distiller:delegation',
            });
            shouldPromote = (result.status === 'approved' || result.status === 'auto_approved');
          } catch (err) {
            // REVIEW-FIX: Explicit auto-approve on committee failure (BUG-SLIM-5)
            log.warn(`Committee vote failed for delegation lesson, auto-approving: ${err.message}`);
            shouldPromote = true;
          }
        }

        if (shouldPromote) {
          try {
            this.semantic.save({
              content: `[Delegation Lesson] Agent: ${agentId}\n${content}`,
              sourceType: 'delegation_analysis',
              tags: ['lesson', 'delegation', agentId],
              promotionReason: `Delegation pattern: ${String(lesson.reason || '').slice(0, 100)}`,
              poolId: 'team',
              memoryType: 'Observation',
            });
            promoted++;
            log.info(`Delegation lesson promoted for ${agentId}: ${content.slice(0, 80)}`);
          } catch (saveErr) {
            failed++;
            log.error(`Delegation lesson save failed for ${agentId}: ${saveErr.message}`);
          }
        }
      }
      if (skipped > 0 || failed > 0) {
        log.debug('Delegation extraction stats', { promoted, skipped, failed });
      }
    } catch (err) {
      log.warn(`Delegation pattern extraction failed: ${err.message}`);
    }

    return promoted;
  }

  /** @private Anti-Bloat (결정사항 제외) */
  async _enforceGlobalAntiBloat() {
    let archived = 0;
    try {
      const { getDb } = require('../db');
      const db = getDb();

      const { cnt: total } = await db.prepare('SELECT COUNT(*) as cnt FROM semantic_memory WHERE archived = 0').get() || { cnt: 0 };

      if (total > this.maxSemanticEntries) {
        const excess = total - this.maxSemanticEntries;
        const result = await db.prepare(`
          UPDATE semantic_memory SET archived = 1
          WHERE id IN (
            SELECT id FROM semantic_memory
            WHERE archived = 0 AND memory_type != 'Decision'
            ORDER BY last_accessed ASC, created_at ASC LIMIT ?
          )
        `).run(excess);
        archived += result.changes;
      }

      const cutoff = new Date(Date.now() - this.archiveDays * 24 * 60 * 60 * 1000).toISOString();
      const staleResult = await db.prepare(`
        UPDATE semantic_memory SET archived = 1
        WHERE archived = 0 AND memory_type != 'Decision' AND last_accessed < ?
      `).run(cutoff);
      archived += staleResult.changes;

      if (archived > 0) log.info(`Anti-Bloat: archived ${archived} entries (total=${total})`);
    } catch (err) {
      log.warn(`Anti-Bloat error: ${err.message}`);
    }
    return archived;
  }

  // ═══════════════════════════════════════════════════════
  // 스케줄링 (BUG-2 fix: 중복 타이머 방어)
  // ═══════════════════════════════════════════════════════

  schedule(hourKST = 23.5) {
    // BUG-2 fix: 기존 타이머 제거 후 재등록
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    const runAtMs = this._msUntilNextKST(hourKST);
    log.info(`Nightly distillation scheduled in ${Math.round(runAtMs / 60000)}min`);

    this._timer = setTimeout(async () => {
      await this.runDaily();
      // 다음 날 재스케줄 (24h + 0~30분 지터)
      const jitterMs = Math.random() * 30 * 60 * 1000;
      this._timer = setTimeout(() => this.schedule(hourKST), 24 * 60 * 60 * 1000 + jitterMs);
    }, runAtMs);
  }

  /** @private WARN-2: KST 타임존 계산 (Korea는 DST 없음, UTC+9 고정 안전) */
  _msUntilNextKST(hourKST) {
    const now = new Date();
    const kstOffset = 9 * 60 * 60 * 1000;
    const kstNow = new Date(now.getTime() + kstOffset);
    const kstHour = Math.floor(hourKST);
    const kstMin = Math.round((hourKST % 1) * 60);

    const target = new Date(kstNow);
    target.setUTCHours(kstHour, kstMin, 0, 0);
    if (target <= kstNow) target.setUTCDate(target.getUTCDate() + 1);

    const targetUTC = new Date(target.getTime() - kstOffset);
    return Math.max(0, targetUTC - now);
  }

  destroy() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._running = false;
    log.info('NightlyDistiller destroyed');
  }
}

module.exports = { NightlyDistiller };
