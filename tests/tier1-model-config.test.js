const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const configModule = require('../src/config');

const originalAnthropic = JSON.parse(JSON.stringify(configModule.config.anthropic || {}));
const originalCost = JSON.parse(JSON.stringify(configModule.config.cost || {}));

function restoreConfig() {
  configModule.config.anthropic = JSON.parse(JSON.stringify(originalAnthropic));
  configModule.config.cost = JSON.parse(JSON.stringify(originalCost));
}

afterEach(restoreConfig);

describe('Model config helpers', () => {
  it('should merge legacy defaults with tier configuration in one place', () => {
    configModule.config.anthropic = {
      maxTokens: 4096,
      defaultModel: 'custom-haiku',
      advancedModel: 'custom-sonnet',
      models: {
        tier3: { id: 'custom-opus', maxTokens: 20000 },
        tier4: { id: 'custom-thinking', extendedThinking: { enabled: true, budgetTokens: 12000 } },
      },
    };

    const { getTierDefinitions, getDefaultModel, getAdvancedModel, getTierModel } = require('../src/shared/model-config');
    const defs = getTierDefinitions();

    assert.equal(getDefaultModel(), 'custom-haiku');
    assert.equal(getAdvancedModel(), 'custom-sonnet');
    assert.equal(getTierModel('tier3'), 'custom-opus');
    assert.equal(defs.tier1.alias, 'haiku');
    assert.equal(defs.tier4.extendedThinking.budgetTokens, 12000);
  });
});

describe('BudgetGate model downgrade', () => {
  it('should downgrade to the configured tier1 model instead of a hardcoded ID', () => {
    configModule.config.anthropic = {
      models: {
        tier1: { id: 'claude-haiku-custom-review' },
      },
    };
    configModule.config.cost = {
      monthlyBudgetUsd: 10,
      alertThreshold: 0.8,
      perUserMonthlyBudgetUsd: 5,
      perChannelDailyBudgetUsd: 10,
    };

    const { BudgetGate } = require('../src/core/budget-gate');
    const gate = new BudgetGate();
    gate._getGlobalMonthlyTotal = () => 12;

    const result = gate.check('U1', null, 0, null);
    assert.equal(result.downgradeModel, 'claude-haiku-custom-review');
  });
});
