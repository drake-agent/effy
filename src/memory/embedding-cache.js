/**
 * embedding-cache.js — 로컬 임베딩 캐시로 API 호출 감소
 * Local Embedding Cache
 *
 * 계산된 임베딩을 캐시하여 반복 쿼리 시 API 호출 방지.
 * 디스크 저장 지원으로 재시작 후에도 유지.
 */

const { createLogger } = require('../shared/logger');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const log = createLogger('memory/embedding-cache');

/**
 * 임베딩 캐시 클래스
 * EmbeddingCache — 로컬 메모리 및 디스크 기반 캐싱
 */
class EmbeddingCache {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.maxEntries=10000] - 최대 캐시 항목 수
   * @param {number} [opts.ttlMs=604800000] - TTL: 7일
   */
  constructor(opts = {}) {
    this.maxEntries = opts.maxEntries ?? 10000;
    this.ttlMs = opts.ttlMs ?? 86400000 * 7; // 7 days
    this._cache = new Map(); // hash → { embedding, createdAt, accessCount }
    this._hits = 0;
    this._misses = 0;
  }

  /**
   * 캐시된 임베딩 조회 또는 계산 후 캐싱
   * @param {string} text - 임베딩할 텍스트
   * @param {Function} embedFn - async (text) => number[] - cache miss 시 호출
   * @returns {Promise<{ embedding: number[], cached: boolean }>}
   */
  async getOrCompute(text, embedFn) {
    try {
      if (!text || typeof text !== 'string') {
        throw new Error('Text must be a non-empty string');
      }

      const hash = this._hash(text);
      const cached = this._cache.get(hash);

      // 캐시 히트 + 유효 기간 체크
      if (cached && Date.now() - cached.createdAt < this.ttlMs) {
        cached.accessCount += 1;
        this._hits += 1;
        log.debug('Embedding cache hit', { hitRate: this._getHitRate() });
        return { embedding: cached.embedding, cached: true };
      }

      // 캐시 미스 — embedFn 호출
      this._misses += 1;
      log.debug('Embedding cache miss', { text: text.slice(0, 50) });

      const embedding = await embedFn(text);

      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error('embedFn must return a non-empty number array');
      }

      // 캐시 저장
      this._cache.set(hash, {
        embedding,
        createdAt: Date.now(),
        accessCount: 1,
      });

      // 캐시 크기 관리
      if (this._cache.size > this.maxEntries) {
        this._evict();
      }

      return { embedding, cached: false };
    } catch (err) {
      log.error('Failed in getOrCompute', err);
      throw err;
    }
  }

  /**
   * 배치로 임베딩 조회/계산
   * @param {string[]} texts
   * @param {Function} batchEmbedFn - async (texts[]) => number[][]
   * @returns {Promise<{ embeddings: number[][], cacheHits: number, apiCalls: number }>}
   */
  async batchGetOrCompute(texts, batchEmbedFn) {
    try {
      if (!Array.isArray(texts)) {
        throw new Error('texts must be an array');
      }

      const embeddings = [];
      const uncachedTexts = [];
      const uncachedIndices = [];
      let cacheHits = 0;

      // 1단계: 캐시 조회
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        const hash = this._hash(text);
        const cached = this._cache.get(hash);

        if (cached && Date.now() - cached.createdAt < this.ttlMs) {
          cached.accessCount += 1;
          embeddings[i] = cached.embedding;
          cacheHits += 1;
          this._hits += 1;
        } else {
          uncachedTexts.push(text);
          uncachedIndices.push(i);
          embeddings[i] = null; // 플레이스홀더
        }
      }

      // 2단계: 캐시 미스에 대해 배치 임베딩
      let apiCalls = 0;
      if (uncachedTexts.length > 0) {
        apiCalls = 1;
        this._misses += uncachedTexts.length;
        const newEmbeddings = await batchEmbedFn(uncachedTexts);

        if (!Array.isArray(newEmbeddings) || newEmbeddings.length !== uncachedTexts.length) {
          throw new Error('batchEmbedFn must return array matching input length');
        }

        // 3단계: 새 임베딩 저장
        for (let i = 0; i < uncachedTexts.length; i++) {
          const text = uncachedTexts[i];
          const embedding = newEmbeddings[i];
          const originalIndex = uncachedIndices[i];

          const hash = this._hash(text);
          this._cache.set(hash, {
            embedding,
            createdAt: Date.now(),
            accessCount: 1,
          });

          embeddings[originalIndex] = embedding;
        }

        // 캐시 크기 관리
        if (this._cache.size > this.maxEntries) {
          this._evict();
        }
      }

      log.debug('Batch embedding completed', {
        total: texts.length,
        cacheHits,
        apiCalls,
      });

      return {
        embeddings,
        cacheHits,
        apiCalls,
      };
    } catch (err) {
      log.error('Failed in batchGetOrCompute', err);
      throw err;
    }
  }

  /**
   * 만료된 항목 정리
   */
  cleanup() {
    try {
      const now = Date.now();
      let removed = 0;

      for (const [hash, entry] of this._cache) {
        if (now - entry.createdAt >= this.ttlMs) {
          this._cache.delete(hash);
          removed += 1;
        }
      }

      log.info('Cache cleanup completed', { removed, remaining: this._cache.size });
    } catch (err) {
      log.error('Cleanup failed', err);
    }
  }

  /**
   * 캐시 통계 조회
   * @returns {{ size: number, maxEntries: number, hitRate: number, hits: number, misses: number }}
   */
  getStats() {
    const total = this._hits + this._misses;
    const hitRate = total > 0 ? (this._hits / total * 100).toFixed(2) : 0;

    return {
      size: this._cache.size,
      maxEntries: this.maxEntries,
      hitRate: parseFloat(hitRate),
      hits: this._hits,
      misses: this._misses,
    };
  }

  /**
   * 캐시를 디스크에 저장 (원자적 쓰기)
   * @param {string} filePath
   */
  async saveToDisk(filePath) {
    try {
      const data = {
        version: 1,
        savedAt: Date.now(),
        cache: Array.from(this._cache.entries()),
        stats: {
          hits: this._hits,
          misses: this._misses,
        },
      };

      const dir = path.dirname(filePath);
      await fs.promises.mkdir(dir, { recursive: true });

      // 임시 파일에 먼저 쓴 후 원자적 이름 변경 (race condition 방지)
      const tempFile = `${filePath}.tmp`;
      await fs.promises.writeFile(tempFile, JSON.stringify(data, null, 2));

      // 원자적 이름 변경
      await fs.promises.rename(tempFile, filePath);

      log.info('Cache saved to disk', { filePath, size: this._cache.size });
    } catch (err) {
      log.error('Failed to save cache to disk', err);
      throw err;
    }
  }

  /**
   * 디스크에서 캐시 복원
   * @param {string} filePath
   */
  async loadFromDisk(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        log.warn('Cache file not found', { filePath });
        return;
      }

      const content = await new Promise((resolve, reject) => {
        fs.readFile(filePath, 'utf8', (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      });

      const data = JSON.parse(content);

      if (data.version !== 1) {
        log.warn('Cache version mismatch', { version: data.version });
        return;
      }

      // 캐시 복원
      this._cache.clear();
      data.cache.forEach(([hash, entry]) => {
        // TTL 체크
        if (Date.now() - entry.createdAt < this.ttlMs) {
          this._cache.set(hash, entry);
        }
      });

      // 통계 복원
      if (data.stats) {
        this._hits = data.stats.hits || 0;
        this._misses = data.stats.misses || 0;
      }

      log.info('Cache loaded from disk', { filePath, size: this._cache.size });
    } catch (err) {
      log.error('Failed to load cache from disk', err);
    }
  }

  /**
   * 캐시 키 해시 계산
   * @private
   */
  _hash(text) {
    return crypto
      .createHash('sha256')
      .update(text)
      .digest('hex');
  }

  /**
   * 캐시 크기 초과 시 가장 오래되거나 사용 빈도 낮은 항목 제거
   * @private
   */
  _evict() {
    try {
      const toRemove = Math.ceil(this.maxEntries * 0.1); // 10% 제거
      let removed = 0;

      // Evict oldest entries by insertion order (Map iteration order)
      // This is O(toRemove) instead of O(n log n) full sort
      for (const key of this._cache.keys()) {
        if (removed >= toRemove) break;
        this._cache.delete(key);
        removed++;
      }

      log.debug('Cache eviction completed', { evicted: removed, remaining: this._cache.size });
    } catch (err) {
      log.error('Eviction failed', err);
    }
  }

  /**
   * 캐시 히트율 계산
   * @private
   */
  _getHitRate() {
    const total = this._hits + this._misses;
    return total > 0 ? (this._hits / total * 100).toFixed(2) : 0;
  }
}

module.exports = { EmbeddingCache };
