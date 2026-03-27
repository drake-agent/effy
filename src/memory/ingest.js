/**
 * ingest.js — 파일 자동 인제스트 파이프라인 (SpaceBot 차용).
 *
 * ingest/ 폴더에 파일을 넣으면 자동으로:
 * 1. 파일 읽기 + 청킹
 * 2. LLM으로 메모리 타입 분류 + 중요도 판정
 * 3. MemoryGraph에 타입별 메모리로 저장
 * 4. 기존 메모리와 중복 체크 + 그래프 엣지 생성
 *
 * 지원 형식: .txt, .md, .json, .csv, .pdf (텍스트 추출)
 */
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../shared/logger');

const log = createLogger('memory:ingest');

const SUPPORTED_EXTENSIONS = new Set(['.txt', '.md', '.json', '.csv', '.pdf', '.html']);
const CHUNK_SIZE = 2000; // 문자 기준

class FileIngestPipeline {
  /**
   * @param {Object} opts
   * @param {Object} opts.graph - MemoryGraph 인스턴스
   * @param {Object} [opts.anthropicClient] - Anthropic SDK
   * @param {string} [opts.ingestDir='./data/ingest'] - 감시 디렉토리
   * @param {string} [opts.processedDir='./data/ingest-processed'] - 처리 완료 이동 디렉토리
   * @param {string} [opts.model='claude-haiku-4-5-20251001']
   * @param {number} [opts.pollIntervalMs=30000] - 폴링 주기 (30초)
   */
  constructor(opts = {}) {
    this.graph = opts.graph;
    this.anthropicClient = opts.anthropicClient;
    this.ingestDir = opts.ingestDir || './data/ingest';
    this.processedDir = opts.processedDir || './data/ingest-processed';
    this.model = opts.model || 'claude-haiku-4-5-20251001';
    this.pollIntervalMs = opts.pollIntervalMs || 30000;

    /** @type {Set<string>} 처리 중인 파일 (중복 방지) */
    this._processing = new Set();
    this._timer = null;
    this._running = false;

    // 디렉토리 생성
    for (const dir of [this.ingestDir, this.processedDir]) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    }
  }

  /**
   * 파이프라인 시작 (폴링 모드).
   */
  start() {
    if (this._running) return;
    this._running = true;

    log.info('Ingest pipeline started', { dir: this.ingestDir, pollMs: this.pollIntervalMs });

    // 즉시 1회 실행
    this._poll().catch(err => log.error('Initial poll failed', { error: err.message }));

    this._timer = setInterval(() => {
      this._poll().catch(err => log.error('Poll failed', { error: err.message }));
    }, this.pollIntervalMs);
  }

  /** 파이프라인 중지. */
  stop() {
    this._running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    log.info('Ingest pipeline stopped');
  }

  /**
   * 수동 단일 파일 인제스트.
   * @param {string} filePath
   * @param {Object} [context] - { sourceChannel, sourceUser }
   * @returns {Promise<{ memoriesCreated: number, chunks: number }>}
   */
  async ingestFile(filePath, context = {}) {
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      throw new Error(`Unsupported file type: ${ext}`);
    }

    const fileName = path.basename(filePath);
    if (this._processing.has(fileName)) {
      throw new Error(`File already being processed: ${fileName}`);
    }

    this._processing.add(fileName);
    let memoriesCreated = 0;

    try {
      // 1. 파일 읽기
      const content = await this._readFile(filePath, ext);
      if (!content || content.trim().length === 0) {
        log.warn('Empty file skipped', { filePath });
        return { memoriesCreated: 0, chunks: 0 };
      }

      // 2. 청킹
      const chunks = this._chunk(content);
      log.info('File chunked', { filePath, chunks: chunks.length, totalLen: content.length });

      // 3. 각 청크를 LLM으로 분류 + 메모리 생성
      for (const chunk of chunks) {
        try {
          const memories = await this._classifyAndStore(chunk, {
            ...context,
            fileName,
            fileType: ext,
          });
          memoriesCreated += memories.length;
        } catch (err) {
          log.warn('Chunk processing failed', { error: err.message, fileName });
        }
      }

      // 4. 처리 완료 → processed 디렉토리로 이동
      const destPath = path.join(this.processedDir, fileName);
      try { fs.renameSync(filePath, destPath); } catch (moveErr) {
        log.debug('File move failed, trying copy', { error: moveErr.message });
        try { fs.copyFileSync(filePath, destPath); fs.unlinkSync(filePath); } catch {}
      }

      log.info('File ingested', { fileName, memoriesCreated, chunks: chunks.length });
      return { memoriesCreated, chunks: chunks.length };
    } finally {
      this._processing.delete(fileName);
    }
  }

  /** @private 폴링: ingest 디렉토리 스캔. */
  async _poll() {
    let files;
    try { files = fs.readdirSync(this.ingestDir); } catch { return; }

    const toIngest = files.filter(f => {
      const ext = path.extname(f).toLowerCase();
      return SUPPORTED_EXTENSIONS.has(ext) && !this._processing.has(f);
    });

    if (toIngest.length === 0) return;

    log.info('Files found for ingest', { count: toIngest.length });

    for (const file of toIngest) {
      try {
        await this.ingestFile(path.join(this.ingestDir, file));
      } catch (err) {
        log.error('File ingest failed', { file, error: err.message });
      }
    }
  }

  /** @private 파일 읽기. */
  async _readFile(filePath, ext) {
    if (ext === '.pdf') {
      // PDF 텍스트 추출 (간단한 패턴 기반)
      try {
        const buffer = fs.readFileSync(filePath);
        // 바이너리에서 텍스트 스트림 추출 (기본적)
        const text = buffer.toString('utf-8').replace(/[^\x20-\x7E\n\rㄱ-ㅎㅏ-ㅣ가-힣]/g, ' ').replace(/\s+/g, ' ');
        return text.trim();
      } catch { return ''; }
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  /** @private 텍스트 청킹. */
  _chunk(text) {
    const chunks = [];
    const paragraphs = text.split(/\n\n+/);
    let current = '';

    for (const para of paragraphs) {
      if ((current + '\n\n' + para).length > CHUNK_SIZE && current.length > 0) {
        chunks.push(current.trim());
        current = para;
      } else {
        current = current ? current + '\n\n' + para : para;
      }
    }
    if (current.trim().length > 0) chunks.push(current.trim());

    return chunks;
  }

  /** @private LLM으로 메모리 분류 + 저장. */
  async _classifyAndStore(chunk, context) {
    if (!this.anthropicClient || !this.graph) {
      // LLM 없이 fact 타입으로 직접 저장
      const id = this.graph.create({
        type: 'fact',
        content: chunk.slice(0, 500),
        sourceChannel: context.sourceChannel || '',
        sourceUser: context.sourceUser || 'system:ingest',
        importance: 0.4,
        metadata: { source: 'file_ingest', fileName: context.fileName },
      });
      return id ? [{ id, type: 'fact' }] : [];
    }

    try {
      const response = await this.anthropicClient.messages.create({
        model: this.model,
        max_tokens: 500,
        system: `텍스트에서 구조화된 메모리를 추출하세요. JSON 배열로 반환:
[{"type": "fact|decision|observation|event|preference|goal|todo|identity", "content": "간결한 메모리 (200자 이내)", "importance": 0.0-1.0}]
- 중요한 정보만 추출 (노이즈 제외)
- 최대 5개까지
- JSON만 출력`,
        messages: [{ role: 'user', content: `파일: ${context.fileName}\n\n${chunk}` }],
      });

      const text = response.content[0]?.text || '[]';
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return [];

      const memories = JSON.parse(match[0]);
      const created = [];

      for (const mem of memories) {
        if (!mem.type || !mem.content) continue;
        try {
          const id = this.graph.create({
            type: mem.type,
            content: mem.content.slice(0, 500),
            sourceChannel: context.sourceChannel || '',
            sourceUser: context.sourceUser || 'system:ingest',
            importance: Math.min(1, Math.max(0, mem.importance || 0.5)),
            metadata: { source: 'file_ingest', fileName: context.fileName },
          });
          if (id) created.push({ id, type: mem.type });
        } catch (err) {
          log.debug('Memory create failed', { error: err.message });
        }
      }

      return created;
    } catch (err) {
      log.error('LLM classification failed', { error: err.message });
      return [];
    }
  }
}

module.exports = { FileIngestPipeline };
