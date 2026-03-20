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
const fs = require('fs');
const pathMod = require('path');
const { config } = require('../config');
const { cost } = require('../memory/manager');
const { createMessage, streamMessage } = require('../shared/llm-client');
const { getToolsForFunction, buildToolSchemas, validateToolInput } = require('./tool-registry');
const { sanitizeFtsQuery } = require('../shared/fts-sanitizer');
const { createLogger } = require('../shared/logger');
const { getDefaultModel } = require('../shared/model-config');
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
function _withDb(fn, errorHint) {
  try {
    const { getDb } = require('../db/sqlite');
    const db = getDb();
    return fn(db);
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
 */
async function executeTool(toolName, toolInput, ctx = {}) {
  // REFACTOR: ctx에서 디스트럭처링
  const { slackClient = null, accessiblePools = ['team'], writablePools = ['team'],
          messageContext = {}, toolNames = [], graphInstance = null } = ctx;
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
      const results = semantic.searchWithPools(safeQuery, accessiblePools, 5);
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
        const existing = sem.searchWithPools(dupCheck.query, [toolInput.pool_id || 'team'], 1);
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
      const hash = sem.save({
        content: toolInput.content,
        sourceType: toolInput.source_type || 'document',
        tags: toolInput.tags || [],
        poolId: requestedPool,
      });

      // v4 Port: MemoryGraph에도 이중 저장 (그래프 검색 + 중요도 추적용)
      try {
        const graph = _getGraph(graphInstance);
        const memoryType = _mapSourceTypeToMemoryType(toolInput.source_type);
        graph.create({
          type: memoryType,
          content: toolInput.content,
          sourceChannel: messageContext.channelId || '',
          sourceUser: messageContext.userId || '',
          importance: memoryType === 'decision' ? 0.8 : 0.6,
          metadata: { tags: toolInput.tags || [], pool: requestedPool, source: 'save_knowledge' },
        });
      } catch (graphErr) {
        log.debug('Graph save skipped', { error: graphErr.message });
      }

      return { success: true, hash };
    }

    case 'create_task': {
      // v4 Port: DB 영속화 (tasks 테이블)
      // NOTE: _withDb 미사용 — DB 실패 시에도 stub 반환 (graceful degradation 의도)
      try {
        const { getDb } = require('../db/sqlite');
        const db = getDb();
        const title = toolInput.title;
        const description = toolInput.description || '';
        const priority = toolInput.priority || 'medium';
        const assignee = toolInput.assignee || '';
        const dueDate = toolInput.due_date || null;

        const result = db.prepare(
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
        const { getDb } = require('../db/sqlite');
        const db = getDb();
        const title = toolInput.title;
        const description = toolInput.description || '';
        const severity = toolInput.severity;
        // MD-4 fix: affected_service는 단수 string — 불필요한 배열 래핑 제거
        const affectedSystems = toolInput.affected_service || '';

        const result = db.prepare(
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
      return _withDb(db => {
        const status = toolInput.status || 'open';
        const limit = Math.min(toolInput.limit || 20, 100);

        let sql = 'SELECT * FROM tasks';
        const params = [];
        const conditions = [];

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

        const tasks = db.prepare(sql).all(...params);
        return { tasks, count: tasks.length };
      }, 'tasks 테이블이 아직 생성되지 않았을 수 있습니다.');
    }

    case 'task_update': {
      return _withDb(db => {
        const taskId = toolInput.task_id;

        // 존재 확인
        const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
        if (!existing) {
          return { success: false, error: `Task #${taskId} not found` };
        }

        const updates = [];
        const params = [];

        if (toolInput.status) { updates.push('status = ?'); params.push(toolInput.status); }
        if (toolInput.assignee) { updates.push('assignee = ?'); params.push(toolInput.assignee); }
        if (toolInput.priority) { updates.push('priority = ?'); params.push(toolInput.priority); }

        if (updates.length === 0) {
          return { success: false, error: 'No fields to update. Provide status, assignee, or priority.' };
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(taskId);
        db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);

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
      const isAllowed = allowedPrefixes.some(prefix => filePath.startsWith(prefix));
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
          url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&num=${maxResults}&api_key=${searchApiKey}`;
          headers = {};
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
      const BLOCKED_PATTERNS = [/rm\s+(-rf?|--recursive)\s+[/~]/, /sudo/, /chmod\s+777/, /mkfs/, /dd\s+if=/, />\s*\/dev\//, /curl.*\|\s*(bash|sh)/, /eval\s/, /\$\(/, /`.*`/, /\s&\s*$/];

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
        const output = execSync(cmd, {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024, // 1MB
          encoding: 'utf-8',
          env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' },
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
      return _withDb(db => {
        const action = toolInput.action;

        // BUG-1 fix: DDL을 상수로 단일 관리 — drift 방지
        // PERF-1 fix: 매 호출마다 DDL 실행 → 첫 호출 시 1회만
        if (!_cronDdlApplied) {
          db.exec(CRON_JOBS_DDL);
          _cronDdlApplied = true;
        }

        if (action === 'list') {
          const jobs = db.prepare('SELECT rowid as id, * FROM cron_jobs ORDER BY rowid DESC').all();
          return { jobs, count: jobs.length };
        }

        if (action === 'create') {
          if (!toolInput.name || !toolInput.cron_expr || !toolInput.task_type) {
            return { error: 'create requires: name, cron_expr, task_type' };
          }

          db.prepare(
            'INSERT OR REPLACE INTO cron_jobs (name, cron_expr, task_type, task_config) VALUES (?, ?, ?, ?)'
          ).run(toolInput.name, toolInput.cron_expr, toolInput.task_type, JSON.stringify(toolInput.task_config || {}));

          log.info('Cron job created', { name: toolInput.name, cron: toolInput.cron_expr });
          return { success: true, message: `Cron job '${toolInput.name}' scheduled: ${toolInput.cron_expr}` };
        }

        if (action === 'delete') {
          if (!toolInput.name) return { error: 'delete requires: name' };
          try {
            const r = db.prepare('DELETE FROM cron_jobs WHERE name = ?').run(toolInput.name);
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
    streamAdapter,              // v4.0: 스트리밍 응답 어댑터
    _originalMsg,               // v4.0: 스트리밍용 원본 메시지
  } = params;

  const messageContext = { channelId, threadId, agentId, userId };

  const useModel = model || getDefaultModel();
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
        cost.log(userId, useModel, totalInputTokens, totalOutputTokens, sessionId || '');
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
              slackClient, accessiblePools, writablePools, messageContext, toolNames, graphInstance: graph,
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
    cost.log(userId, useModel, totalInputTokens, totalOutputTokens, sessionId || '');
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
