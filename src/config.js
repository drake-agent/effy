/**
 * config.js — Effy v3 YAML 기반 설정 로더.
 *
 * effy.config.yaml에서 전체 설정을 로드.
 * ${VAR_NAME} 형태의 환경변수 참조를 치환.
 * .env 파일도 지원 (환경변수 폴백).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const CONFIG_PATH = path.resolve(process.env.EFFY_CONFIG || process.env.Effy_CONFIG || './effy.config.yaml');

function resolveEnvVars(raw) {
  const unresolvedVars = new Set();
  const resolved = raw.replace(/\$\{(\w+)\}/g, (_, name) => {
    if (!(name in process.env)) {
      unresolvedVars.add(name);
    }
    return process.env[name] || '';
  });
  if (unresolvedVars.size > 0) {
    console.warn(`[config] Unresolved environment variables: ${Array.from(unresolvedVars).join(', ')}`);
  }
  return resolved;
}

/**
 * 재귀 딥 머지 — env override를 base config 위에 병합.
 * 배열은 override가 통째로 교체, 객체는 재귀 병합, 원시값은 override 우선.
 */
function deepMerge(base, override) {
  if (!override || typeof override !== 'object') return base;
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const ov = override[key];
    if (ov && typeof ov === 'object' && !Array.isArray(ov) && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], ov);
    } else {
      result[key] = ov;
    }
  }
  return result;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`[config] Config file not found: ${CONFIG_PATH}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const resolved = resolveEnvVars(raw);
  let cfg = yaml.parse(resolved);

  // BUG-1 fix: NODE_ENV 기반 환경별 오버라이드 병합
  const nodeEnv = process.env.NODE_ENV || 'development';
  const envConfigPath = path.resolve(path.dirname(CONFIG_PATH), 'config', `env.${nodeEnv}.yaml`);
  if (fs.existsSync(envConfigPath)) {
    const envRaw = fs.readFileSync(envConfigPath, 'utf-8');
    const envResolved = resolveEnvVars(envRaw);
    const envCfg = yaml.parse(envResolved);
    cfg = deepMerge(cfg, envCfg);
    console.log(`[config] Env override loaded: ${envConfigPath}`);
  }

  // 하위 호환 매핑 — 기존 모듈이 config.slack, config.db 참조
  cfg.slack = {
    botToken: cfg.channels?.slack?.botToken || '',
    appToken: cfg.channels?.slack?.appToken || '',
  };

  // DATABASE_URL 환경변수가 있으면 자동으로 Phase 2 (PostgreSQL)
  const hasPostgresUrl = !!(cfg.memory?.database?.postgresUrl || process.env.DATABASE_URL);
  // BUG-106 fix: Number()로 phase 강제 변환 — YAML 문자열 "2" vs 정수 2 불일치 방지
  cfg.db = {
    phase: hasPostgresUrl ? 2 : Number(cfg.memory?.database?.phase) || 1,
    sqlitePath: cfg.memory?.database?.sqlitePath || './data/effy.db',
    postgresUrl: cfg.memory?.database?.postgresUrl || process.env.DATABASE_URL || '',
    get isSQLite() { return this.phase === 1; },
  };

  cfg.concurrency = {
    global: cfg.gateway?.maxConcurrency?.global || 20,
    perUser: cfg.gateway?.maxConcurrency?.perUser || 2,
    perChannel: cfg.gateway?.maxConcurrency?.perChannel || 3,
  };

  cfg.session = {
    idleTimeoutMs: cfg.gateway?.idleTimeoutMs || 300000,
  };

  cfg.budgetProfiles = cfg.memory?.budget || {};

  // Redis config — supports both REDIS_URL and individual REDIS_HOST/PORT/PASSWORD vars
  // Only create redis config if any redis env vars are set
  const redisUrl = process.env.REDIS_URL;
  const redisHost = process.env.REDIS_HOST;
  const redisPort = process.env.REDIS_PORT;
  const redisPassword = process.env.REDIS_PASSWORD;

  if (redisUrl || redisHost || redisPort || redisPassword) {
    cfg.redis = cfg.redis || {};

    if (redisUrl) {
      // Parse REDIS_URL format: redis://:password@host:port/db
      cfg.redis.url = redisUrl;
    } else {
      // Use individual params
      cfg.redis.host = redisHost || cfg.redis?.host || 'localhost';
      cfg.redis.port = parseInt(redisPort || cfg.redis?.port || '6379', 10);
      if (redisPassword) {
        cfg.redis.password = redisPassword;
      }
    }

    // Set prefix if not already configured
    if (!cfg.redis.prefix) {
      cfg.redis.prefix = 'effy:';
    }

    console.log(`[config] Redis enabled: ${redisUrl ? 'REDIS_URL' : `${cfg.redis.host}:${cfg.redis.port}`}`);
  } else if (cfg.redis) {
    // Redis section exists in effy.config.yaml, resolve env vars
    cfg.redis.host = cfg.redis.host || 'localhost';
    cfg.redis.port = parseInt(cfg.redis.port || '6379', 10);
    cfg.redis.prefix = cfg.redis.prefix || 'effy:';
    console.log(`[config] Redis enabled: ${cfg.redis.host}:${cfg.redis.port}`);
  }

  return cfg;
}

const config = loadConfig();

function validate() {
  const errors = [];
  if (!config.anthropic?.apiKey) errors.push('ANTHROPIC_API_KEY');
  if (config.channels?.slack?.enabled) {
    if (!config.slack?.botToken) errors.push('SLACK_BOT_TOKEN');
    if (!config.slack?.appToken) errors.push('SLACK_APP_TOKEN');
  }

  const agentsDir = path.resolve(config.agents?.dir || './agents');
  if (!fs.existsSync(agentsDir)) errors.push(`agents dir: ${agentsDir}`);

  const agents = config.agents?.list || [];
  if (agents.length > 0 && !agents.some(a => a.default)) {
    errors.push('agents.list — default 에이전트 없음');
  }

  if (errors.length > 0) {
    console.error('[config] 필수 설정 누락:', errors.join(', '));
    process.exit(1);
  }

  console.log(`[config] Loaded: ${CONFIG_PATH}`);
  console.log(`[config] Agents: ${agents.map(a => a.id).join(', ')}`);
  console.log(`[config] Pools: ${Object.keys(config.memory?.pools || {}).join(', ')}`);
}

module.exports = { config, validate };
