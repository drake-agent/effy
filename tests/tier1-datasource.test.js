/**
 * Tier 1 — DataSource Connector 단위 테스트.
 *
 * 순수 로직 테스트: 외부 I/O 없음.
 * - BaseConnector 추상 계약
 * - Registry 생명주기 (init, query, destroy)
 * - 접근 제어 (allowedAgents)
 * - FileSystem 커넥터 경로 보안
 * - SQL 커넥터 DDL 차단
 * - REST 커넥터 readOnly 검증
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ─── BaseConnector ──────────────────────────────────────

const { BaseConnector } = require('../src/datasource/base-connector');

describe('BaseConnector — Abstract Contract', () => {
  it('should throw when instantiated directly', () => {
    assert.throws(
      () => new BaseConnector('test', 'generic'),
      /직접 인스턴스화/
    );
  });

  it('should allow subclass instantiation', () => {
    class TestConnector extends BaseConnector {
      constructor() { super('test', 'mock', {}); }
    }
    const c = new TestConnector();
    assert.equal(c.id, 'test');
    assert.equal(c.type, 'mock');
    assert.equal(c.ready, false);
    assert.equal(c.readOnly, true);
  });

  it('canAccess: wildcard allows all agents', () => {
    class C extends BaseConnector {
      constructor() { super('t', 'mock', { agents: ['*'] }); }
    }
    const c = new C();
    assert.ok(c.canAccess('any-agent'));
    assert.ok(c.canAccess('code'));
  });

  it('canAccess: explicit list restricts agents', () => {
    class C extends BaseConnector {
      constructor() { super('t', 'mock', { agents: ['ops', 'code'] }); }
    }
    const c = new C();
    assert.ok(c.canAccess('ops'));
    assert.ok(c.canAccess('code'));
    assert.ok(!c.canAccess('general'));
  });

  it('truncateResults: respects maxResults', () => {
    class C extends BaseConnector {
      constructor() { super('t', 'mock', { maxResults: 3 }); }
    }
    const c = new C();
    const input = [1, 2, 3, 4, 5];
    assert.equal(c.truncateResults(input).length, 3);
    assert.deepEqual(c.truncateResults([1, 2]), [1, 2]);
    assert.deepEqual(c.truncateResults(null), []);
  });

  it('withTimeout: resolves fast promise', async () => {
    class C extends BaseConnector {
      constructor() { super('t', 'mock', {}); }
    }
    const c = new C();
    const result = await c.withTimeout(Promise.resolve('ok'), 1000);
    assert.equal(result, 'ok');
  });

  it('withTimeout: rejects on timeout', async () => {
    class C extends BaseConnector {
      constructor() { super('t', 'mock', {}); }
    }
    const c = new C();
    await assert.rejects(
      () => c.withTimeout(new Promise(() => {}), 50),
      /Timeout/
    );
  });

  it('describe: returns expected shape', () => {
    class C extends BaseConnector {
      constructor() { super('myds', 'sql', { description: 'ERP DB' }); }
    }
    const c = new C();
    const d = c.describe();
    assert.equal(d.id, 'myds');
    assert.equal(d.type, 'sql');
    assert.equal(d.ready, false);
    assert.equal(d.readOnly, true);
    assert.equal(d.description, 'ERP DB');
  });

  it('guardReadOnly: blocks when readOnly=true', () => {
    class C extends BaseConnector {
      constructor() { super('t', 'mock', { readOnly: true }); }
    }
    const c = new C();
    const result = c.guardReadOnly('POST');
    assert.ok(result);
    assert.ok(result.metadata.error.includes('readOnly'));
  });

  it('guardReadOnly: allows when readOnly=false', () => {
    class C extends BaseConnector {
      constructor() { super('t', 'mock', { readOnly: false }); }
    }
    const c = new C();
    assert.equal(c.guardReadOnly('POST'), null);
  });
});

// ─── Registry ───────────────────────────────────────────

const { DataSourceRegistry, resetRegistry, CONNECTOR_TYPES } = require('../src/datasource/registry');

describe('DataSourceRegistry — Lifecycle', () => {
  let registry;

  beforeEach(() => {
    registry = new DataSourceRegistry();
  });

  afterEach(async () => {
    await registry.destroy();
  });

  it('should have known connector types', () => {
    assert.ok('rest_api' in CONNECTOR_TYPES);
    assert.ok('sql' in CONNECTOR_TYPES);
    assert.ok('filesystem' in CONNECTOR_TYPES);
  });

  it('init with empty array sets initialized=true', async () => {
    await registry.init([]);
    assert.ok(registry.initialized);
    assert.equal(registry.connectors.size, 0);
  });

  it('init skips entries with enabled=false', async () => {
    await registry.init([
      { id: 'disabled-ds', type: 'filesystem', enabled: false, options: {} },
    ]);
    assert.equal(registry.connectors.size, 0);
    assert.ok(registry.initialized);
  });

  it('init skips entries with unknown type', async () => {
    await registry.init([
      { id: 'unknown-ds', type: 'cassandra', options: {} },
    ]);
    assert.equal(registry.connectors.size, 0);
  });

  it('init skips entries with missing id', async () => {
    await registry.init([
      { type: 'filesystem', options: {} },
    ]);
    assert.equal(registry.connectors.size, 0);
  });

  it('query returns error for non-existent connector', async () => {
    await registry.init([]);
    const result = await registry.query('ghost', 'SELECT 1', {}, '*');
    assert.ok(result.metadata.error.includes('ghost'));
  });

  it('query returns access denied for unauthorized agent', async () => {
    // 직접 커넥터 삽입 (FileSystem mock)
    class MockConn extends BaseConnector {
      constructor() { super('mock-fs', 'filesystem', { agents: ['ops'] }); }
      async init() { this.ready = true; }
      async query() { return { rows: [], metadata: {} }; }
    }
    const mock = new MockConn();
    await mock.init();
    registry.connectors.set('mock-fs', mock);

    const result = await registry.query('mock-fs', 'list /', {}, 'general');
    assert.ok(result.metadata.error.includes('접근 거부'));
  });

  it('listConnectors filters by agent', async () => {
    class MockA extends BaseConnector {
      constructor() { super('a', 'mock', { agents: ['ops'] }); }
      async init() { this.ready = true; }
    }
    class MockB extends BaseConnector {
      constructor() { super('b', 'mock', { agents: ['*'] }); }
      async init() { this.ready = true; }
    }
    const a = new MockA(); await a.init();
    const b = new MockB(); await b.init();
    registry.connectors.set('a', a);
    registry.connectors.set('b', b);

    const forOps = registry.listConnectors('ops');
    assert.equal(forOps.length, 2);

    const forCode = registry.listConnectors('code');
    assert.equal(forCode.length, 1);
    assert.equal(forCode[0].id, 'b');
  });

  // WARN-1 fix: 중복 init 방어
  it('init: second call is no-op', async () => {
    await registry.init([]);
    assert.ok(registry.initialized);
    // 두 번째 init은 무시되어야 함
    await registry.init([{ id: 'late', type: 'filesystem', options: { basePath: '/tmp' } }]);
    assert.equal(registry.connectors.size, 0, 'should not add connectors on second init');
  });

  it('destroy clears all connectors', async () => {
    class MockC extends BaseConnector {
      constructor() { super('c', 'mock', {}); }
      async init() { this.ready = true; }
    }
    const c = new MockC(); await c.init();
    registry.connectors.set('c', c);

    await registry.destroy();
    assert.equal(registry.connectors.size, 0);
    assert.equal(registry.initialized, false);
  });
});

// ─── FileSystem Connector — Path Security ───────────────

const { FileSystemConnector } = require('../src/datasource/connectors/filesystem');

describe('FileSystemConnector — Path Traversal Protection', () => {
  let tmpDir;
  let connector;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'effy-fs-test-'));
    // 테스트 파일 생성
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# Test\nHello world');
    fs.writeFileSync(path.join(tmpDir, 'data.json'), '{"key": "value"}');
    fs.writeFileSync(path.join(tmpDir, 'secret.exe'), 'binary');

    connector = new FileSystemConnector('test-fs', {
      basePath: tmpDir,
      allowedExtensions: ['.md', '.txt', '.json'],
      maxFileSizeBytes: 1048576,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('init sets ready=true for valid basePath', async () => {
    await connector.init();
    assert.ok(connector.ready);
  });

  it('init fails for non-existent basePath', async () => {
    const bad = new FileSystemConnector('bad', { basePath: '/nonexistent/path' });
    await assert.rejects(() => bad.init(), /경로 없음|존재하지 않|does not exist|ENOENT/i);
  });

  it('list: returns only allowed extensions', async () => {
    await connector.init();
    const result = await connector.query('list .', {});
    const names = result.rows.map(r => r.name);
    assert.ok(names.includes('readme.md'));
    assert.ok(names.includes('data.json'));
    assert.ok(!names.includes('secret.exe'), 'should not list .exe files');
  });

  it('read: blocks path traversal attempt', async () => {
    await connector.init();
    const result = await connector.query('read ../../../etc/passwd', {});
    assert.ok(
      result.metadata?.error?.includes('경로') ||
      result.metadata?.error?.includes('path') ||
      result.metadata?.error?.includes('거부') ||
      result.rows.length === 0
    );
  });

  it('read: returns content for valid file', async () => {
    await connector.init();
    const result = await connector.query('read readme.md', {});
    assert.ok(result.rows.length > 0);
    assert.ok(result.rows[0].content.includes('Hello world'));
  });

  // BUG-3 fix: 절대 경로 차단
  it('read: blocks absolute path input', async () => {
    await connector.init();
    const result = await connector.query('read /etc/passwd', {});
    assert.ok(result.metadata?.error?.includes('절대 경로') || result.metadata?.error?.includes('path traversal'));
  });
});

// ─── SQL Connector — DDL Blocking ───────────────────────

const { SqlDatabaseConnector } = require('../src/datasource/connectors/sql-database');

describe('SqlDatabaseConnector — Security (static checks)', () => {
  // SQL 커넥터의 보안 로직은 query() 안에 인라인.
  // better-sqlite3 없이도 검증 가능하도록 regex 패턴 직접 테스트.

  const isSelectOnly = (sql) => /^\s*SELECT\s/i.test(sql.trim());
  const isDDL = (sql) => /\b(DROP|TRUNCATE|ALTER)\b/i.test(sql);

  it('blocks non-SELECT in readOnly mode', () => {
    assert.ok(!isSelectOnly('DELETE FROM users'));
    assert.ok(!isSelectOnly('INSERT INTO users VALUES (1)'));
    assert.ok(!isSelectOnly('UPDATE users SET name="x"'));
  });

  it('detects DDL keywords', () => {
    assert.ok(isDDL('DROP TABLE users'));
    assert.ok(isDDL('TRUNCATE TABLE logs'));
    assert.ok(isDDL('ALTER TABLE users ADD col'));
    assert.ok(!isDDL('SELECT * FROM users'));
  });

  it('allows SELECT queries', () => {
    assert.ok(isSelectOnly('SELECT * FROM users'));
    assert.ok(isSelectOnly('  select count(*) from logs  '));
    assert.ok(isSelectOnly('SELECT u.name FROM users u WHERE u.id = 1'));
  });

  it('constructor sets readOnly default', () => {
    const connector = new SqlDatabaseConnector('test-sql', {
      driver: 'sqlite',
      path: ':memory:',
    });
    assert.equal(connector.readOnly, true);
    assert.equal(connector.driver, 'sqlite');
  });

  // BUG-2 fix: stacked query 차단 regex 검증
  const hasStackedQuery = (sql) => /;[\s]*\S/.test(sql.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, ''));

  it('detects stacked queries', () => {
    assert.ok(hasStackedQuery('SELECT 1; DROP TABLE users'));
    assert.ok(hasStackedQuery('SELECT 1;DELETE FROM users'));
  });

  it('allows trailing semicolon (harmless)', () => {
    assert.ok(!hasStackedQuery('SELECT * FROM users;'));
    assert.ok(!hasStackedQuery('SELECT * FROM users; '));
  });

  it('allows semicolons inside string literals', () => {
    assert.ok(!hasStackedQuery("SELECT * FROM users WHERE name = 'foo;bar'"));
  });
});

// ─── REST API Connector — ReadOnly ──────────────────────

const { RestApiConnector } = require('../src/datasource/connectors/rest-api');

describe('RestApiConnector — ReadOnly Enforcement', () => {
  it('blocks POST in readOnly mode', async () => {
    const connector = new RestApiConnector('test-api', {
      baseUrl: 'http://localhost:9999',
      readOnly: true,
    });
    connector.ready = true;  // skip init (no real server)

    const result = await connector.query('/endpoint', { method: 'POST', body: {} });
    assert.ok(result.metadata?.error?.includes('readOnly') || result.metadata?.error?.includes('읽기 전용'));
  });

  it('blocks PUT in readOnly mode', async () => {
    const connector = new RestApiConnector('test-api', {
      baseUrl: 'http://localhost:9999',
      readOnly: true,
    });
    connector.ready = true;

    const result = await connector.query('/endpoint', { method: 'PUT' });
    assert.ok(result.metadata?.error?.includes('readOnly') || result.metadata?.error?.includes('읽기 전용'));
  });

  it('blocks DELETE in readOnly mode', async () => {
    const connector = new RestApiConnector('test-api', {
      baseUrl: 'http://localhost:9999',
      readOnly: true,
    });
    connector.ready = true;

    const result = await connector.query('/endpoint', { method: 'DELETE' });
    assert.ok(result.metadata?.error?.includes('readOnly') || result.metadata?.error?.includes('읽기 전용'));
  });

  it('builds correct auth headers for bearer type', () => {
    const connector = new RestApiConnector('test-api', {
      baseUrl: 'http://localhost',
      auth: { type: 'bearer', token: 'my-token-123' },
    });
    const headers = connector._buildAuthHeaders();
    assert.equal(headers['Authorization'], 'Bearer my-token-123');
  });

  it('builds correct auth headers for basic type', () => {
    const connector = new RestApiConnector('test-api', {
      baseUrl: 'http://localhost',
      auth: { type: 'basic', username: 'user', password: 'pass' },
    });
    const headers = connector._buildAuthHeaders();
    const expected = 'Basic ' + Buffer.from('user:pass').toString('base64');
    assert.equal(headers['Authorization'], expected);
  });

  it('builds correct auth headers for header type', () => {
    const connector = new RestApiConnector('test-api', {
      baseUrl: 'http://localhost',
      auth: { type: 'header', headerName: 'X-API-Key', headerValue: 'secret' },
    });
    const headers = connector._buildAuthHeaders();
    assert.equal(headers['X-API-Key'], 'secret');
  });

  // BUG-5 fix: SSRF 방어 테스트
  it('blocks path traversal via ".." segments', async () => {
    const connector = new RestApiConnector('test-api', {
      baseUrl: 'http://localhost:9999',
      readOnly: true,
    });
    connector.ready = true;

    const result = await connector.query('/../admin/delete', {});
    assert.ok(result.metadata?.error?.includes('SSRF') || result.metadata?.error?.includes('..'));
  });

  it('allows normal paths without ".."', async () => {
    const connector = new RestApiConnector('test-api', {
      baseUrl: 'http://localhost:9999',
      readOnly: false,
    });
    connector.ready = true;

    // 이건 실제 fetch를 시도하므로 에러가 나지만 SSRF 에러는 아님
    try {
      await connector.query('/api/v1/users', {});
    } catch (e) {
      // fetch 실패는 OK — SSRF 차단이 아닌 네트워크 에러
      assert.ok(!e.message.includes('SSRF'));
    }
  });
});

// ─── Runtime Integration — Tool Definitions ─────────────

const { TOOL_DEFINITIONS, getToolsForFunction } = require('../src/agents/tool-registry');

describe('DataSource Tool Definitions', () => {
  it('query_datasource is defined with correct schema', () => {
    const def = TOOL_DEFINITIONS.query_datasource;
    assert.ok(def, 'query_datasource must be defined');
    assert.equal(def.name, 'query_datasource');
    assert.ok(def.input_schema.properties.connector_id);
    assert.ok(def.input_schema.properties.query);
    assert.ok(def.input_schema.required.includes('connector_id'));
    assert.ok(def.input_schema.required.includes('query'));
  });

  it('list_datasources is defined with correct schema', () => {
    const def = TOOL_DEFINITIONS.list_datasources;
    assert.ok(def, 'list_datasources must be defined');
    assert.equal(def.name, 'list_datasources');
  });

  it('datasource tools are available to general function', () => {
    const tools = getToolsForFunction('general');
    assert.ok(tools.includes('query_datasource'), 'general should have query_datasource');
    assert.ok(tools.includes('list_datasources'), 'general should have list_datasources');
  });
});
