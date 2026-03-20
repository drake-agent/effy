/**
 * doc-ingestion.js — 외부 문서 주기적 수집 → L3 Semantic 인덱싱.
 *
 * 지원 소스:
 * - Notion (API)
 * - Google Drive (API)
 * - 로컬 파일시스템 (./data/docs/)
 *
 * 동작:
 * 1. config.ingestion.sources에서 소스 목록 로드
 * 2. 주기적으로 (intervalMs) 새/변경 문서 수집
 * 3. 텍스트 추출 → L3 Semantic에 저장 (source_type: 'document')
 * 4. 해시 기반 중복 방지
 */
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { semantic } = require('../memory/manager');
const { contentHash } = require('../shared/utils');
const { createLogger } = require('../shared/logger');

const log = createLogger('features:doc-ingestion');

class DocumentIngestion {
  constructor(opts = {}) {
    this.config = opts.config || config.ingestion || {};
    this.enabled = this.config.enabled !== false;
    this.sources = this.config.sources || [];
    this.intervalMs = this.config.intervalMs ?? 3600000;  // 1시간 기본
    this._timer = null;
    this._ingestedHashes = new Set();

    // 통계
    this.stats = { runs: 0, ingested: 0, skipped: 0, errors: 0 };
  }

  start() {
    this.stop();

    if (!this.enabled || this.sources.length === 0) {
      log.info('Document ingestion disabled (no sources)');
      return;
    }

    // 즉시 1회 실행 + 주기 반복
    this.run().catch(err => log.warn('Initial ingestion failed', { error: err.message }));
    this._timer = setInterval(() => {
      this.run().catch(err => log.warn('Ingestion cycle failed', { error: err.message }));
    }, this.intervalMs);
    if (this._timer.unref) this._timer.unref();

    log.info('Document ingestion started', { sources: this.sources.length, interval: `${this.intervalMs / 60000}m` });
  }

  async run() {
    this.stats.runs++;

    for (const source of this.sources) {
      try {
        switch (source.type) {
          case 'local':
            await this._ingestLocal(source);
            break;
          case 'notion':
            await this._ingestNotion(source);
            break;
          case 'gdrive':
            await this._ingestGDrive(source);
            break;
          default:
            log.warn('Unknown ingestion source type', { type: source.type });
        }
      } catch (err) {
        this.stats.errors++;
        log.warn('Ingestion source failed', { source: source.id, error: err.message });
      }
    }
  }

  /**
   * 로컬 파일시스템에서 .md, .txt, .json 파일 수집.
   */
  async _ingestLocal(source) {
    const basePath = path.resolve(source.path || './data/docs');
    if (!fs.existsSync(basePath)) return;

    const extensions = new Set(source.extensions || ['.md', '.txt', '.json', '.yaml']);
    const files = this._walkDir(basePath, extensions);

    for (const filePath of files) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        if (content.length < 50) continue;  // 너무 짧은 파일 스킵

        const hash = contentHash(content);
        if (this._ingestedHashes.has(hash)) { this.stats.skipped++; continue; }

        const relativePath = path.relative(basePath, filePath);
        semantic.save({
          content: content.slice(0, 5000),  // 최대 5000자
          sourceType: 'document',
          sourceId: `local:${relativePath}`,
          channelId: '',
          userId: 'ingestion',
          tags: [source.id || 'local', path.extname(filePath).slice(1)],
          poolId: source.pool || 'team',
        });

        this._ingestedHashes.add(hash);
        this.stats.ingested++;
      } catch (err) {
        this.stats.errors++;
        log.debug('File ingestion failed', { file: filePath, error: err.message });
      }
    }
  }

  /**
   * Notion API에서 페이지 수집.
   */
  async _ingestNotion(source) {
    if (!source.apiKey) { log.warn('Notion source missing apiKey'); return; }

    try {
      const res = await fetch('https://api.notion.com/v1/search', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${source.apiKey}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filter: { property: 'object', value: 'page' },
          page_size: source.limit || 20,
        }),
      });

      if (!res.ok) { log.warn('Notion API error', { status: res.status }); return; }

      const data = await res.json();
      for (const page of (data.results || [])) {
        const title = page.properties?.title?.title?.[0]?.plain_text
          || page.properties?.Name?.title?.[0]?.plain_text
          || 'Untitled';

        // 페이지 블록 가져오기
        const blocksRes = await fetch(`https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`, {
          headers: {
            'Authorization': `Bearer ${source.apiKey}`,
            'Notion-Version': '2022-06-28',
          },
        });

        if (!blocksRes.ok) continue;
        const blocks = await blocksRes.json();
        const content = blocks.results
          ?.map(b => b.paragraph?.rich_text?.map(t => t.plain_text).join('') || '')
          .filter(t => t)
          .join('\n');

        if (!content || content.length < 50) continue;

        const hash = contentHash(content);
        if (this._ingestedHashes.has(hash)) { this.stats.skipped++; continue; }

        semantic.save({
          content: `[Notion: ${title}]\n${content.slice(0, 5000)}`,
          sourceType: 'document',
          sourceId: `notion:${page.id}`,
          tags: [source.id || 'notion', 'document'],
          poolId: source.pool || 'team',
        });

        this._ingestedHashes.add(hash);
        this.stats.ingested++;
      }
    } catch (err) {
      this.stats.errors++;
      log.warn('Notion ingestion failed', { error: err.message });
    }
  }

  /**
   * Google Drive API에서 문서 수집.
   */
  async _ingestGDrive(source) {
    if (!source.apiKey && !source.serviceAccountKey) {
      log.warn('GDrive source missing credentials');
      return;
    }

    // Google Drive API는 OAuth2 또는 Service Account 필요
    // 여기서는 API key 기반 public 문서만 지원
    try {
      const folderId = source.folderId || 'root';
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+mimeType='application/vnd.google-apps.document'&key=${source.apiKey}&fields=files(id,name,modifiedTime)`,
      );

      if (!res.ok) { log.warn('GDrive API error', { status: res.status }); return; }

      const data = await res.json();
      for (const file of (data.files || []).slice(0, source.limit || 20)) {
        // Export as plain text
        const exportRes = await fetch(
          `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain&key=${source.apiKey}`,
        );
        if (!exportRes.ok) continue;

        const content = await exportRes.text();
        if (!content || content.length < 50) continue;

        const hash = contentHash(content);
        if (this._ingestedHashes.has(hash)) { this.stats.skipped++; continue; }

        semantic.save({
          content: `[GDrive: ${file.name}]\n${content.slice(0, 5000)}`,
          sourceType: 'document',
          sourceId: `gdrive:${file.id}`,
          tags: [source.id || 'gdrive', 'document'],
          poolId: source.pool || 'team',
        });

        this._ingestedHashes.add(hash);
        this.stats.ingested++;
      }
    } catch (err) {
      this.stats.errors++;
      log.warn('GDrive ingestion failed', { error: err.message });
    }
  }

  _walkDir(dir, extensions, result = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) this._walkDir(full, extensions, result);
      else if (extensions.has(path.extname(entry.name))) result.push(full);
    }
    return result;
  }

  getStats() { return this.stats; }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = { DocumentIngestion };
