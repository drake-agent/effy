/**
 * attachments.js — 첨부파일 영속화 + 리콜 (SpaceBot 차용).
 *
 * 채널 첨부파일을 디스크에 영속화하고 나중에 recall 가능.
 * 메타데이터를 SQLite에 저장, 파일은 로컬 디렉토리에 보관.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('../db/sqlite');
const { createLogger } = require('../shared/logger');

const log = createLogger('memory:attachments');

class AttachmentStore {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.storageDir='./data/attachments'] - 파일 저장 디렉토리
   * @param {number} [opts.maxFileSizeMb=50] - 최대 파일 크기 (MB)
   * @param {number} [opts.retentionDays=90] - 보관 기간 (일)
   */
  constructor(opts = {}) {
    this.storageDir = opts.storageDir || './data/attachments';
    this.maxFileSizeMb = opts.maxFileSizeMb || 50;
    this.retentionDays = opts.retentionDays || 90;

    try { fs.mkdirSync(this.storageDir, { recursive: true }); } catch {}
    this._ensureTable();
  }

  /** @private DB 테이블 생성. */
  _ensureTable() {
    try {
      const db = getDb();
      db.exec(`
        CREATE TABLE IF NOT EXISTS attachments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_hash TEXT UNIQUE NOT NULL,
          original_name TEXT NOT NULL,
          stored_path TEXT NOT NULL,
          mime_type TEXT DEFAULT '',
          file_size INTEGER DEFAULT 0,
          source_channel TEXT DEFAULT '',
          source_user TEXT DEFAULT '',
          source_message_id TEXT DEFAULT '',
          metadata TEXT DEFAULT '{}',
          created_at TEXT DEFAULT (datetime('now')),
          last_recalled_at TEXT
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_attach_channel ON attachments(source_channel)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_attach_user ON attachments(source_user)');
    } catch (err) {
      log.debug('Attachment table creation skipped', { error: err.message });
    }
  }

  /**
   * 첨부파일 저장.
   * @param {Object} opts
   * @param {Buffer|string} opts.content - 파일 내용
   * @param {string} opts.originalName - 원본 파일명
   * @param {string} [opts.mimeType='']
   * @param {string} [opts.channelId='']
   * @param {string} [opts.userId='']
   * @param {string} [opts.messageId='']
   * @param {Object} [opts.metadata={}]
   * @returns {{ id: number, hash: string, path: string } | null}
   */
  save(opts) {
    const { content, originalName, mimeType = '', channelId = '', userId = '', messageId = '', metadata = {} } = opts;

    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');

    // 크기 제한 확인
    if (buffer.length > this.maxFileSizeMb * 1024 * 1024) {
      log.warn('Attachment too large', { originalName, sizeMb: (buffer.length / 1024 / 1024).toFixed(1) });
      return null;
    }

    // 파일명 새니타이제이션: path separators 제거 + 베이스명만 사용
    const baseName = path.basename(originalName || 'file');

    // 확장자 화이트리스트 (사용 가능한 확장자만)
    const ALLOWED_EXTENSIONS = new Set([
      '.txt', '.md', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv',
      '.jpg', '.jpeg', '.png', '.gif', '.webp',
      '.json', '.yaml', '.yml', '.xml',
      '.zip', '.tar', '.gz',
    ]);
    const ext = path.extname(baseName).toLowerCase();
    const safeExt = ALLOWED_EXTENSIONS.has(ext) ? ext : '';

    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const storedName = `${hash.slice(0, 16)}${safeExt}`;
    const storedPath = path.join(this.storageDir, storedName);

    try {
      // 파일 저장
      fs.writeFileSync(storedPath, buffer);

      // DB 메타데이터 저장
      const db = getDb();
      const result = db.prepare(`
        INSERT OR IGNORE INTO attachments (file_hash, original_name, stored_path, mime_type, file_size, source_channel, source_user, source_message_id, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(hash, originalName, storedPath, mimeType, buffer.length, channelId, userId, messageId, JSON.stringify(metadata));

      let id = result.lastInsertRowid;
      if (!id) {
        const existing = db.prepare('SELECT id FROM attachments WHERE file_hash = ?').get(hash);
        id = existing?.id;
      }

      log.info('Attachment saved', { id, originalName, hash: hash.slice(0, 8), sizeMb: (buffer.length / 1024 / 1024).toFixed(2) });
      return { id, hash, path: storedPath };
    } catch (err) {
      log.error('Attachment save failed', { error: err.message, originalName });
      return null;
    }
  }

  /**
   * 첨부파일 리콜 (검색).
   * @param {Object} [opts]
   * @param {string} [opts.channelId]
   * @param {string} [opts.userId]
   * @param {string} [opts.namePattern] - 파일명 패턴 (LIKE)
   * @param {number} [opts.limit=10]
   * @returns {Array}
   */
  recall({ channelId, userId, namePattern, limit = 10 } = {}) {
    const db = getDb();
    try {
      let sql = 'SELECT * FROM attachments WHERE 1=1';
      const params = [];

      if (channelId) { sql += ' AND source_channel = ?'; params.push(channelId); }
      if (userId) { sql += ' AND source_user = ?'; params.push(userId); }
      if (namePattern) { sql += ' AND original_name LIKE ?'; params.push(`%${namePattern}%`); }

      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);

      const rows = db.prepare(sql).all(...params);

      // last_recalled_at 업데이트
      const updateStmt = db.prepare('UPDATE attachments SET last_recalled_at = datetime(\'now\') WHERE id = ?');
      for (const row of rows) updateStmt.run(row.id);

      return rows.map(row => ({
        id: row.id,
        name: row.original_name,
        path: row.stored_path,
        mimeType: row.mime_type,
        fileSize: row.file_size,
        channel: row.source_channel,
        user: row.source_user,
        createdAt: row.created_at,
        exists: fs.existsSync(row.stored_path),
      }));
    } catch (err) {
      log.error('Attachment recall failed', { error: err.message });
      return [];
    }
  }

  /**
   * 첨부파일 내용 읽기.
   * @param {number} id - 첨부파일 ID
   * @returns {{ content: Buffer, metadata: Object } | null}
   */
  read(id) {
    const db = getDb();
    try {
      const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
      if (!row || !fs.existsSync(row.stored_path)) return null;

      const content = fs.readFileSync(row.stored_path);
      db.prepare('UPDATE attachments SET last_recalled_at = datetime(\'now\') WHERE id = ?').run(id);

      return { content, metadata: JSON.parse(row.metadata || '{}'), originalName: row.original_name };
    } catch (err) {
      log.error('Attachment read failed', { error: err.message, id });
      return null;
    }
  }

  /**
   * 만료된 첨부파일 정리.
   * @returns {number} 삭제된 파일 수
   */
  cleanup() {
    const db = getDb();
    try {
      const cutoff = new Date(Date.now() - this.retentionDays * 86400000).toISOString();
      const expired = db.prepare('SELECT id, stored_path FROM attachments WHERE created_at < ?').all(cutoff);

      let removed = 0;
      for (const row of expired) {
        try { fs.unlinkSync(row.stored_path); } catch {}
        db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
        removed++;
      }

      if (removed > 0) log.info('Expired attachments cleaned', { removed });
      return removed;
    } catch (err) {
      log.error('Attachment cleanup failed', { error: err.message });
      return 0;
    }
  }
}

module.exports = { AttachmentStore };
