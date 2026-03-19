/**
 * file-handler.js — Slack 첨부파일 다운로드 + 텍스트 추출.
 *
 * Slack 메시지에 첨부된 파일을 다운로드하고, 텍스트 기반 파일은
 * 내용을 추출하여 에이전트 컨텍스트에 포함시킵니다.
 *
 * 지원 형식:
 * - 텍스트: .txt, .md, .csv, .json, .yaml, .yml, .xml, .html
 * - 코드: .js, .ts, .py, .java, .go, .rs, .rb, .sh, .sql, .css
 * - 문서: .log, .env.example, .gitignore, .dockerfile
 *
 * 제한:
 * - 바이너리 파일 (이미지, 비디오, PDF) → 파일명만 표시
 * - 최대 파일 크기: 100KB (초과 시 첫 100KB만 추출)
 * - Slack Bot Token으로 인증된 다운로드
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('gateway:file-handler');

const TEXT_EXTENSIONS = new Set([
  // 텍스트
  'txt', 'md', 'csv', 'json', 'yaml', 'yml', 'xml', 'html', 'htm', 'toml', 'ini', 'cfg',
  // 코드
  'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'go', 'rs', 'rb', 'php', 'c', 'cpp', 'h',
  'sh', 'bash', 'zsh', 'sql', 'css', 'scss', 'less', 'swift', 'kt', 'dart',
  // 설정/문서
  'log', 'env', 'gitignore', 'dockerfile', 'makefile', 'editorconfig',
]);

const MAX_FILE_BYTES = 100 * 1024;  // 100KB

/**
 * Slack 파일 목록에서 텍스트 추출 가능한 파일을 다운로드.
 *
 * @param {Array} files - Slack event.files 배열
 * @param {string} botToken - Slack Bot Token (다운로드 인증용)
 * @returns {Array<{ name, type, content?, size, truncated? }>}
 */
async function extractFileContents(files, botToken) {
  if (!files || files.length === 0) return [];

  const results = [];

  for (const file of files.slice(0, 5)) {  // 최대 5개 파일
    const ext = (file.name || '').split('.').pop()?.toLowerCase() || '';
    const entry = {
      name: file.name || 'unknown',
      type: file.filetype || ext,
      size: file.size || 0,
    };

    // 바이너리 파일 → 파일명만 표시
    if (!TEXT_EXTENSIONS.has(ext)) {
      entry.content = null;
      entry.note = `(바이너리 파일 — 텍스트 추출 불가: ${file.mimetype || ext})`;
      results.push(entry);
      continue;
    }

    // 크기 제한
    if (file.size > MAX_FILE_BYTES * 10) {  // 1MB 초과 → 스킵
      entry.content = null;
      entry.note = `(파일 크기 초과: ${(file.size / 1024).toFixed(0)}KB > 1MB)`;
      results.push(entry);
      continue;
    }

    // 다운로드
    const downloadUrl = file.url_private_download || file.url_private;
    if (!downloadUrl || !botToken) {
      entry.content = null;
      entry.note = '(다운로드 URL 없음)';
      results.push(entry);
      continue;
    }

    try {
      // R4-PERF-2: 5초 타임아웃 (파이프라인 블로킹 방지)
      const controller = new AbortController();
      const fetchTimeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${botToken}` },
        signal: controller.signal,
      });
      clearTimeout(fetchTimeout);

      if (!res.ok) {
        entry.content = null;
        entry.note = `(다운로드 실패: HTTP ${res.status})`;
        results.push(entry);
        continue;
      }

      const buffer = await res.arrayBuffer();
      let text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);

      // 크기 제한 적용
      if (text.length > MAX_FILE_BYTES) {
        text = text.slice(0, MAX_FILE_BYTES);
        entry.truncated = true;
      }

      entry.content = text;
      log.debug('File content extracted', { name: file.name, size: text.length, truncated: !!entry.truncated });
    } catch (err) {
      entry.content = null;
      entry.note = `(다운로드 에러: ${err.message})`;
      log.warn('File download failed', { name: file.name, error: err.message });
    }

    results.push(entry);
  }

  return results;
}

/**
 * 추출된 파일 내용을 에이전트 메시지에 포함시킬 텍스트로 포맷.
 *
 * @param {Array} fileContents - extractFileContents 결과
 * @returns {string} 에이전트 컨텍스트에 추가할 텍스트
 */
function formatFilesForContext(fileContents) {
  if (!fileContents || fileContents.length === 0) return '';

  const parts = fileContents.map(f => {
    if (f.content) {
      const truncNote = f.truncated ? ' (첫 100KB만 표시)' : '';
      return `[첨부파일: ${f.name}${truncNote}]\n\`\`\`${f.type}\n${f.content}\n\`\`\``;
    }
    return `[첨부파일: ${f.name}] ${f.note || ''}`;
  });

  return '\n\n' + parts.join('\n\n');
}

module.exports = { extractFileContents, formatFilesForContext, TEXT_EXTENSIONS };
