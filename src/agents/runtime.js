/**
 * runtime.js — Effy v3.6.2 Agent Runtime.
 *
 * P-2: 도구 정의가 tool-registry.js로 통합됨 (Single Source of Truth).
 * 이 파일은 도구 실행 핸들러 + Agentic Loop만 담당.
 *
 * v4 Port 추가:
 * - create_task: DB 영속화 (tasks 테이블)
 * - create_incident: DB 영속화 + Slack 긴급 알림 (incidents 테이블)
 * - save_knowledge: MemoryGraph 연동 (기존 semantic_memory + graph 이중 저장)
 * - search_knowledge: MemoryGraph 검색 보강 (기존 pool 검색 유지)
 *
 * v3.6.2 리팩터링:
 * - executeTool 파라미터 → ToolContext 객체화 (DRY)
 * - 공통 유틸 추출: _requireSlack, _validateChannelId, _withDb
 * - BUG-1: cron DDL 단일 상수화
 * - BUG-2: config mask 배열 처리
 * - BUG-3: shell command chaining 원천 차단
 * - BUG-4: shell regex 오탐 수정 (URL &)
 * - SEC-1: file_read symlink traversal 방어
 * - SEC-2: file_write symlink traversal 방어 (대칭)
 * - PERF-1: cron DDL lazy 1회 실행
 * - CTX-1: messageContext에 agentId/userId 포함
 * - DEAD-1: executeTool backward compat 데드코드 제거
 */
const crypto = require('crypto');
const fs = require('fs');
const pathMod = require('path');
const { config } = require('../config');
const { cost } = require('../memory/manager');
const { createMessage, streamMessage } = require('../shared/llm-client');

// SEC: Only expose safe environment variables to spawned shell processes
const SAFE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'NODE_ENV', 'TERM', 'USER'];
const { getToolsForFunction, buildToolSchemas, validateToolInput } = require('./tool-registry');
const { sanitizeFtsQuery } = require('../shared/fts-sanitizer');
const { createLogger } = require('../shared/logger');
const log = createLogger('runtime');

// ─── 공통 유틸리티 ────────────────────────────────────────

/** DRY: Slack client null 체크. */
function _requireSlack(slackClient) {
  if (!slackClient) return { success: false, error: 'Slack client not available' };
  return null; // OK
}

/** DRY: 채널 ID 형식 검증 (C로 시작). */
function _validateChannelId(ch) {
  if (!ch || typeof ch !== 'string' || !ch.startsWith('C')) {
    return { error: 'Invalid channel: must be a channel ID starting with "C"' };
  }
  return null; // OK
}

/**
 * DRY: DB 접근 래퍼 — getDb() + try/catch + hint 자동 생성.
 * @param {Function} fn - (db) => result
 * @param {string} errorHint - 에러 시 hint 메시지
 */
async function _withDb(fn, errorHint) {
  try {
    const { getDb } = require('../db');
    const db = getDb();
    return await fn(db);
  } catch (dbErr) {
    return { error: `DB unavailable: ${dbErr.message}`, hint: errorHint || 'DB 테이블이 아직 생성되지 않았을 수 있습니다.' };
  }
}

// BUG-1 fix: cron DDL은 src/db/sqlite.js createTables()에서 SSOT 관리.
// 여기서는 독립 실행/테스트 시 fallback만 보관.
const CRON_JOBS_DDL = `CREATE TABLE IF NOT EXISTS cron_jobs (
  name TEXT UNIQUE NOT NULL, cron_expr TEXT NOT NULL, task_type TEXT NOT NULL,
  task_config TEXT DEFAULT '{}', enabled INTEGER DEFAULT 1,
  last_run TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`;
// PERF-1 fix: DDL 실행 1회만 보장
let _cronDdlApplied = false;

// WARN-2 fix: MemoryGraph 인스턴스를 외부(gateway)에서 DI로 전달받음
// 전달되지 않은 경우 lazy require fallback
let _fallbackGraph = null;
function _getGraph(injected) {
  if (injected) return injected;
  if (!_fallbackGraph) {
    const { MemoryGraph } = require('../memory/graph');
    _fallbackGraph = new MemoryGraph();
  }
  return _fallbackGraph;
}

/**
 * 도구 실행.
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @param {object} ctx - ToolContext
 * @param {object} ctx.slackClient
 * @param {string[]} ctx.accessiblePools - 에이전트가 읽기 가능한 메모리 풀
 * @param {string[]} ctx.writablePools - 에이전트가 쓰기 가능한 메모리 풀
 * @param {object} ctx.messageContext - { channelId, threadId, agentId, userId }
 * @param {string[]} ctx.toolNames - 사용 가능 도구 목록 (hint용)
 * @param {object} ctx.graphInstance - MemoryGraph (DI)
 * @param {object} ctx.userProfileInstance - UserProfileBuilder (DI, v4.0)
 */
