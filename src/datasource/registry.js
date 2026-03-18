/**
 * registry.js — DataSource Connector Registry.
 *
 * 싱글톤 레지스트리. config.datasources에서 커넥터를 자동 로드.
 * 새 커넥터 타입 추가 시 CONNECTOR_TYPES에 매핑만 추가하면 됨.
 *
 * 사용 패턴:
 *   const { getRegistry } = require('../datasource/registry');
 *   const registry = getRegistry(config);
 *   await registry.init();
 *   const result = await registry.query('erp-api', '/employees', {}, 'general');
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('datasource:registry');

// ─── 커넥터 타입 → 클래스 매핑 ───
// 새 커넥터 추가 시 여기에 한 줄만 추가
const CONNECTOR_TYPES = {
  rest_api: () => require('./connectors/rest-api').RestApiConnector,
  sql: () => require('./connectors/sql-database').SqlDatabaseConnector,
  filesystem: () => require('./connectors/filesystem').FileSystemConnector,
};

class DataSourceRegistry {
  constructor() {
    /** @type {Map<string, import('./base-connector').BaseConnector>} */
    this.connectors = new Map();
    this.initialized = false;
  }

  /**
   * config.datasources에서 커넥터 인스턴스 생성 및 초기화.
   * 개별 커넥터 init 실패는 전체를 중단하지 않음 (graceful degradation).
   *
   * @param {object} datasourcesConfig — config.datasources 섹션
   */
  async init(datasourcesConfig = []) {
    if (this.initialized) {
      log.warn('Registry already initialized, skipping duplicate init()');
      return;
    }

    // 배열(YAML list) 또는 객체(key-value) 모두 지원
    const entries = Array.isArray(datasourcesConfig)
      ? datasourcesConfig.map(ds => [ds.id, ds])
      : Object.entries(datasourcesConfig);

    if (entries.length === 0) {
      log.info('No datasources configured');
      this.initialized = true;
      return;
    }

    for (const [id, opts] of entries) {
      if (!id) {
        log.error('Datasource entry missing id, skipped');
        continue;
      }
      if (opts.enabled === false) {
        log.info('Skipped (disabled)', { id });
        continue;
      }

      const type = opts.type;
      if (!type || !CONNECTOR_TYPES[type]) {
        log.error('Unknown connector type', { id, type, available: Object.keys(CONNECTOR_TYPES) });
        continue;
      }

      try {
        const ConnectorClass = CONNECTOR_TYPES[type]();
        // Config 구조 평탄화: { id, type, options: {...}, allowedAgents } → 커넥터에 순수 options만 전달
        const rawOpts = opts.options || {};
        const { id: _id, type: _type, enabled: _en, allowedAgents: _aa, options: _nested, ...restOpts } = opts;
        const connOpts = {
          ...restOpts,
          ...rawOpts,
          agents: opts.allowedAgents || rawOpts.agents || ['*'],
        };
        const connector = new ConnectorClass(id, connOpts);
        await connector.init();
        this.connectors.set(id, connector);
        log.info('Registered', { id, type, ready: connector.ready });
      } catch (e) {
        log.error('Init failed', { id, type, error: e.message });
        // 실패해도 다른 커넥터 계속 진행
      }
    }

    this.initialized = true;
    log.info('Registry ready', { count: this.connectors.size, ids: [...this.connectors.keys()] });
  }

  /**
   * 커넥터를 통해 데이터 조회.
   *
   * @param {string} connectorId — 커넥터 ID
   * @param {string} queryString — 커넥터별 쿼리
   * @param {object} params      — 추가 파라미터
   * @param {string} agentId     — 요청한 에이전트 (접근 제어)
   * @returns {Promise<{ rows: Array, metadata: object }>}
   */
  async query(connectorId, queryString, params = {}, agentId = '*') {
    const connector = this.connectors.get(connectorId);

    if (!connector) {
      return {
        rows: [],
        metadata: {
          error: `커넥터 없음: ${connectorId}`,
          hint: `사용 가능: ${[...this.connectors.keys()].join(', ') || '없음'}`,
        },
      };
    }

    // 에이전트 접근 권한 검증
    if (!connector.canAccess(agentId)) {
      return {
        rows: [],
        metadata: {
          error: `접근 거부: 에이전트 '${agentId}'는 '${connectorId}'에 접근 불가`,
          hint: `허용된 에이전트: ${connector.allowedAgents.join(', ')}`,
        },
      };
    }

    try {
      return await connector.query(queryString, params);
    } catch (e) {
      log.error('Query error', { connector: connectorId, error: e.message });
      return { rows: [], metadata: { error: e.message, connector: connectorId } };
    }
  }

  /**
   * 모든 커넥터 목록 반환 (LLM 컨텍스트용).
   * @param {string} agentId — 필터링할 에이전트 (optional)
   * @returns {Array<object>}
   */
  listConnectors(agentId) {
    const list = [];
    for (const connector of this.connectors.values()) {
      if (agentId && !connector.canAccess(agentId)) continue;
      list.push(connector.describe());
    }
    return list;
  }

  /**
   * 특정 커넥터 가져오기.
   * @param {string} id
   * @returns {import('./base-connector').BaseConnector|undefined}
   */
  get(id) {
    return this.connectors.get(id);
  }

  /**
   * 모든 커넥터 정리.
   */
  async destroy() {
    for (const [id, connector] of this.connectors) {
      try {
        await connector.destroy();
      } catch (e) {
        log.error('Destroy failed', { id, error: e.message });
      }
    }
    this.connectors.clear();
    this.initialized = false;
    log.info('Registry destroyed');
  }
}

// ─── 싱글톤 ─────────────────────────────────────────

let _instance = null;

/**
 * 싱글톤 레지스트리 반환. 첫 호출 시 생성.
 * @returns {DataSourceRegistry}
 */
function getRegistry() {
  if (!_instance) {
    _instance = new DataSourceRegistry();
  }
  return _instance;
}

/**
 * 테스트용 리셋.
 */
function resetRegistry() {
  if (_instance) {
    _instance.destroy().catch(() => {});
    _instance = null;
  }
}

module.exports = { DataSourceRegistry, getRegistry, resetRegistry, CONNECTOR_TYPES };
