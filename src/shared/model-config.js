const { config } = require('../config');

const DEFAULT_TIER_MODELS = Object.freeze({
  tier1: Object.freeze({
    id: 'claude-haiku-4-5-20251001',
    alias: 'haiku',
    maxTokens: 8192,
  }),
  tier2: Object.freeze({
    id: 'claude-sonnet-4-20250514',
    alias: 'sonnet',
    maxTokens: 16384,
  }),
  tier3: Object.freeze({
    id: 'claude-opus-4-20250514',
    alias: 'opus',
    maxTokens: 16384,
  }),
  tier4: Object.freeze({
    id: 'claude-opus-4-20250514',
    alias: 'opus-thinking',
    maxTokens: 32000,
    extendedThinking: Object.freeze({
      enabled: true,
      budgetTokens: 10000,
    }),
  }),
});

function cloneValue(value) {
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    return JSON.parse(JSON.stringify(value));
  }
  return value;
}

function mergeTierDef(...defs) {
  return defs.reduce((merged, def) => {
    if (!def || typeof def !== 'object') return merged;

    for (const [key, value] of Object.entries(def)) {
      if (value === undefined) continue;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        merged[key] = { ...(merged[key] || {}), ...cloneValue(value) };
      } else {
        merged[key] = cloneValue(value);
      }
    }
    return merged;
  }, {});
}

function getAnthropicConfig(anthropicCfg = config.anthropic || {}) {
  return anthropicCfg || {};
}

function getTierDefinitions(anthropicCfg = config.anthropic || {}) {
  const resolved = getAnthropicConfig(anthropicCfg);
  const configured = resolved.models || {};

  return {
    tier1: mergeTierDef(DEFAULT_TIER_MODELS.tier1, resolved.defaultModel ? { id: resolved.defaultModel } : null, configured.tier1),
    tier2: mergeTierDef(DEFAULT_TIER_MODELS.tier2, resolved.advancedModel ? { id: resolved.advancedModel } : null, configured.tier2),
    tier3: mergeTierDef(DEFAULT_TIER_MODELS.tier3, configured.tier3),
    tier4: mergeTierDef(DEFAULT_TIER_MODELS.tier4, configured.tier4),
  };
}

function getTierDefinition(tier, anthropicCfg = config.anthropic || {}) {
  const defs = getTierDefinitions(anthropicCfg);
  return defs[tier] || defs.tier1;
}

function getTierModel(tier, anthropicCfg = config.anthropic || {}) {
  return getTierDefinition(tier, anthropicCfg).id;
}

function getDefaultModel(anthropicCfg = config.anthropic || {}) {
  return getTierModel('tier1', anthropicCfg);
}

function getAdvancedModel(anthropicCfg = config.anthropic || {}) {
  return getTierModel('tier2', anthropicCfg);
}

module.exports = {
  DEFAULT_TIER_MODELS,
  getTierDefinitions,
  getTierDefinition,
  getTierModel,
  getDefaultModel,
  getAdvancedModel,
};
