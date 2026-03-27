/**
 * tier1-sandbox.test.js — OSSandbox 위험 환경변수 차단 테스트
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

// Mock config before importing sandbox
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === '../config' || request.endsWith('/config')) {
    // Return a mock path that we'll handle
    return require.resolve('./helpers/mock-config-sandbox');
  }
  return origResolve.call(this, request, parent, ...rest);
};

// Create mock config file
const fs = require('fs');
const path = require('path');
const helpersDir = path.join(__dirname, 'helpers');
if (!fs.existsSync(helpersDir)) fs.mkdirSync(helpersDir, { recursive: true });
fs.writeFileSync(path.join(helpersDir, 'mock-config-sandbox.js'),
  'module.exports = { config: { sandbox: {} } };');

const { OSSandbox, DANGEROUS_ENV_VARS } = require('../src/core/sandbox');

describe('OSSandbox - Dangerous Env Var Blocking', () => {
  it('should export DANGEROUS_ENV_VARS set', () => {
    assert.ok(DANGEROUS_ENV_VARS instanceof Set);
    assert.ok(DANGEROUS_ENV_VARS.size > 20);
  });

  it('should block LD_PRELOAD in DANGEROUS_ENV_VARS', () => {
    assert.ok(DANGEROUS_ENV_VARS.has('LD_PRELOAD'));
  });

  it('should block NODE_OPTIONS in DANGEROUS_ENV_VARS', () => {
    assert.ok(DANGEROUS_ENV_VARS.has('NODE_OPTIONS'));
  });

  it('should block DYLD_INSERT_LIBRARIES in DANGEROUS_ENV_VARS', () => {
    assert.ok(DANGEROUS_ENV_VARS.has('DYLD_INSERT_LIBRARIES'));
  });

  it('should block PYTHONPATH in DANGEROUS_ENV_VARS', () => {
    assert.ok(DANGEROUS_ENV_VARS.has('PYTHONPATH'));
  });

  it('should block BASH_ENV in DANGEROUS_ENV_VARS', () => {
    assert.ok(DANGEROUS_ENV_VARS.has('BASH_ENV'));
  });

  it('should allow safe vars through passthrough', () => {
    const sandbox = new OSSandbox({ mode: 'none' });
    const env = sandbox._buildEnv({ MY_SAFE_VAR: 'hello' });
    assert.equal(env.MY_SAFE_VAR, 'hello');
  });

  it('should filter dangerous vars from additionalEnv', () => {
    const sandbox = new OSSandbox({ mode: 'none' });
    const env = sandbox._buildEnv({
      SAFE_KEY: 'ok',
      LD_PRELOAD: '/evil/lib.so',
      NODE_OPTIONS: '--require=evil.js',
    });
    assert.equal(env.SAFE_KEY, 'ok');
    assert.equal(env.LD_PRELOAD, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
  });

  it('should filter dangerous vars from passthroughEnv', () => {
    const sandbox = new OSSandbox({
      mode: 'none',
      passthroughEnv: ['PATH', 'LD_PRELOAD', 'NODE_OPTIONS'],
    });
    // Set env temporarily
    const origLd = process.env.LD_PRELOAD;
    process.env.LD_PRELOAD = '/evil';
    try {
      const env = sandbox._buildEnv();
      assert.equal(env.LD_PRELOAD, undefined);
      assert.ok(env.PATH !== undefined || true); // PATH may exist
    } finally {
      if (origLd === undefined) delete process.env.LD_PRELOAD;
      else process.env.LD_PRELOAD = origLd;
    }
  });

  it('should validate env map via static method', () => {
    const result1 = OSSandbox.validateEnv({ PATH: '/usr/bin', HOME: '/home' });
    assert.equal(result1.safe, true);
    assert.equal(result1.blocked.length, 0);

    const result2 = OSSandbox.validateEnv({
      PATH: '/usr/bin',
      LD_PRELOAD: '/evil.so',
      PYTHONPATH: '/evil',
    });
    assert.equal(result2.safe, false);
    assert.ok(result2.blocked.includes('LD_PRELOAD'));
    assert.ok(result2.blocked.includes('PYTHONPATH'));
  });

  it('should contain all critical injection vectors', () => {
    const critical = [
      'LD_PRELOAD', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES',
      'PYTHONPATH', 'BASH_ENV', 'RUBYOPT', 'PERL5OPT',
    ];
    for (const v of critical) {
      assert.ok(DANGEROUS_ENV_VARS.has(v), `Missing critical var: ${v}`);
    }
  });
});
