/**
 * tool-output-schemas.js — Harness: Tool Output Contract Definitions.
 *
 * Spec-as-Code: 각 도구의 반환값 구조를 기계 판독 가능한 형태로 정의.
 * - 에이전트 시스템 프롬프트에서 참조 가능
 * - Tool Result Guard에서 검증 가능 (향후)
 * - API 문서 자동 생성 기반
 *
 * 형식: { toolName: { success: {...}, error: {...} } }
 */

const OUTPUT_SCHEMAS = {
  slack_reply: {
    success: { ok: 'boolean', ts: 'string (message timestamp)' },
    error: { error: 'string' },
  },
  search_knowledge: {
    success: { results: '[{ content, source_type, channel_id, score }]' },
    empty: { results: '[]', hint: 'string' },
  },
  save_knowledge: {
    success: { hash: 'string (SHA256)', message: 'string' },
    error: { error: 'string', hint: 'string' },
    quality_warning: { warning: 'string', existing: '{ content, score }' },
  },
  create_task: {
    success: { id: 'number', title: 'string', status: '"open"' },
    error: { error: 'string' },
  },
  create_incident: {
    success: { id: 'number', severity: 'string', status: '"open"' },
    error: { error: 'string' },
  },
  search_api_docs: {
    success: { results: '[{ id, name, description, score }]', count: 'number' },
    empty: { results: '[]', hint: 'string' },
  },
  get_api_doc: {
    success: { id: 'string', content: 'string (markdown)', metadata: 'object' },
    error: { error: 'string', hint: 'string' },
  },
  add_api_source: {
    success: { success: 'true', source: '{ name, url, description }', message: 'string' },
    error: { success: 'false', error: 'string' },
  },
  remove_api_source: {
    success: { success: 'true', message: 'string' },
    error: { success: 'false', error: 'string' },
  },
  list_api_sources: {
    success: { sources: '[{ name, url, type, description }]', count: 'number' },
  },
  shell: {
    success: { stdout: 'string', exitCode: 'number' },
    error: { error: 'string', hint: 'string' },
  },
  file_read: {
    success: { content: 'string', path: 'string', bytes: 'number' },
    error: { error: 'string' },
  },
  file_write: {
    success: { path: 'string', bytes: 'number' },
    error: { error: 'string' },
  },
  config_inspect: {
    success: { section: 'string', data: 'object (masked secrets)' },
  },
  cron_schedule: {
    success_create: { name: 'string', cron_expr: 'string', message: 'string' },
    success_list: { jobs: '[{ name, cron_expr, task_type }]' },
    success_delete: { message: 'string' },
    error: { error: 'string' },
  },

  // 공통 에러 (admin guard, validation)
  _admin_blocked: {
    error: 'string (⛔ 권한 부족: ...)',
    code: '"ADMIN_REQUIRED"',
    hint: 'string',
  },
  _validation_failed: {
    error: 'string',
    hint: 'string (missing fields)',
  },
  _result_truncated: {
    warning: 'string',
    truncated: 'true',
    preview: 'string (first 2000 chars)',
  },
};

module.exports = { OUTPUT_SCHEMAS };