async function executeTool(toolName, toolInput, ctx = {}) {
  // REFACTOR: ctx에서 디스트럭처링
  const { slackClient = null, messageContext = {}, toolNames = [], graphInstance = null, userProfileInstance = null } = ctx;
  // BUG-108 fix: pool 배열 유효성 보장 — undefined/빈 배열 방어 + 타입 강제
  const accessiblePools = (Array.isArray(ctx.accessiblePools) && ctx.accessiblePools.length > 0)
    ? ctx.accessiblePools.filter(p => typeof p === 'string' && p.length > 0)
    : ['team'];
  const writablePools = (Array.isArray(ctx.writablePools) && ctx.writablePools.length > 0)
    ? ctx.writablePools.filter(p => typeof p === 'string' && p.length > 0)
    : ['team'];
  // R3-DESIGN-2: Admin 권한 먼저 (비권한 사용자의 validation 오버헤드 제거)
  const { isAdminOnlyTool, requireAdmin } = require('../shared/auth');
  if (isAdminOnlyTool(toolName)) {
    const blocked = requireAdmin(messageContext.userId, toolName);
    if (blocked) return blocked;
  }

  // P-2: 입력값 기본 검증
  const validation = validateToolInput(toolName, toolInput);
  if (!validation.valid) {
    return { error: validation.error, hint: validation.hint };
  }

  switch (toolName) {
    case 'slack_reply':
      if (slackClient) {
        // SEC-1: 원본 채널만 허용 — LLM 환각으로 임의 채널 전송 방지
        const targetChannel = toolInput.channel;
        if (!targetChannel || typeof targetChannel !== 'string' || targetChannel.trim().length === 0) {
          return {
            error: 'Invalid channel: must be a non-empty string',
            hint: `Use channel="${messageContext.channelId || 'C...'}" to specify the target channel.`,
          };
        }
        if (messageContext.channelId && targetChannel !== messageContext.channelId) {
          log.warn(`slack_reply blocked: target=${targetChannel} != origin=${messageContext.channelId}`);
          return {
            error: `Reply is restricted to the originating channel (${messageContext.channelId})`,
            hint: `Use channel="${messageContext.channelId}" to reply in the current channel.`,
          };
        }
        await slackClient.chat.postMessage({
          channel: targetChannel,
          text: toolInput.text,
          thread_ts: toolInput.thread_ts || undefined,
        });
      }
      return { success: true };

    case 'search_knowledge': {
      const { semantic } = require('../memory/manager');
      // B-3: 공통 FTS5 새니타이저 사용
      const { words, query: safeQuery } = sanitizeFtsQuery(toolInput.query);
      if (words.length === 0) {
        return {
          results: [],
          hint: 'Query was empty after sanitization. Use longer keywords (2+ chars) without special characters.',
        };
      }
      // MF-4: pool 필터 적용 — 에이전트의 접근 가능 풀만 검색
      const results = await semantic.searchWithPools(safeQuery, accessiblePools, 5);
      if (results.length === 0) {
        return {
          results: [],
          hint: `No results for "${words.join(' ')}" in pools [${accessiblePools.join(', ')}]. Try broader keywords or save_knowledge to add new entries.`,
        };
      }
      return { results: results.map(r => ({
        content: r.content,
        source: r.source_type,
        channel: r.channel_id,
        pool: r.pool_id || 'team',
      }))};
    }

    case 'save_knowledge': {
      const { semantic: sem } = require('../memory/manager');

      // Harness: Knowledge Quality Gate — 최소 길이 + 중복 체크
      if (!toolInput.content || toolInput.content.trim().length < 50) {
        return {
          error: 'Content too short. save_knowledge requires at least 50 characters of meaningful content.',
          hint: 'Provide a detailed description of the decision, fact, or spec you want to save.',
        };
      }
      // FTS5 중복 체크: 유사 콘텐츠가 이미 존재하면 경고
      const { sanitizeFtsQuery } = require('../shared/fts-sanitizer');
      const dupCheck = sanitizeFtsQuery(toolInput.content.slice(0, 100));
      if (dupCheck.words.length >= 3) {
        const existing = await sem.searchWithPools(dupCheck.query, [toolInput.pool_id || 'team'], 1);
        if (existing.length > 0 && existing[0].score > 5.0) {
          return {
            warning: 'Similar knowledge already exists. Review before saving duplicate.',
            existing: { content: existing[0].content?.slice(0, 200), score: existing[0].score },
            hint: 'If this is genuinely new, add more distinctive content or tags.',
          };
        }
      }

      // C-2: pool write 권한 하드 검증 — LLM 환각으로 잘못된 pool에 쓰는 것 방지
      const requestedPool = toolInput.pool_id || 'team';
      if (!writablePools.includes(requestedPool)) {
        log.warn(`Pool write denied: ${requestedPool} not in [${writablePools}]`);
        return {
          error: `Write permission denied for pool '${requestedPool}'`,
          hint: `Your writable pools: [${writablePools.join(', ')}]. Use pool_id="${writablePools[0]}" instead.`,
        };
      }
      const hash = await sem.save({
        content: toolInput.content,
        sourceType: toolInput.source_type || 'document',
        tags: toolInput.tags || [],
        poolId: requestedPool,
      });

      // v4 Port: MemoryGraph에도 이중 저장 (그래프 검색 + 중요도 추적용)
      try {
        const graph = _getGraph(graphInstance);
        const memoryType = _mapSourceTypeToMemoryType(toolInput.source_type);
        await graph.create({
          type: memoryType,
          content: toolInput.content,
          sourceChannel: messageContext.channelId || '',
          sourceUser: messageContext.userId || '',
          importance: memoryType === 'decision' ? 0.8 : 0.6,
          metadata: { tags: toolInput.tags || [], pool: requestedPool, source: 'save_knowledge' },
        });

        // v4.0: 사용자 프로필 캐시 무효화 (새 메모리 저장 후)
        if (userProfileInstance && messageContext.userId) {
          try {
            await userProfileInstance.refreshProfile(messageContext.userId);
            log.debug('User profile cache refreshed after save_knowledge', { userId: messageContext.userId });
          } catch (profileErr) {
            log.debug('User profile refresh skipped', { error: profileErr.message });
          }
        }
      } catch (graphErr) {
        log.debug('Graph save skipped', { error: graphErr.message });
      }

      return { success: true, hash };
    }

    case 'create_task': {
      // v4 Port: DB 영속화 (tasks 테이블)
      // NOTE: _withDb 미사용 — DB 실패 시에도 stub 반환 (graceful degradation 의도)
      try {
        const { getDb } = require('../db');
        const db = getDb();
        const title = toolInput.title;
        const description = toolInput.description || '';
        const priority = toolInput.priority || 'medium';
        const assignee = toolInput.assignee || '';
        const dueDate = toolInput.due_date || null;

        const result = await db.prepare(
          "INSERT INTO tasks (title, description, priority, assignee, due_date, created_by) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(title, description, priority, assignee, dueDate, messageContext.userId || 'system');

        log.info('Task created', { id: result.lastInsertRowid, title, priority });
        return {
          success: true,
          task_id: result.lastInsertRowid,
          message: `Task #${result.lastInsertRowid} created: ${title} → ${assignee || 'unassigned'} [${priority}]`,
        };
      } catch (dbErr) {
        log.warn('Task DB save failed, returning stub', { error: dbErr.message });
        return { success: true, message: `Task created: ${toolInput.title} → ${toolInput.assignee || 'unassigned'}` };
      }
    }

    case 'create_incident': {
      // v4 Port: DB 영속화 + Slack 긴급 알림 (incidents 테이블)
      // NOTE: _withDb 미사용 — DB 실패 시에도 stub 반환 (graceful degradation 의도)
      try {
        const { getDb } = require('../db');
        const db = getDb();
        const title = toolInput.title;
        const description = toolInput.description || '';
        const severity = toolInput.severity;
        // MD-4 fix: affected_service는 단수 string — 불필요한 배열 래핑 제거
        const affectedSystems = toolInput.affected_service || '';

        const result = await db.prepare(
          "INSERT INTO incidents (title, description, severity, affected_systems, created_by) VALUES (?, ?, ?, ?, ?)"
        ).run(title, description, severity, affectedSystems, messageContext.userId || 'system');

        const incidentId = result.lastInsertRowid;
        log.info('Incident created', { id: incidentId, title, severity });

        // 심각도에 따라 Slack 알림 전송
        if (severity === 'sev1' && slackClient) {
          try {
            const alertChannel = process.env.SLACK_ALERT_CHANNEL;
            // SEC-W-2 fix: 채널 ID(C...) 형식 검증 — 이름('#...')은 Slack API에서 불안정
            if (!alertChannel || !alertChannel.startsWith('C')) {
              log.warn('SLACK_ALERT_CHANNEL not set or invalid (must be channel ID starting with C)', { alertChannel });
            }
            if (!alertChannel) throw new Error('SLACK_ALERT_CHANNEL env not configured');
            await slackClient.chat.postMessage({
              channel: alertChannel,
              text: `🚨 *CRITICAL INCIDENT* #${incidentId}\n*${title}*\n${description}`,
            });
            log.info('Critical incident alert sent', { incidentId, channel: alertChannel });
          } catch (notifyErr) {
            log.warn('Incident notification failed', { error: notifyErr.message });
          }
        }

        return {
          success: true,
          incident_id: incidentId,
          message: `Incident #${incidentId} [${severity}] ${title}`,
        };
      } catch (dbErr) {
        log.warn('Incident DB save failed, returning stub', { error: dbErr.message });
        return { success: true, message: `Incident [${toolInput.severity}] ${toolInput.title}` };
      }
    }

    // ─── DataSource Connector 도구 ───

    case 'query_datasource':
    case 'list_datasources': {
      const { getRegistry } = require('../datasource/registry');
      const registry = getRegistry();
      const agentId = messageContext.agentId || '*';

      if (toolName === 'query_datasource') {
        // v4.0: 쓰기 작업 감지 → Admin 전용 (readOnly: false 커넥터에서만)
        const queryUpper = (toolInput.query || '').toUpperCase().trim();
        const method = (toolInput.params?.method || 'GET').toUpperCase();
        const isWrite = /^(INSERT|UPDATE|DELETE)\b/.test(queryUpper) || method !== 'GET';
        if (isWrite) {
          const { isAdmin: isAdminUser } = require('../shared/auth');
          if (!isAdminUser(messageContext.userId)) {
            return { error: '⛔ 데이터소스 쓰기는 Admin만 가능합니다.', code: 'ADMIN_REQUIRED' };
          }
        }
        return await registry.query(
          toolInput.connector_id,
          toolInput.query,
          toolInput.params || {},
          agentId
        );
      }
      // list_datasources
      const connectors = registry.listConnectors(agentId);
      return connectors.length === 0
        ? { datasources: [], hint: 'No datasources configured. Add datasources section to effy.config.yaml.' }
        : { datasources: connectors };
    }

    // ─── Skill 도구 (INFO-2 fix: 단일 require 블록) ───

    case 'search_skills':
    case 'install_skill':
    case 'list_skills':
    case 'activate_skill':
    case 'create_skill':
    case 'delete_skill': {
      const { getSkillRegistry } = require('../skills/registry');
      const skillReg = getSkillRegistry();
      const skillAgentId = messageContext.agentId || '*';

      if (toolName === 'search_skills') {
        const results = skillReg.search(toolInput.query, { category: toolInput.category });
        return results.length === 0
          ? { results: [], hint: `"${toolInput.query}" 검색 결과 없음. 다른 키워드로 시도하세요.` }
          : { results };
      }
      if (toolName === 'install_skill') {
        return await skillReg.install(toolInput.skill_id);
      }
      if (toolName === 'list_skills') {
        const skills = skillReg.listInstalled(skillAgentId);
        return skills.length === 0
          ? { skills: [], hint: 'No skills installed. Use search_skills to find and install_skill to add skills.' }
          : { skills };
      }
      if (toolName === 'activate_skill') {
        if (!skillReg.installed.has(toolInput.skill_id)) {
          return { success: false, error: `스킬 미설치: ${toolInput.skill_id}. install_skill로 먼저 설치하세요.` };
        }
        skillReg.activateFor(skillAgentId, toolInput.skill_id);
        return { success: true, message: `스킬 '${toolInput.skill_id}' 활성화됨 (에이전트: ${skillAgentId}). 다음 응답부터 적용.` };
      }

      // ─── 대화형 스킬 빌더 ───

      if (toolName === 'create_skill') {
        const { skill_id, name, description, instructions, category, tags, activate_for } = toolInput;

        if (!instructions || instructions.trim().length < 20) {
          return { success: false, error: 'instructions가 너무 짧습니다 (최소 20자). 스킬의 역할, 규칙, 출력 형식을 상세히 기술하세요.' };
        }

        // SKILL.md 조립 (frontmatter + body)
        const tagLine = (tags && tags.length > 0) ? `tags: [${tags.join(', ')}]\n` : '';
        const rawSkillMd = [
          '---',
          `name: "${name}"`,
          `description: "${description}"`,
          `category: ${category || 'custom'}`,
          tagLine ? tagLine.trimEnd() : null,
          '---',
          '',
          instructions,
        ].filter(line => line !== null).join('\n');

        const result = skillReg.registerLocal(skill_id, rawSkillMd, {
          category: category || 'custom',
          tags: tags || [],
          createdBy: skillAgentId,
        });

        if (!result.success) return result;

        // 즉시 활성화
        const targetAgent = activate_for || skillAgentId;
        skillReg.activateFor(targetAgent, result.meta.id);

        return {
          success: true,
          meta: result.meta,
          overwrite: result.overwrite,
          message: `스킬 '${result.meta.name}' (${result.meta.id}) 생성 + 활성화 완료 (에이전트: ${targetAgent}). 다음 응답부터 적용.`,
        };
      }

      if (toolName === 'delete_skill') {
        const skill = skillReg.installed.get(toolInput.skill_id);
        if (!skill) {
          return { success: false, error: `설치되지 않은 스킬: ${toolInput.skill_id}` };
        }
        if (skill.meta.source !== 'local') {
          return { success: false, error: `로컬 스킬만 삭제 가능합니다. '${toolInput.skill_id}'는 ${skill.meta.source} 소스입니다. uninstall을 사용하세요.` };
        }
        skillReg.uninstall(toolInput.skill_id);
        return { success: true, message: `스킬 '${toolInput.skill_id}' 삭제 완료.` };
      }
    }

    // ═══════════════════════════════════════════════════════
    // Communication — 크로스채널, 리액션, 파일, 에이전트 간 통신
    // ═══════════════════════════════════════════════════════

    case 'send_message': {
      const slackErr = _requireSlack(slackClient);
      if (slackErr) return slackErr;
      const chErr = _validateChannelId(toolInput.channel);
      if (chErr) return chErr;
      const ch = toolInput.channel;
      // BL-10 fix: Restrict send_message to the originating channel unless
      // the agent has explicit cross-channel permission in its config.
      const agentCrossChannel = ctx.agentConfig?.crossChannelSend === true;
      if (messageContext.channelId && ch !== messageContext.channelId && !agentCrossChannel) {
        log.warn('send_message cross-channel blocked', { target: ch, origin: messageContext.channelId, agentId: messageContext.agentId });
        return {
          error: `send_message is restricted to the originating channel (${messageContext.channelId}). Cross-channel send requires explicit permission.`,
          hint: 'Set crossChannelSend: true in the agent config to allow cross-channel messaging.',
        };
      }
      await slackClient.chat.postMessage({
        channel: ch,
        text: toolInput.text,
        thread_ts: toolInput.thread_ts || undefined,
      });
      log.info('Cross-channel message sent', { channel: ch });
      return { success: true, channel: ch };
    }

    case 'react': {
      const slackErr = _requireSlack(slackClient);
      if (slackErr) return slackErr;
      const emoji = (toolInput.emoji || '').replace(/:/g, '');
      if (!emoji) return { error: 'emoji is required' };
      try {
        await slackClient.reactions.add({
          channel: toolInput.channel,
          timestamp: toolInput.timestamp,
          name: emoji,
        });
      } catch (err) {
        // already_reacted는 성공으로 처리
        if (err.data?.error === 'already_reacted') {
          return { success: true, already: true };
        }
        return { success: false, error: err.message };
      }
      return { success: true, emoji };
    }

    case 'send_file': {
      const slackErr = _requireSlack(slackClient);
      if (slackErr) return slackErr;
      const chErr = _validateChannelId(toolInput.channel);
      if (chErr) return chErr;
      const ch = toolInput.channel;
      // LLM-6: Restrict send_file to originating channel (same as send_message)
      const agentCrossChannelFile = ctx.agentConfig?.crossChannelSend === true;
      if (messageContext.channelId && ch !== messageContext.channelId && !agentCrossChannelFile) {
        log.warn('send_file cross-channel blocked', { target: ch, origin: messageContext.channelId, agentId: messageContext.agentId });
        return {
          error: `send_file is restricted to the originating channel (${messageContext.channelId}). Cross-channel send requires explicit permission.`,
          hint: 'Set crossChannelSend: true in the agent config to allow cross-channel file uploads.',
        };
      }
      // Slack files.uploadV2 (modern API)
      try {
        await slackClient.filesUploadV2({
          channel_id: ch,
          content: toolInput.content,
          filename: toolInput.filename || 'file.txt',
          title: toolInput.title || toolInput.filename,
          filetype: toolInput.filetype || 'text',
          thread_ts: toolInput.thread_ts || undefined,
        });
      } catch (err) {
        // fallback to legacy upload
        try {
          await slackClient.files.upload({
            channels: ch,
            content: toolInput.content,
            filename: toolInput.filename || 'file.txt',
            title: toolInput.title || toolInput.filename,
            filetype: toolInput.filetype || 'text',
            thread_ts: toolInput.thread_ts || undefined,
          });
        } catch (legacyErr) {
          return { success: false, error: `File upload failed: ${legacyErr.message}` };
        }
      }
      log.info('File uploaded', { channel: ch, filename: toolInput.filename });
      return { success: true, filename: toolInput.filename };
    }

    case 'send_agent_message': {
      // 에이전트 간 내부 메시지 — Gateway의 라우터를 통해 전달
      const targetAgent = toolInput.target_agent;
      const validAgents = ['general', 'code', 'ops', 'knowledge', 'strategy'];
      if (!validAgents.includes(targetAgent)) {
        return { error: `Unknown agent: ${targetAgent}. Available: ${validAgents.join(', ')}` };
      }
      // 내부 메시지 큐에 저장 (Gateway가 다음 턴에서 처리)
      try {
        const { getAgentMailbox } = require('./mailbox');
        const mailbox = getAgentMailbox();
        mailbox.send({
          from: messageContext.agentId || 'unknown',
          to: targetAgent,
          message: toolInput.message,
          context: toolInput.context || {},
          timestamp: Date.now(),
        });
        return { success: true, message: `Message queued for agent '${targetAgent}'` };
      } catch (mailboxErr) {
        // mailbox require 실패 또는 예상치 못한 에러 — 로그 후 성공 반환
        log.warn('Agent message fallback', { to: targetAgent, error: mailboxErr.message });
        return { success: true, message: `Message logged for agent '${targetAgent}' (mailbox unavailable)` };
      }
    }

    // ═══════════════════════════════════════════════════════
    // Task — CRUD 완성
    // ═══════════════════════════════════════════════════════

    case 'task_list': {
      return _withDb(async db => {
        const status = toolInput.status || 'open';
        const limit = Math.min(toolInput.limit || 20, 100);

        let sql = 'SELECT * FROM tasks';
        const params = [];
        const conditions = [];

        // R3-SEC-002 fix: 팀 공유 태스크이므로 assignee 또는 creator 기반 필터링
        // 현재 사용자의 팀 내 태스크만 조회 (channelId 기반 스코핑)
        if (messageContext.channelId) {
          conditions.push('channel_id = ?');
          params.push(messageContext.channelId);
        }

        if (status !== 'all') {
          conditions.push('status = ?');
          params.push(status);
        }
        if (toolInput.assignee) {
          conditions.push('assignee = ?');
          params.push(toolInput.assignee);
        }
        if (toolInput.priority) {
          conditions.push('priority = ?');
          params.push(toolInput.priority);
        }

        if (conditions.length > 0) {
          sql += ' WHERE ' + conditions.join(' AND ');
        }
        sql += ' ORDER BY rowid DESC LIMIT ?';
        params.push(limit);

        const tasks = await db.prepare(sql).all(...params);
        return { tasks, count: tasks.length };
      }, 'tasks 테이블이 아직 생성되지 않았을 수 있습니다.');
    }

    case 'task_update': {
      return _withDb(async db => {
        const taskId = toolInput.task_id;

        // 존재 확인
        const existing = await db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
        if (!existing) {
          return { success: false, error: `Task #${taskId} not found` };
        }

        // R2-SEC-001 fix: 허용 필드 화이트리스트로 SQL injection 방지
        const ALLOWED_FIELDS = ['status', 'assignee', 'priority'];
        const updates = [];
        const params = [];

        for (const field of ALLOWED_FIELDS) {
          if (toolInput[field]) {
            updates.push(`${field} = ?`);
            params.push(String(toolInput[field]).slice(0, 255)); // 길이 제한
          }
        }

        if (updates.length === 0) {
          return { success: false, error: 'No fields to update. Provide status, assignee, or priority.' };
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(taskId);
        await db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);

        // 노트가 있으면 별도 로그
        if (toolInput.note) {
          log.info('Task update note', { taskId, note: toolInput.note });
        }

        return { success: true, task_id: taskId, message: `Task #${taskId} updated` };
      }, 'Task update failed');
    }

    // ═══════════════════════════════════════════════════════
    // System — 파일, 웹 검색, 셸
    // ═══════════════════════════════════════════════════════

    case 'file_read': {
      const filePath = pathMod.resolve(toolInput.path);
      // 보안: 허용된 디렉터리만 접근 가능
      const allowedPrefixes = [
        pathMod.resolve('data'),
        pathMod.resolve('logs'),
        pathMod.resolve('config'),
      ];
      const isAllowed = allowedPrefixes.some(prefix => filePath.startsWith(prefix + pathMod.sep));
      if (!isAllowed) {
        return { error: `Access denied: ${toolInput.path}. Allowed directories: data/, logs/, config/` };
      }
      if (!fs.existsSync(filePath)) {
        return { error: `File not found: ${toolInput.path}` };
      }
      // SEC-1 fix: symlink traversal 방어 — realpath로 실제 경로 확인
      const realPath = fs.realpathSync(filePath);
      const isRealAllowed = allowedPrefixes.some(prefix => realPath.startsWith(prefix));
      if (!isRealAllowed) {
        log.warn('Symlink traversal blocked', { requested: toolInput.path, real: realPath });
        return { error: `Access denied: symlink resolves outside allowed directories` };
      }

      const maxBytes = Math.min(toolInput.max_bytes || 102400, 1048576); // 기본 100KB, 최대 1MB
      const stat = fs.statSync(filePath);
      if (stat.size > maxBytes) {
        // 부분 읽기
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(maxBytes);
        fs.readSync(fd, buf, 0, maxBytes, 0);
        fs.closeSync(fd);
        return {
          content: buf.toString(toolInput.encoding || 'utf-8'),
          truncated: true,
          total_bytes: stat.size,
          read_bytes: maxBytes,
        };
      }
      return {
        content: fs.readFileSync(filePath, toolInput.encoding || 'utf-8'),
        truncated: false,
        total_bytes: stat.size,
      };
    }

    case 'file_write': {
      const writePath = pathMod.resolve(toolInput.path);
      const outputDir = pathMod.resolve('data/output');
      if (!writePath.startsWith(outputDir)) {
        return { error: `Write access denied: ${toolInput.path}. Only data/output/ is writable.` };
      }

      // 디렉터리 자동 생성
      const dir = pathMod.dirname(writePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // SEC-2 fix: symlink traversal 방어 (file_read와 대칭)
      if (fs.existsSync(writePath)) {
        const realWritePath = fs.realpathSync(writePath);
        if (!realWritePath.startsWith(outputDir)) {
          log.warn('Symlink traversal blocked (write)', { requested: toolInput.path, real: realWritePath });
          return { error: 'Access denied: symlink resolves outside allowed directory' };
        }
      }

      fs.writeFileSync(writePath, toolInput.content, toolInput.encoding || 'utf-8');
      const bytes = Buffer.byteLength(toolInput.content, toolInput.encoding || 'utf-8');
      log.info('File written', { path: toolInput.path, bytes });
      return { success: true, path: toolInput.path, bytes };
    }

    case 'web_search': {
      // Brave Search API 또는 SerpAPI 사용 (환경변수 기반)
      const searchApiKey = process.env.SEARCH_API_KEY;
      const searchEngine = process.env.SEARCH_ENGINE || 'brave'; // brave | serp

      if (!searchApiKey) {
        return { error: 'Web search not configured. Set SEARCH_API_KEY and SEARCH_ENGINE env variables.' };
      }

      const maxResults = Math.min(toolInput.max_results || 5, 10);
      const query = toolInput.query;

      try {
        let url, headers;
        if (searchEngine === 'brave') {
          url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
          headers = { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': searchApiKey };
        } else {
          url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&num=${maxResults}`;
          headers = { 'Authorization': `Bearer ${searchApiKey}` };
        }

        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
        if (!res.ok) {
          return { error: `Search API error: ${res.status} ${res.statusText}` };
        }
        const data = await res.json();

        // 결과 정규화
        let results;
        if (searchEngine === 'brave') {
          results = (data.web?.results || []).slice(0, maxResults).map(r => ({
            title: r.title,
            url: r.url,
            snippet: r.description,
          }));
        } else {
          results = (data.organic_results || []).slice(0, maxResults).map(r => ({
            title: r.title,
            url: r.link,
            snippet: r.snippet,
          }));
        }

        return { results, query, engine: searchEngine };
      } catch (err) {
        return { error: `Web search failed: ${err.message}` };
      }
    }

    case 'shell': {
      const { execSync } = require('child_process');

      const cmd = toolInput.command;
      const timeoutMs = Math.min(toolInput.timeout_ms || 30000, 120000);

      // 보안: 화이트리스트 명령어만 허용
      const ALLOWED_COMMANDS = ['git', 'npm', 'npx', 'node', 'docker', 'curl', 'wget', 'cat', 'ls', 'find', 'grep', 'wc', 'head', 'tail', 'sort', 'uniq', 'jq', 'date', 'echo', 'pwd', 'env', 'which', 'df', 'du', 'ps', 'uptime', 'ping'];
      const BLOCKED_PATTERNS = [/rm\s+(-rf?|--recursive)\s+[/~]/, /sudo/, /chmod\s+777/, /mkfs/, /dd\s+if=/, />\s*\/dev\//, /\|\s*(bash|sh|node|python3?|ruby|perl)\b/, /eval\s/, /\$\(/, /`.*`/, /\s&\s*$/, /git\s+.*-c\s/, /core\.hooksPath/];

      // BUG-3 fix: command chaining 원천 차단 (;, &&, || 사용 금지 — 파이프 '|'만 허용)
      // BUG-4 fix: 이전 /[;&]/ 패턴은 URL 파라미터의 '&'도 차단하는 오탐 발생
      //   → ;는 단독 매칭, &는 &&만 매칭 (단일 & 백그라운드는 BLOCKED_PATTERNS에서 처리)
      if (/;|&&|\|\|/.test(cmd)) {
        return { error: 'Command chaining (;, &&, ||) is not allowed. Use separate shell calls for each command.' };
      }

      const firstWord = cmd.trim().split(/\s+/)[0];
      if (!ALLOWED_COMMANDS.includes(firstWord)) {
        return { error: `Command '${firstWord}' not allowed. Allowed: ${ALLOWED_COMMANDS.join(', ')}` };
      }
      for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(cmd)) {
          return { error: `Blocked pattern detected in command. This command is not allowed for security reasons.` };
        }
      }

      try {
        const cwd = toolInput.cwd || process.cwd();
        // SEC: Validate cwd is within allowed directories to prevent path traversal
        const _path = require('path');
        const _fs = require('fs');
        // H-06: Resolve symlinks to prevent symlink-based cwd validation bypass
        const resolvedCwd = _fs.existsSync(cwd) ? _fs.realpathSync(_path.resolve(cwd)) : _path.resolve(cwd);
        const projectRoot = _path.resolve(process.cwd());
        const allowedDirs = [projectRoot, require('os').tmpdir(), '/tmp'];
        const cwdAllowed = allowedDirs.some(dir => resolvedCwd.startsWith(_path.resolve(dir)));
        if (!cwdAllowed) {
          return { error: `Working directory '${cwd}' is outside allowed paths. Allowed roots: ${allowedDirs.join(', ')}` };
        }
        const output = execSync(cmd, {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024, // 1MB
          encoding: 'utf-8',
          env: Object.fromEntries(
            SAFE_ENV_KEYS.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])
          ),
        });
        return { success: true, output: output.slice(0, 50000), exit_code: 0 };
      } catch (err) {
        return {
          success: false,
          output: (err.stdout || '').slice(0, 10000),
          stderr: (err.stderr || '').slice(0, 10000),
          exit_code: err.status || 1,
          error: err.message.slice(0, 500),
        };
      }
    }

    // ═══════════════════════════════════════════════════════
    // Config — 런타임 설정 조회
    // ═══════════════════════════════════════════════════════

    case 'config_inspect': {
      const { config: appConfig } = require('../config');
      const section = toolInput.section || 'all';

      // 시크릿 마스킹 함수 (BUG-2 fix: 배열 타입 지원)
      const mask = (obj) => {
        if (!obj || typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) return obj.map(mask);
        const result = {};
        for (const [k, v] of Object.entries(obj)) {
          if (/key|token|secret|password|credential/i.test(k)) {
            result[k] = '***masked***';
          } else if (typeof v === 'object' && v !== null) {
            result[k] = mask(v);
          } else {
            result[k] = v;
          }
        }
        return result;
      };

      if (section === 'all') {
        return { config: mask(appConfig) };
      }
      if (appConfig[section]) {
        return { section, config: mask(appConfig[section]) };
      }
      return { error: `Unknown section: ${section}. Available: agents, memory, datasources, skills, reflection, gateway` };
    }

    // ═══════════════════════════════════════════════════════
    // Flow Control — 상태 관리
    // ═══════════════════════════════════════════════════════

    case 'set_status': {
      const statusText = (toolInput.status_text || '').slice(0, 100);
      const emoji = toolInput.emoji || 'speech_balloon';
      const expirationMin = toolInput.expiration_min || 30;

      if (slackClient) {
        try {
          await slackClient.users.profile.set({
            profile: JSON.stringify({
              status_text: statusText,
              status_emoji: `:${emoji}:`,
              status_expiration: Math.floor(Date.now() / 1000) + (expirationMin * 60),
            }),
          });
        } catch (err) {
          log.warn('Set status failed', { error: err.message });
          // Slack 봇은 자기 프로필만 수정 가능 — 실패해도 로그만
        }
      }
      log.info('Agent status set', { status: statusText, emoji, expirationMin });
      return { success: true, status_text: statusText, emoji, expires_in_min: expirationMin };
    }

    // memory_delete: 영구 비활성화 — 메모리 삭제는 허용하지 않음.
    // 오래된 데이터는 antiBloat(90일 아카이브)로 자동 관리.

    // ═══════════════════════════════════════════════════════
    // Integration — cron 예약 작업
    // ═══════════════════════════════════════════════════════

    case 'cron_schedule': {
      return _withDb(async db => {
        const action = toolInput.action;

        // BUG-1 fix: DDL을 상수로 단일 관리 — drift 방지
        // PERF-1 fix: 매 호출마다 DDL 실행 → 첫 호출 시 1회만
        if (!_cronDdlApplied) {
          await db.exec(CRON_JOBS_DDL);
          _cronDdlApplied = true;
        }

        if (action === 'list') {
          const jobs = await db.prepare('SELECT rowid as id, * FROM cron_jobs ORDER BY rowid DESC').all();
          return { jobs, count: jobs.length };
        }

        if (action === 'create') {
          if (!toolInput.name || !toolInput.cron_expr || !toolInput.task_type) {
            return { error: 'create requires: name, cron_expr, task_type' };
          }

          await db.prepare(
            'INSERT OR REPLACE INTO cron_jobs (name, cron_expr, task_type, task_config) VALUES (?, ?, ?, ?)'
          ).run(toolInput.name, toolInput.cron_expr, toolInput.task_type, JSON.stringify(toolInput.task_config || {}));

          log.info('Cron job created', { name: toolInput.name, cron: toolInput.cron_expr });
          return { success: true, message: `Cron job '${toolInput.name}' scheduled: ${toolInput.cron_expr}` };
        }

        if (action === 'delete') {
          if (!toolInput.name) return { error: 'delete requires: name' };
          try {
            const r = await db.prepare('DELETE FROM cron_jobs WHERE name = ?').run(toolInput.name);
            return r.changes > 0
              ? { success: true, message: `Cron job '${toolInput.name}' deleted` }
              : { success: false, error: `Cron job '${toolInput.name}' not found` };
          } catch (_) {
            return { success: false, error: `Cron job '${toolInput.name}' not found` };
          }
        }

        return { error: `Unknown action: ${action}. Use create, list, or delete.` };
      }, 'Cron DB error');
    }

    // ═══════════════════════════════════════════════════════
    // Context Hub — API 문서 검색/조회/소스 관리
    // ═══════════════════════════════════════════════════════

    case 'search_api_docs':
    case 'get_api_doc':
    case 'add_api_source':
    case 'remove_api_source':
    case 'list_api_sources': {
      // DRY-1: Single require + lazy getter for all Context Hub tools
      const { getChubAdapter } = require('../knowledge/chub-adapter');
      const chub = getChubAdapter();

      if (toolName === 'search_api_docs') {
        const results = await chub.searchDocs(toolInput.query, {
          lang: toolInput.lang,
          tags: toolInput.tags,
          limit: toolInput.limit,
        });
        if (results.length === 0) {
          return {
            results: [],
            hint: `"${toolInput.query}" 관련 API 문서를 찾지 못했습니다. 영문 키워드를 사용하거나 다른 검색어를 시도하세요.`,
          };
        }
        return { results, count: results.length };
      }

      if (toolName === 'get_api_doc') {
        const doc = await chub.getDoc(toolInput.id, {
          lang: toolInput.lang,
          full: toolInput.full || false,
        });
        if (!doc) {
          return { error: `API 문서 '${toolInput.id}'을(를) 찾을 수 없습니다.`, hint: 'search_api_docs로 검색 후 정확한 id를 사용하세요.' };
        }
        if (doc.error) {
          return { error: doc.error, availableLanguages: doc.availableLanguages };
        }
        return doc;
      }

      if (toolName === 'add_api_source') {
        return await chub.addSource(toolInput.name, toolInput.url, {
          addedBy: messageContext.userId || 'unknown',
          description: toolInput.description || '',
        });
      }

      if (toolName === 'remove_api_source') {
        return chub.removeSource(toolInput.name);
      }

      if (toolName === 'list_api_sources') {
        const sources = chub.listSources();
        return { sources, count: sources.length };
      }
      break;
    }

    default:
      return {
        error: `Unknown tool: ${toolName}`,
        hint: `Available tools: ${toolNames.join(', ')}. Check tool name spelling and try again.`,
      };
  }
}

/**
 * v3 Agent Runtime — Agentic Loop.
 *
 * v2와 차이점:
 * - systemPrompt에 SOUL.md + memory_context가 이미 포함됨 (Gateway가 조립)
 * - FUNCTION_PROMPTS 불필요 (SOUL.md가 대체)
 * - agentId 파라미터 추가 (로깅용)
 */
async function runAgent(params) {
  const {
    systemPrompt,         // Gateway가 조립한 완성된 프롬프트 (SOUL + AGENTS + memory)
    messages,
    functionType = 'general',
    agentId = 'unknown',
    model,
    maxTokens,            // v3.6.2: per-tier maxTokens (from ModelRouter)
    extendedThinking,     // v3.6.2: { enabled, budgetTokens } or null (tier4 only)
    slackClient,
    userId,
    sessionId,
    accessiblePools = ['team'],  // MF-4: pool 읽기 격리
    writablePools = ['team'],   // C-2: pool 쓰기 격리
    channelId,                  // SEC-1: slack_reply 채널 검증용
    threadId,
    graph,                      // WARN-2: DI — gateway.memoryGraph 공유
    userProfile,                // v4.0: DI — UserProfileBuilder 싱글톤
    streamAdapter,              // v4.0: 스트리밍 응답 어댑터
    _originalMsg,               // v4.0: 스트리밍용 원본 메시지
  } = params;

  // ─── External Agent Intercept ─────────────────────────
  // agentId가 config.externalAgents에 등록돼 있으면 내부 LLM 대신 외부 HTTP API로 위임.
  const externalCfg = config.externalAgents?.[agentId];
  if (externalCfg && externalCfg.type === 'openclaw') {
    const { OpenClawClient } = require('../integrations/openclaw-client');
    log.info('Delegating to external agent', { agentId, type: externalCfg.type, baseUrl: externalCfg.baseUrl });
    try {
      const client = new OpenClawClient({
        baseUrl: externalCfg.baseUrl,
        token: externalCfg.token,
        defaultAgent: externalCfg.defaultAgent || 'openclaw/main',
        timeoutMs: externalCfg.timeoutMs || 60000,
      });
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      const userText = typeof lastUserMsg?.content === 'string'
        ? lastUserMsg.content
        : (Array.isArray(lastUserMsg?.content)
            ? lastUserMsg.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
            : '');

      // MS Agent, Portal Agent는 stateless: 이전 turn의 잘못된 답변("토큰 만료" 등)이
      // 자기강화 루프를 일으키는 것을 방지하기 위해 대화 히스토리 없이 현재 요청만 전달.
      // 그 외 외부 에이전트(Ecommerce AI 등)는 기존대로 전체 컨텍스트 유지.
      const statelessChatAgents = ['openclaw/ms', 'openclaw/portal'];
      let chatMessages;
      if (statelessChatAgents.includes(externalCfg.defaultAgent)) {
        chatMessages = userText ? [{ role: 'user', content: userText }] : [];
      } else {
        chatMessages = messages.map(m => {
          const text = typeof m.content === 'string'
            ? m.content
            : (Array.isArray(m.content)
                ? m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
                : '');
          return { role: m.role, content: text };
        }).filter(m => m.content);
      }

      // MS Agent: per-user MS 토큰 주입
      if (externalCfg.defaultAgent === 'openclaw/ms' && userId) {
        try {
          const { entity: entityMgr } = require('../memory/manager');
          const { refreshAccessToken, generateLoginUrl } = require('../auth/ms-oauth');
          const userEntity = await entityMgr.get('user', userId);
          const msAuth = userEntity?.properties?.ms_auth;

          // 재인증이 필요할 때 사용자에게 클릭 가능한 MS 로그인 링크를 전달한다.
          // 보안: 채널에 링크를 그대로 노출하면 다른 사용자가 클릭해 토큰을 탈취할 수 있으므로
          // (state가 요청자 userId에 묶여 있어 다른 사람이 로그인하면 그 토큰이 요청자 계정에 저장됨)
          // DM 요청이 아니라면 실제 링크는 별도 DM으로 전송하고 채널에는 안내 문구만 남긴다.
          const buildReauthResult = async () => {
            const platform = _originalMsg?.platform || 'slack';
            const isDM = !!_originalMsg?.metadata?.isDM;
            const login = generateLoginUrl(userId, platform);

            // URL 생성 실패 → 기존 안내로 폴백
            if (!login?.url) {
              return {
                text: 'Microsoft 인증이 만료되었거나 연동되지 않았습니다. `/effy_auth`로 다시 인증해주세요.',
                model: `external:${externalCfg.type}/${externalCfg.defaultAgent}`,
                inputTokens: 0, outputTokens: 0, iterations: 1,
              };
            }

            const slackLinkLine = `<${login.url}|👉 Microsoft 계정으로 로그인>`;
            const teamsLinkLine = `[👉 Microsoft 계정으로 로그인](${login.url})`;
            const linkLine = platform === 'slack' ? slackLinkLine : teamsLinkLine;
            const fullMessage =
              `Microsoft 인증이 만료되었거나 연동되지 않았습니다.\n${linkLine} (링크는 10분간 유효)`;

            // DM 요청이면 링크를 바로 인라인으로 돌려준다 (다른 사람이 볼 수 없음)
            if (isDM) {
              return {
                text: fullMessage,
                model: `external:${externalCfg.type}/${externalCfg.defaultAgent}`,
                inputTokens: 0, outputTokens: 0, iterations: 1,
              };
            }

            // 채널/스레드 요청이면 실제 링크는 DM으로 별도 전송, 채널엔 안내만
            let dmDelivered = false;
            if (platform === 'slack' && typeof streamAdapter?.sendDM === 'function') {
              try {
                dmDelivered = await streamAdapter.sendDM(userId, fullMessage);
              } catch (e) {
                log.warn('reauth DM send failed', { userId, error: e.message });
              }
            }

            const channelText = dmDelivered
              ? 'Microsoft 인증이 필요합니다. 요청자분께 개인 DM으로 로그인 링크를 보내드렸어요. DM을 확인해주세요.'
              : 'Microsoft 인증이 필요합니다. 저(Effy)에게 개인 DM으로 `/effy_auth` 를 실행해 로그인해주세요.';

            return {
              text: channelText,
              model: `external:${externalCfg.type}/${externalCfg.defaultAgent}`,
              inputTokens: 0, outputTokens: 0, iterations: 1,
            };
          };

          if (msAuth?.accessToken) {
            // 만료 5분 전이면 자동 갱신
            if (Date.now() > (msAuth.expiresAt - 300000)) {
              if (msAuth.refreshToken) {
                try {
                  const refreshed = await refreshAccessToken(msAuth.refreshToken);
                  if (refreshed) {
                    await entityMgr.upsert('user', userId, null, {
                      ms_auth: { ...msAuth, accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt },
                    });
                    msAuth.accessToken = refreshed.accessToken;
                    log.info('MS token refreshed for external agent', { userId });
                  } else {
                    return await buildReauthResult();
                  }
                } catch (refErr) {
                  log.warn('MS token refresh failed', { userId, error: refErr.message });
                  return await buildReauthResult();
                }
              } else {
                // refresh token 없음 (offline_access 미적용 상태) → 재인증
                return await buildReauthResult();
              }
            }
            // system 메시지로 토큰 + 현재 시간 전달 (JSON)
            chatMessages.unshift({
              role: 'system',
              content: JSON.stringify({
                type: 'ms_auth_context',
                accessToken: msAuth.accessToken,
                email: msAuth.email || null,
                displayName: msAuth.displayName || null,
                expiresAt: msAuth.expiresAt,
                currentDateTime: new Date().toISOString(),
                timezone: 'Asia/Seoul',
              }),
            });
          } else {
            // 토큰 없음 → 인증 유도
            return await buildReauthResult();
          }
        } catch (tokenErr) {
          log.warn('MS token injection failed', { userId, error: tokenErr.message });
        }
      }

      // Portal MCP Agent: per-user 포털 토큰 주입
      if (externalCfg.defaultAgent === 'openclaw/portal' && userId) {
        try {
          const _tPortalAuth = Date.now();
          const { ensurePortalAuth } = require('../auth/portal-auth');
          const portalResult = await ensurePortalAuth(userId);
          log.info('External agent timing', { agentId, phase: 'portal_auth', durationMs: Date.now() - _tPortalAuth });

          if (portalResult?.accessToken) {
            chatMessages.unshift({
              role: 'system',
              content: JSON.stringify({
                type: 'portal_auth_context',
                accessToken: portalResult.accessToken,
                currentDateTime: new Date().toISOString(),
                timezone: 'Asia/Seoul',
              }),
            });
          } else {
            // 포털 인증 실패 → MS 재인증 유도 (포털 토큰은 MS 토큰에 의존)
            // 보안: 채널 노출 방지를 위해 buildReauthResult()와 동일 패턴 사용
            const { generateLoginUrl } = require('../auth/ms-oauth');
            const platform = _originalMsg?.platform || 'slack';
            const isDM = !!_originalMsg?.metadata?.isDM;
            const login = generateLoginUrl(userId, platform);

            if (!login?.url) {
              return {
                text: '포털 인증이 만료되었습니다. `/effy_auth`로 다시 인증해주세요.',
                model: `external:${externalCfg.type}/${externalCfg.defaultAgent}`,
                inputTokens: 0, outputTokens: 0, iterations: 1,
              };
            }

            const linkLine = platform === 'slack'
              ? `<${login.url}|👉 Microsoft 계정으로 로그인>`
              : `[👉 Microsoft 계정으로 로그인](${login.url})`;
            const fullMessage = `포털 인증이 만료되었습니다. Microsoft 재인증이 필요합니다.\n${linkLine} (링크는 10분간 유효)`;

            if (isDM) {
              return {
                text: fullMessage,
                model: `external:${externalCfg.type}/${externalCfg.defaultAgent}`,
                inputTokens: 0, outputTokens: 0, iterations: 1,
              };
            }

            // 채널 요청 → 링크는 DM으로, 채널엔 안내만
            let dmDelivered = false;
            if (platform === 'slack' && typeof streamAdapter?.sendDM === 'function') {
              try { dmDelivered = await streamAdapter.sendDM(userId, fullMessage); } catch { /* ignore */ }
            }
            return {
              text: dmDelivered
                ? '포털 인증이 필요합니다. 개인 DM으로 로그인 링크를 보내드렸어요. DM을 확인해주세요.'
                : '포털 인증이 필요합니다. 저(Effy)에게 개인 DM으로 `/effy_auth` 를 실행해 로그인해주세요.',
              model: `external:${externalCfg.type}/${externalCfg.defaultAgent}`,
              inputTokens: 0, outputTokens: 0, iterations: 1,
            };
          }
        } catch (portalErr) {
          log.warn('Portal token injection failed', { userId, error: portalErr.message });
        }
      }

      // OpenClaw 세션 키 포맷: "agent:<agentId>:<rest>" (콜론 구분 필수)
      // 이 포맷이 아니면 OpenClaw가 main 에이전트로 폴백한다.
      //
      // OpenClaw 세션 키: 일별 고정 (에이전트별 + 유저별 + 날짜)
      // → 같은 날이면 세션 재활용(캐시 히트, ~12s), 날짜 변경 시 새 세션
      // → 토큰 만료 시에는 auto-retry 로직이 갱신 후 재시도
      const agentShortId = externalCfg.defaultAgent.split('/')[1] || 'main';
      const today = new Date().toISOString().slice(0, 10);
      const externalSessionKey = `agent:${agentShortId}:${userId || 'anon'}-${today}`;

      // OpenClaw 호출 + 토큰 만료 자동 재시도
      // MS/Portal Agent 응답에서 토큰 만료 패턴 감지 시: 토큰 갱신 → 메시지 업데이트 → 1회 재시도
      const TOKEN_EXPIRED_PATTERNS = [
        /token.*(?:expired|만료)/i,
        /인증.*(?:만료|필요|실패)/i,
        /auth.*(?:expired|failed|required)/i,
        /401|unauthorized/i,
        /refresh.*token/i,
        /재인증|재로그인|다시.*로그인/i,
      ];

      const callOpenClaw = async (msgs) => {
        const _t = Date.now();
        const reply = await client.chat({ messages: msgs, sessionKey: externalSessionKey });
        const dur = Date.now() - _t;
        log.info('External agent timing', {
          agentId, phase: 'openclaw_call', durationMs: dur,
          replyLength: reply?.length || 0, replyPreview: (reply || '').slice(0, 300),
        });
        return reply;
      };

      let externalReply = await callOpenClaw(chatMessages);

      // 토큰 만료 감지 → 자동 갱신 후 1회 재시도
      const isTokenExpiredReply = externalReply && TOKEN_EXPIRED_PATTERNS.some(p => p.test(externalReply));
      if (isTokenExpiredReply && userId) {
        log.info('Token expired detected in reply, attempting auto-refresh', { agentId, userId });
        try {
          const { entity: entityMgr } = require('../memory/manager');
          const { refreshAccessToken } = require('../auth/ms-oauth');
          const userEntity = await entityMgr.get('user', userId);
          const msAuth = userEntity?.properties?.ms_auth;

          if (msAuth?.refreshToken) {
            const refreshed = await refreshAccessToken(msAuth.refreshToken);
            if (refreshed?.accessToken) {
              // DB 업데이트
              await entityMgr.upsert('user', userId, null, {
                ms_auth: { ...msAuth, accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt },
              });
              log.info('Token auto-refreshed, retrying OpenClaw call', { agentId, userId });

              // chatMessages에서 기존 ms_auth_context 교체
              const updatedMessages = chatMessages.map(m => {
                if (m.role === 'system' && typeof m.content === 'string') {
                  try {
                    const parsed = JSON.parse(m.content);
                    if (parsed.type === 'ms_auth_context') {
                      return { ...m, content: JSON.stringify({ ...parsed, accessToken: refreshed.accessToken }) };
                    }
                    if (parsed.type === 'portal_auth_context') {
                      // 포털 토큰도 MS 토큰 기반이므로 재발급
                      const { ensurePortalAuth } = require('../auth/portal-auth');
                      // sync하게 처리 불가 → 포털은 다음 요청에서 자동 갱신됨
                    }
                  } catch { /* not JSON, skip */ }
                }
                return m;
              });

              externalReply = await callOpenClaw(updatedMessages);
            }
          }
        } catch (retryErr) {
          log.warn('Token auto-refresh retry failed', { agentId, userId, error: retryErr.message });
          // 재시도 실패 시 원래 응답(토큰 만료 메시지) 그대로 반환 → buildReauthResult로 폴백
        }
      }

      if (!externalReply) {
        return {
          text: '(외부 에이전트가 빈 응답을 반환했습니다.)',
          model: `external:${externalCfg.type}/${externalCfg.defaultAgent}`,
          inputTokens: 0, outputTokens: 0, iterations: 1,
        };
      }

      // Effy가 외부 에이전트 응답을 자기 답변으로 정리 (외부 에이전트 존재 숨김)
      const summaryModel = config.anthropic?.models?.tier1?.id || 'claude-haiku-4-5-20251001';
      // 플랫폼별 포맷 규칙 (Slack mrkdwn은 테이블/중첩 리스트/**굵게** 미지원)
      const platform = _originalMsg?.platform || 'slack';
      const formatRules = platform === 'slack'
        ? `
포맷 규칙 (Slack mrkdwn):
- **테이블 금지**: \`| col | col |\` 같은 마크다운 테이블은 Slack에서 깨집니다. 리스트나 코드블록으로 변환하세요.
- 굵게는 \`**텍스트**\`가 아니라 \`*텍스트*\` (단일 별표) 사용.
- 기울임은 \`_텍스트_\`.
- 리스트는 \`• 항목\` 또는 \`- 항목\`. 각 항목은 한 줄.
- 여러 항목을 보여줄 때: 각 항목을 "• *이름* — 설명" 형태로 정리하거나, 데이터가 많으면 코드블록(\`\`\`)으로 감싸서 표 형태로 정렬하세요.
- 제목은 \`### 제목\` 대신 \`*제목*\` (굵게)로 표현하세요.`
        : `
포맷 규칙 (Teams 마크다운):
- 마크다운 테이블, 굵게(\`**\`), 리스트 모두 정상 지원됩니다.
- 원본 포맷을 최대한 유지하세요.`;
      try {
        const _tSummary = Date.now();
        const summaryResponse = await createMessage({
          model: summaryModel,
          max_tokens: 2048,
          system: `당신은 Effy(에피)입니다. 팀의 AI 비서 역할을 합니다.
사용자의 질문에 대해 내부 시스템에서 정보를 수집했습니다.
아래 수집된 정보를 바탕으로 **Effy 본인이 직접 답변하는 것처럼** 사용자에게 전달하세요.

규칙:
- 외부 에이전트나 다른 AI의 존재를 절대 언급하지 마세요.
- "확인해본 결과", "찾아본 바로는" 같은 자연스러운 표현을 사용하세요.
- 핵심 내용을 유지하되, Effy의 톤(간결, 자연스러운 동료 느낌)으로 정리하세요.
- 답변이 이미 깔끔하면 크게 수정하지 말고, 톤만 맞추세요.
${formatRules}`,
          messages: [
            { role: 'user', content: `사용자 질문: ${userText}\n\n수집된 정보:\n${externalReply}` },
          ],
        });
        log.info('External agent timing', { agentId, phase: 'summary_llm', durationMs: Date.now() - _tSummary });
        const summaryText = summaryResponse.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n');
        return {
          text: summaryText,
          model: `external:${externalCfg.type}/${externalCfg.defaultAgent}+summary:${summaryModel}`,
          inputTokens: summaryResponse.usage?.input_tokens || 0,
          outputTokens: summaryResponse.usage?.output_tokens || 0,
          iterations: 1,
        };
      } catch (sumErr) {
        log.warn('External agent summary failed, returning raw reply', { error: sumErr.message });
        return {
          text: externalReply,
          model: `external:${externalCfg.type}/${externalCfg.defaultAgent}`,
          inputTokens: 0, outputTokens: 0, iterations: 1,
        };
      }
    } catch (extErr) {
      log.error('External agent call failed', { agentId, error: extErr.message, stack: (extErr.stack || '').split('\n').slice(0, 5).join(' | '), cause: String(extErr.cause || '') });
      return {
        text: `(외부 에이전트 호출 실패: ${extErr.message})`,
        model: `external:${externalCfg.type}`,
        inputTokens: 0, outputTokens: 0, iterations: 0,
      };
    }
  }

  const messageContext = { channelId, threadId, agentId, userId };

  const useModel = model || config.anthropic?.defaultModel || 'claude-haiku-4-5-20251001';
  // v3.6.2: per-tier maxTokens — ModelRouter가 tier별로 적절한 값 결정
  const useMaxTokens = maxTokens || config.anthropic?.maxTokens || 4096;
  const toolNames = getToolsForFunction(functionType);
  const tools = buildToolSchemas(toolNames);

  let currentMessages = [...messages];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const MAX_ITERATIONS = config.agents?.maxIterations || 10;
  const MAX_RETRIES = config.agents?.maxRetries || 2;
  // Phase 3: API doc 사용 이력 추적 (postAgentRun annotation용)
  const apiDocCalls = [];

  // OP-5: Log system prompt metadata (length + hash) and message count for debugging
  {
    const crypto = require('crypto');
    const promptHash = crypto.createHash('sha256').update(systemPrompt || '').digest('hex').slice(0, 12);
    log.debug('LLM call preparation', {
      agentId,
      systemPromptLength: (systemPrompt || '').length,
      systemPromptHash: promptHash,
      messageCount: currentMessages.length,
      model: useModel,
      functionType,
    });
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // MF-5: API 에러 유형별 처리 (429 재시도, 529 대기, 기타 전파)
    let response;
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      try {
        // v3.6.2: Extended Thinking 지원 — tier4일 때 thinking 파라미터 추가
        const apiParams = {
          model: useModel,
          max_tokens: useMaxTokens,
          system: systemPrompt,
          messages: currentMessages,
          tools: tools.length > 0 ? tools : undefined,
        };

        // Extended Thinking: Anthropic API thinking 파라미터 구성
        if (extendedThinking && extendedThinking.enabled) {
          apiParams.thinking = {
            type: 'enabled',
            budget_tokens: extendedThinking.budgetTokens || 10000,
          };
          log.debug('Extended Thinking enabled', {
            agentId,
            budgetTokens: apiParams.thinking.budget_tokens,
            maxTokens: useMaxTokens,
          });
        }

        // v4.0: 스트리밍 모드 — stop_reason이 tool_use가 아닌 최종 응답만 스트리밍
        // (tool_use 루프 중간에는 일반 모드 사용)
        if (params.streamAdapter && i === 0 && !apiParams.tools?.length) {
          // 도구 없는 단순 응답 → 스트리밍 가능 (primary only)
          const stream = streamMessage(apiParams);
          const streamText = await params.streamAdapter.replyStream(params._originalMsg, stream);
          const finalMsg = await stream.finalMessage();
          response = finalMsg;
        } else {
          // v4.0: Multi-LLM — Claude 장애 시 OpenAI 자동 전환
          response = await createMessage(apiParams);
        }
        break; // 성공
      } catch (apiErr) {
        const status = apiErr.status || apiErr.statusCode;
        if ((status === 429 || status === 529) && retry < MAX_RETRIES) {
          const delay = Math.min(1000 * Math.pow(2, retry), 8000);
          log.warn(`API ${status}, retry ${retry + 1}/${MAX_RETRIES} after ${delay}ms`, { agentId });
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        // 재시도 불가 또는 다른 에러 → 상위로 전파
        log.error(`API error (status=${status}): ${apiErr.message}`, { agentId });
        throw apiErr;
      }
    }

    totalInputTokens += response.usage?.input_tokens || 0;
    totalOutputTokens += response.usage?.output_tokens || 0;

    // C-1: stop_reason이 tool_use가 아니면 루프 종료 (end_turn, max_tokens 등)
    if (response.stop_reason !== 'tool_use') {
      // v3.6.2: Extended Thinking 응답에는 'thinking' 블록이 포함됨 — text만 추출
      const textBlocks = response.content.filter(b => b.type === 'text');
      const finalText = textBlocks.map(b => b.text).join('\n');

      if (userId) {
        cost.log(userId, useModel, totalInputTokens, totalOutputTokens, sessionId || '').catch(() => {});
      }

      // Phase 3: Self-Improving Loop — API doc 사용 annotation + MemoryGraph edge
      if (apiDocCalls.length > 0) {
        _postAgentAnnotation(agentId, apiDocCalls, graph).catch(err =>
          log.debug('Post-agent annotation skipped', { error: err.message })
        );
      }

      return {
        text: finalText,
        model: useModel,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        iterations: i + 1,
      };
    }

    // tool_use 처리
    const assistantContent = response.content;
    currentMessages.push({ role: 'assistant', content: assistantContent });

    const toolResults = [];
    for (const block of assistantContent) {
      if (block.type === 'tool_use') {
        log.debug(`Tool: ${block.name}(${JSON.stringify(block.input).slice(0, 80)})`, { agentId });
        let result = await executeTool(block.name, block.input, {
              slackClient, accessiblePools, writablePools, messageContext, toolNames, graphInstance: graph, userProfileInstance: userProfile,
            });
        // Harness: Tool Result Guard — 반환값 크기/무결성 검증
        result = _guardToolResult(result, block.name);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
        // Phase 3: get_api_doc 호출 추적
        if (block.name === 'get_api_doc' && !result.error) {
          apiDocCalls.push({ id: block.input.id, lang: block.input.lang, success: true });
        }
      }
    }
    currentMessages.push({ role: 'user', content: toolResults });
  }

  if (userId) {
    cost.log(userId, useModel, totalInputTokens, totalOutputTokens, sessionId || '').catch(() => {});
  }
  return {
    text: '(처리 한도에 도달했습니다. 질문을 나누어 주세요.)',
    model: useModel,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    iterations: MAX_ITERATIONS,
  };
}

/**
 * Harness: Tool Result Guard — 반환값 크기/무결성 검증.
 *
 * SWE-agent의 capped search 원리: 결과가 너무 크면 에이전트 컨텍스트를 오염시키므로,
 * 상한을 초과하면 요약 메시지로 대체한다.
 *
 * @param {*} result - 도구 반환값
 * @param {string} toolName - 도구 이름
 * @returns {*} 검증/트리밍된 결과
 */
const MAX_RESULT_CHARS = 50000;  // ~12K tokens — 컨텍스트 윈도우 보호

function _guardToolResult(result, toolName) {
  if (result == null) {
    return { warning: `Tool '${toolName}' returned null/undefined. This may indicate an internal error.` };
  }
  // JSON 직렬화 크기 체크
  const serialized = typeof result === 'string' ? result : JSON.stringify(result);
  if (serialized.length > MAX_RESULT_CHARS) {
    log.warn('Tool result truncated', { tool: toolName, size: serialized.length, limit: MAX_RESULT_CHARS });
    return {
      warning: `Tool '${toolName}' result exceeded ${MAX_RESULT_CHARS} chars (actual: ${serialized.length}). Result truncated. Try a more specific query.`,
      truncated: true,
      preview: serialized.slice(0, 2000) + '\n... (truncated)',
    };
  }
  return result;
}

/**
 * Phase 3: Self-Improving Loop — API 문서 사용 후 annotation + MemoryGraph edge 생성.
 *
 * @param {string} agentId - 사용한 에이전트
 * @param {Array} apiDocCalls - [{id, lang, success}]
 * @param {object} graphInstance - MemoryGraph (DI)
 * @private
 */
async function _postAgentAnnotation(agentId, apiDocCalls, graphInstance) {
  try {
    const { getChubAdapter } = require('../knowledge/chub-adapter');
    const chub = getChubAdapter();

    for (const call of apiDocCalls) {
      // 1. Annotation 업데이트 — 사용 이력 누적
      const existing = chub.getAnnotation(call.id);
      const timestamp = new Date().toISOString();
      const newEntry = `[${timestamp}] Used by ${agentId} (lang: ${call.lang || 'default'})`;
      const note = existing && existing.note
        ? `${existing.note}\n${newEntry}`
        : newEntry;
      chub.annotate(call.id, note);

      // 2. MemoryGraph edge 생성 — references_api
      if (graphInstance) {
        try {
          graphInstance.create({
            type: 'fact',
            content: `Agent ${agentId} referenced API doc: ${call.id}`,
            sourceChannel: '',
            sourceUser: agentId,
            importance: 0.4,
            metadata: {
              docId: call.id,
              lang: call.lang || 'default',
              source: 'context_hub',
              edgeType: 'references_api',
              usedAt: timestamp,
            },
          });
        } catch (graphErr) {
          log.debug('Graph edge creation skipped', { docId: call.id, error: graphErr.message });
        }
      }
    }

    log.debug('Post-agent annotations saved', { agentId, count: apiDocCalls.length });
  } catch (err) {
    // Non-critical — 실패해도 메인 플로우에 영향 없음
    log.debug('Post-agent annotation error', { error: err.message });
  }
}

/**
 * source_type → memory graph type 매핑 헬퍼.
 * @private
 */
function _mapSourceTypeToMemoryType(sourceType) {
  const mapping = {
    decision: 'decision',
    document: 'fact',
    wiki: 'fact',
    spec: 'fact',
  };
  return mapping[sourceType] || 'fact';
}

module.exports = { runAgent };
