/**
 * user-data-manager.js — GDPR/개인정보 삭제 메커니즘.
 *
 * PV-1: 사용자 데이터 완전 삭제 (Right to Erasure).
 * 모든 관련 테이블에서 userId에 연결된 데이터를 트랜잭션으로 삭제.
 */
const { getAdapter } = require('../db');
const { createLogger } = require('./logger');

const log = createLogger('user-data-manager');

/**
 * 사용자의 모든 데이터를 삭제한다.
 *
 * @param {string} userId - 삭제 대상 사용자 ID
 * @returns {Promise<Object>} 테이블별 삭제 행 수 요약
 */
async function deleteUserData(userId) {
  if (!userId || typeof userId !== 'string') {
    throw new Error('deleteUserData: userId is required');
  }

  const adapter = getAdapter();
  const deletionOrder = [
    { table: 'episodic_memory', column: 'user_id' },
    { table: 'semantic_memory', column: 'user_id' },
    { table: 'memories', column: 'source_user' },
    { table: 'entities', column: 'source_user' },
    { table: 'entity_relationships', column: 'source_user' },
    { table: 'cost_log', column: 'user_id' },
    { table: 'sessions', column: 'user_id' },
    { table: 'canonical_users', column: 'id' },
    { table: 'user_platform_links', column: 'canonical_user_id' },
    { table: 'audit_log', column: 'user_id' },
  ];

  const summary = {};

  const performDeletion = async (db) => {
    for (const { table, column } of deletionOrder) {
      try {
        const result = await db.run(`DELETE FROM ${table} WHERE ${column} = ?`, [userId]);
        summary[table] = result.changes || 0;
      } catch (err) {
        // Table may not exist in all deployments — skip gracefully
        if (err.message && (err.message.includes('no such table') || err.message.includes('does not exist'))) {
          summary[table] = 0;
        } else {
          throw err;
        }
      }
    }
  };

  // Use transaction if available
  if (typeof adapter.transaction === 'function') {
    await adapter.transaction(async (tx) => {
      await performDeletion(tx);
    });
  } else {
    await performDeletion(adapter);
  }

  const totalDeleted = Object.values(summary).reduce((a, b) => a + b, 0);

  log.info('User data deleted', {
    userId,
    totalDeleted,
    summary,
  });

  return { userId, totalDeleted, summary };
}

module.exports = { deleteUserData };
