// Vendor: Context Hub (@aisuite/chub) — ESM→CJS conversion for Effy v3.6.1

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { parse: parseYaml } = require('yaml');

const DEFAULT_CDN_URL = 'https://cdn.aichub.org/v1';

const DEFAULTS = {
  output_dir: '.context',
  refresh_interval: 21600,
  source: 'official,maintainer,community',
};

let _config = null;

function getChubDir() {
  return process.env.CHUB_DIR || join(homedir(), '.chub');
}

function loadConfig() {
  if (_config) return _config;

  let fileConfig = {};
  const configPath = join(getChubDir(), 'config.yaml');
  try {
    const raw = readFileSync(configPath, 'utf8');
    fileConfig = parseYaml(raw) || {};
  } catch {
    // No config file, use defaults
  }

  // Build sources list
  let sources;
  if (fileConfig.sources && Array.isArray(fileConfig.sources)) {
    sources = fileConfig.sources;
  } else {
    // Backward compat: single cdn_url becomes a single source
    const url = process.env.CHUB_BUNDLE_URL || fileConfig.cdn_url || DEFAULT_CDN_URL;
    sources = [{ name: 'default', url }];
  }

  _config = {
    sources,
    refresh_interval: fileConfig.refresh_interval ?? DEFAULTS.refresh_interval,
  };

  return _config;
}

/** 캐시 리셋 — 커스텀 소스 추가/삭제 시 호출 */
function _resetConfig() {
  _config = null;
}

module.exports = { getChubDir, loadConfig, _resetConfig };
