/**
 * filesystem.js — FileSystem 커넥터.
 *
 * NAS, 로컬 디렉터리, 공유 드라이브 등 파일 시스템 연동.
 * 파일 목록 조회 + 텍스트 파일 읽기 (readOnly).
 *
 * Config 예시:
 *   datasources:
 *     shared-docs:
 *       type: filesystem
 *       basePath: /mnt/nas/docs
 *       allowedExtensions: [.md, .txt, .json, .yaml, .csv]
 *       maxFileSize: 1048576      # 1MB
 *       maxResults: 50
 *       agents: [knowledge, general]
 */
const fs = require('fs');
const path = require('path');
const { BaseConnector } = require('../base-connector');

class FileSystemConnector extends BaseConnector {
  constructor(id, options) {
    super(id, 'filesystem', options);
    this.basePath = options.basePath || '';
    this.allowedExtensions = new Set(options.allowedExtensions || ['.md', '.txt', '.json', '.yaml', '.csv']);
    this.maxFileSize = options.maxFileSize ?? 1048576; // 1MB
  }

  async init() {
    if (!this.basePath) throw new Error(`filesystem:${this.id} — basePath 필수`);

    const resolved = path.resolve(this.basePath);
    if (!fs.existsSync(resolved)) throw new Error(`filesystem:${this.id} — 경로 없음: ${resolved}`);
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`filesystem:${this.id} — 디렉터리 아님: ${resolved}`);

    // trailing separator 보장 — '/data'가 '/data-evil'과 prefix 충돌하지 않도록
    this.basePath = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
    this.ready = true;
    this.log.info('Connected', { basePath: this.basePath });
  }

  /**
   * 파일 시스템 조회.
   * @param {string} queryString — 명령: "list [glob]" | "read <path>" | "search <keyword>"
   * @param {object} params — { recursive: boolean }
   */
  async query(queryString, params = {}) {
    if (!this.ready) throw new Error(`filesystem:${this.id} — 초기화되지 않음`);

    const parts = queryString.trim().split(/\s+/);
    const command = (parts[0] || 'list').toLowerCase();
    const arg = parts.slice(1).join(' ');

    switch (command) {
      case 'list':
        return this._list(arg, params.recursive !== false);
      case 'read':
        return this._read(arg);
      case 'search':
        return this._search(arg, params.recursive !== false);
      default:
        return { rows: [], metadata: { error: `미지원 명령: ${command} (list|read|search)`, connector: this.id } };
    }
  }

  async destroy() {
    await super.destroy();
    this.log.info('Disconnected');
  }

  // ─── 내부 ─────────────────────────────────────────

  _list(pattern, recursive) {
    const files = this._walkDir(this.basePath, recursive)
      .filter(f => {
        if (pattern && !f.relativePath.includes(pattern)) return false;
        return this.allowedExtensions.has(path.extname(f.name).toLowerCase());
      })
      .map(f => ({
        path: f.relativePath,
        name: f.name,
        size: f.stat.size,
        modified: f.stat.mtime.toISOString(),
      }));

    return {
      rows: this.truncateResults(files),
      metadata: { connector: this.id, command: 'list', totalFiles: files.length },
    };
  }

  _read(filePath) {
    if (!filePath) return { rows: [], metadata: { error: 'read: 파일 경로 필수', connector: this.id } };

    // 절대 경로 직접 입력 차단
    if (path.isAbsolute(filePath)) {
      return { rows: [], metadata: { error: 'path traversal 차단: 절대 경로 불허', connector: this.id } };
    }

    // 경로 탈출 방지 (path traversal)
    const resolved = path.resolve(this.basePath, filePath);
    if (!resolved.startsWith(this.basePath)) {
      return { rows: [], metadata: { error: 'path traversal 차단', connector: this.id } };
    }

    if (!fs.existsSync(resolved)) {
      return { rows: [], metadata: { error: `파일 없음: ${filePath}`, connector: this.id } };
    }

    const ext = path.extname(resolved).toLowerCase();
    if (!this.allowedExtensions.has(ext)) {
      return { rows: [], metadata: { error: `허용되지 않은 확장자: ${ext}`, connector: this.id } };
    }

    const stat = fs.statSync(resolved);
    if (stat.size > this.maxFileSize) {
      return { rows: [], metadata: { error: `파일 크기 초과: ${stat.size} > ${this.maxFileSize}`, connector: this.id } };
    }

    const content = fs.readFileSync(resolved, 'utf-8');
    return {
      rows: [{ path: filePath, content, size: stat.size }],
      metadata: { connector: this.id, command: 'read', file: filePath },
    };
  }

  _search(keyword, recursive) {
    if (!keyword) return { rows: [], metadata: { error: 'search: 키워드 필수', connector: this.id } };

    const lowerKeyword = keyword.toLowerCase();
    const results = [];

    for (const f of this._walkDir(this.basePath, recursive)) {
      if (!this.allowedExtensions.has(path.extname(f.name).toLowerCase())) continue;
      if (f.stat.size > this.maxFileSize) continue;

      try {
        const content = fs.readFileSync(f.fullPath, 'utf-8');
        if (content.toLowerCase().includes(lowerKeyword)) {
          // 매칭 라인 추출 (최대 5줄)
          const matchLines = content.split('\n')
            .map((line, i) => ({ line: i + 1, text: line }))
            .filter(l => l.text.toLowerCase().includes(lowerKeyword))
            .slice(0, 5);

          results.push({
            path: f.relativePath,
            matchCount: matchLines.length,
            matches: matchLines.map(m => `L${m.line}: ${m.text.trim().slice(0, 200)}`),
          });
        }
      } catch (_) { /* skip unreadable files */ }

      if (results.length >= this.maxResults) break;
    }

    return {
      rows: results,
      metadata: { connector: this.id, command: 'search', keyword, totalMatches: results.length },
    };
  }

  _walkDir(dir, recursive, _base) {
    const base = _base || dir;
    const entries = [];
    try {
      for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, dirent.name);
        if (dirent.isFile()) {
          entries.push({
            name: dirent.name,
            fullPath,
            relativePath: path.relative(base, fullPath),
            stat: fs.statSync(fullPath),
          });
        } else if (dirent.isDirectory() && recursive && !dirent.name.startsWith('.')) {
          entries.push(...this._walkDir(fullPath, true, base));
        }
      }
    } catch (_) { /* permission denied etc */ }
    return entries;
  }
}

module.exports = { FileSystemConnector };
