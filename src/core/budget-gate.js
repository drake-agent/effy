/**
 * budget-gate.js — Cost Gate.
 *
 * 유저/채널/전체 예산 체크 → 모델 다운그레이드 또는 예산 조정.
 * memory/manager.js cost 테이블에서 실시간 조회.
 */
const { config } = require('../config');
const { cost } = require('../memory/manager');
const { getDb } = require('../db');

class BudgetGate {
  constructor() {
    const costCfg = config.cost || {};
    this.monthlyBudgetUsd = costCfg.monthlyBudgetUsd || 200;
    this.alertThreshold = costCfg.alertThreshold || 0.8;
    this.perUserMonthlyBudgetUsd = costCfg.perUserMonthlyBudgetUsd || 5;
    this.perChannelDailyBudgetUsd = costCfg.perChannelDailyBudgetUsd || 10;

    this._haikuModel = 'claude-haiku-4-5-20251001';
    this._alertSent = false;
    this._monthKey = '';
  }

  /**
   * 예산 체크.
   * @param {string} userId
   * @param {string} channelId
   * @param {number} _estimatedTokens
   * @param {string} _model
   * @returns {{ allowed: boolean, downgradeModel: string|null, adjustBudget?: string, reason: string }}
   */
  check(userId, channelId, _estimatedTokens, _model) {
    // 월 변경 시 알림 리셋
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (this._monthKey !== currentMonth) {
      this._monthKey = currentMonth;
      this._alertSent = false;
    }

    // 1. 전체 월 예산
    const globalTotal = this._getGlobalMonthlyTotal();
    const globalRatio = globalTotal / this.monthlyBudgetUsd;

    if (globalRatio >= 1.0) {
      return {
        allowed: true,
        downgradeModel: this._haikuModel,
        reason: `Global monthly budget exceeded ($${globalTotal.toFixed(2)}/$${this.monthlyBudgetUsd}). Forced Haiku.`,
      };
    }

    if (globalRatio >= this.alertThreshold && !this._alertSent) {
      this._alertSent = true;
      console.warn(`[budget-gate] WARNING: Global budget at ${(globalRatio * 100).toFixed(0)}% ($${globalTotal.toFixed(2)}/$${this.monthlyBudgetUsd})`);
    }

    // 2. 유저 월 예산
    const userTotal = cost.getMonthlyTotal(userId);
    if (userTotal >= this.perUserMonthlyBudgetUsd) {
      return {
        allowed: true,
        downgradeModel: this._haikuModel,
        reason: `User monthly budget exceeded ($${userTotal.toFixed(2)}/$${this.perUserMonthlyBudgetUsd}). Forced Haiku.`,
      };
    }

    // 3. 채널 일 예산
    if (channelId) {
      const channelDaily = this._getChannelDailyTotal(channelId);
      if (channelDaily >= this.perChannelDailyBudgetUsd) {
        return {
          allowed: true,
          downgradeModel: null,
          adjustBudget: 'STANDARD',
          reason: `Channel daily budget exceeded ($${channelDaily.toFixed(2)}/$${this.perChannelDailyBudgetUsd}). Budget capped at STANDARD.`,
        };
      }
    }

    return { allowed: true, downgradeModel: null, reason: 'within budget' };
  }

  async _getGlobalMonthlyTotal() {
    try {
      const db = getDb();
      const row = await db.prepare(`
        SELECT SUM(cost_usd) as total FROM cost_log
        WHERE created_at >= datetime('now', 'start of month')
      `).get();
      return row?.total || 0;
    } catch { return 0; }
  }

  async _getChannelDailyTotal(channelId) {
    try {
      const db = getDb();
      const row = await db.prepare(`
        SELECT SUM(cost_usd) as total FROM cost_log
        WHERE session_id LIKE ? AND created_at >= datetime('now', 'start of day')
      `).get(`%:${channelId}:%`);
      return row?.total || 0;
    } catch { return 0; }
  }
}

module.exports = { BudgetGate };
