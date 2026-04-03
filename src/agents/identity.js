/**
 * identity.js — 에이전트 아이덴티티 시스템 (3-레이어 페르소나).
 *
 * 각 에이전트에 3-레이어 페르소나를 부여:
 * - SOUL.md: 성격, 목소리, 커뮤니케이션 스타일
 * - IDENTITY.md: 목적, 전문 분야, 핵심 역량
 * - ROLE.md: 구체적 책임, 업무 범위, 제약사항
 *
 * 파일 기반 관리 + 핫 리로드 지원.
 * 시스템 프롬프트에 ## Soul → ## Identity → ## Role 순서로 주입.
 */
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../shared/logger');

const log = createLogger('agent:identity');

const IDENTITY_LAYERS = ['SOUL', 'IDENTITY', 'ROLE'];

class AgentIdentity {
  /**
   * @param {Object} opts
   * @param {string} [opts.identityDir='./agents'] - 에이전트 Identity 파일 디렉토리
   */
  constructor(opts = {}) {
    this.identityDir = opts.identityDir || './agents';

    /** @type {Map<string, { soul: string, identity: string, role: string, loadedAt: number }>} */
    this._identities = new Map();
  }

  /**
   * 에이전트 Identity 로드.
   * @param {string} agentId - 에이전트 ID
   * @returns {{ soul: string, identity: string, role: string }}
   */
  load(agentId) {
    agentId = agentId.replace(/[^a-zA-Z0-9_-]/g, '');
    const agentDir = path.join(this.identityDir, agentId);
    const identity = { soul: '', identity: '', role: '' };

    for (const layer of IDENTITY_LAYERS) {
      const filePath = path.join(agentDir, `${layer}.md`);
      try {
        if (fs.existsSync(filePath)) {
          identity[layer.toLowerCase()] = fs.readFileSync(filePath, 'utf-8').trim();
          log.debug(`${layer}.md loaded`, { agentId });
        }
      } catch (err) {
        log.debug(`${layer}.md not found or unreadable`, { agentId, error: err.message });
      }
    }

    this._identities.set(agentId, { ...identity, loadedAt: Date.now() });
    return identity;
  }

  /**
   * Identity를 시스템 프롬프트 형식으로 포맷.
   * @param {string} agentId
   * @returns {string} 시스템 프롬프트에 주입할 텍스트
   */
  formatForPrompt(agentId) {
    let identity = this._identities.get(agentId);
    if (!identity) identity = this.load(agentId);

    const sections = [];

    if (identity.soul) {
      sections.push(`## Soul\n${identity.soul}`);
    }
    if (identity.identity) {
      sections.push(`## Identity\n${identity.identity}`);
    }
    if (identity.role) {
      sections.push(`## Role\n${identity.role}`);
    }

    return sections.join('\n\n');
  }

  /**
   * Identity 리로드 (핫 리로드용).
   * @param {string} agentId
   */
  reload(agentId) {
    this.load(agentId);
    log.info('Identity reloaded', { agentId });
  }

  /**
   * 모든 에이전트 Identity 리로드.
   */
  reloadAll() {
    for (const agentId of this._identities.keys()) {
      this.reload(agentId);
    }
  }

  /**
   * Identity 파일 생성/업데이트.
   * @param {string} agentId
   * @param {string} layer - SOUL | IDENTITY | ROLE
   * @param {string} content - Markdown 콘텐츠
   */
  save(agentId, layer, content) {
    if (!IDENTITY_LAYERS.includes(layer.toUpperCase())) {
      throw new Error(`Invalid identity layer: ${layer}`);
    }

    agentId = agentId.replace(/[^a-zA-Z0-9_-]/g, '');
    const agentDir = path.join(this.identityDir, agentId);
    try { fs.mkdirSync(agentDir, { recursive: true }); } catch {}

    const filePath = path.join(agentDir, `${layer.toUpperCase()}.md`);
    fs.writeFileSync(filePath, content, 'utf-8');

    // 캐시 업데이트
    this.reload(agentId);
    log.info('Identity saved', { agentId, layer });
  }

  /**
   * 등록된 에이전트 Identity 목록.
   * @returns {Array<{ agentId: string, layers: string[], loadedAt: number }>}
   */
  list() {
    return Array.from(this._identities.entries()).map(([agentId, identity]) => ({
      agentId,
      layers: IDENTITY_LAYERS.filter(l => identity[l.toLowerCase()]),
      loadedAt: identity.loadedAt,
    }));
  }
}

module.exports = { AgentIdentity, IDENTITY_LAYERS };
