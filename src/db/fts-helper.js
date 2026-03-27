/**
 * fts-helper.js — Cross-database Full-Text Search helper.
 *
 * Abstracts FTS5 (SQLite) vs tsvector (PostgreSQL) differences.
 * Modules that need full-text search should use this instead of
 * writing raw FTS5 or tsvector queries.
 *
 * Usage:
 *   const { ftsSearch } = require('../db/fts-helper');
 *   const results = await ftsSearch('episodic_memory', 'content', 'search terms', { limit: 20 });
 */
const { getAdapter, isInitialized } = require('./adapter');

/**
 * Perform full-text search across SQLite FTS5 or PostgreSQL tsvector.
 *
 * @param {string} table - Base table name (e.g. 'episodic_memory', 'semantic_memory', 'memories')
 * @param {string} column - Column to search (e.g. 'content')
 * @param {string} query - Search query text
 * @param {Object} [opts={}]
 * @param {number} [opts.limit=50] - Max results
 * @param {number} [opts.offset=0] - Skip N results
 * @param {string} [opts.where] - Additional WHERE clause (e.g. "archived = 0")
 * @param {Array}  [opts.whereParams] - Params for the additional WHERE clause
 * @param {string} [opts.select] - Columns to select (default: '*')
 * @param {string} [opts.orderBy] - Custom ORDER BY (default: rank/relevance)
 * @returns {Promise<Array>} - Matching rows with optional rank column
 */
async function ftsSearch(table, column, query, opts = {}) {
  if (!isInitialized()) throw new Error('DB not initialized');
  const adapter = getAdapter();

  const limit = Math.min(opts.limit || 50, 200);
  const offset = opts.offset || 0;
  const select = opts.select || '*';

  if (adapter.type === 'sqlite') {
    return _sqliteFts(adapter, table, column, query, { ...opts, limit, offset, select });
  } else {
    return _postgresFts(adapter, table, column, query, { ...opts, limit, offset, select });
  }
}

/**
 * SQLite FTS5 search.
 * Uses the corresponding _fts virtual table and JOIN pattern.
 */
async function _sqliteFts(adapter, table, column, query, opts) {
  // Map table → FTS virtual table name
  const ftsTableMap = {
    episodic_memory: 'episodic_fts',
    semantic_memory: 'semantic_fts',
    memories: 'memories_fts',
  };

  const ftsTable = ftsTableMap[table];
  if (!ftsTable) {
    throw new Error(`No FTS table mapping for: ${table}. Add it to fts-helper.js`);
  }

  // Sanitize query for FTS5: escape double quotes, remove special chars
  const safeQuery = query
    .replace(/"/g, '""')
    .replace(/[{}[\]()^~*?\\]/g, ' ')
    .trim();

  if (!safeQuery) return [];

  let sql;
  const params = [];

  // For episodic_fts (only content column indexed)
  if (ftsTable === 'episodic_fts') {
    const where = opts.where ? `AND ${opts.where}` : '';
    sql = `
      SELECT ${opts.select === '*' ? 't.*' : opts.select}, rank
      FROM ${ftsTable} fts
      JOIN ${table} t ON t.id = fts.rowid
      WHERE ${ftsTable} MATCH ?
      ${where}
      ORDER BY ${opts.orderBy || 'rank'}
      LIMIT ? OFFSET ?
    `;
    params.push(safeQuery, ...(opts.whereParams || []), opts.limit, opts.offset);
  }
  // For semantic_fts (content, source_type, channel_id, tags)
  else if (ftsTable === 'semantic_fts') {
    const where = opts.where ? `AND ${opts.where}` : '';
    sql = `
      SELECT ${opts.select === '*' ? 't.*' : opts.select}, rank
      FROM ${ftsTable} fts
      JOIN ${table} t ON t.id = fts.rowid
      WHERE ${ftsTable} MATCH ?
      ${where}
      ORDER BY ${opts.orderBy || 'rank'}
      LIMIT ? OFFSET ?
    `;
    params.push(safeQuery, ...(opts.whereParams || []), opts.limit, opts.offset);
  }
  // For memories_fts (content, type)
  else if (ftsTable === 'memories_fts') {
    const where = opts.where ? `AND ${opts.where}` : '';
    sql = `
      SELECT ${opts.select === '*' ? 't.*' : opts.select}, rank
      FROM ${ftsTable} fts
      JOIN ${table} t ON t.id = fts.rowid
      WHERE ${ftsTable} MATCH ?
      ${where}
      ORDER BY ${opts.orderBy || 'rank'}
      LIMIT ? OFFSET ?
    `;
    params.push(safeQuery, ...(opts.whereParams || []), opts.limit, opts.offset);
  }

  return adapter.all(sql, params);
}

/**
 * PostgreSQL tsvector search.
 * Uses the generated _tsv column with GIN index.
 */
async function _postgresFts(adapter, table, column, query, opts) {
  const safeTable = table.replace(/[^a-zA-Z0-9_]/g, '');
  const safeColumn = column.replace(/[^a-zA-Z0-9_]/g, '');

  // Use the generated tsvector column (e.g. content_tsv)
  const tsvColumn = `${safeColumn}_tsv`;
  const where = opts.where ? `AND ${opts.where}` : '';
  const whereParams = opts.whereParams || [];

  // PostgreSQL uses $N placeholders — build them dynamically
  const baseIdx = 1;
  const sql = `
    SELECT ${opts.select === '*' ? `${safeTable}.*` : opts.select},
           ts_rank(${tsvColumn}, plainto_tsquery('english', $${baseIdx})) AS rank
    FROM ${safeTable}
    WHERE ${tsvColumn} @@ plainto_tsquery('english', $${baseIdx})
    ${where.replace(/\?/g, () => `$${baseIdx + 1 + whereParams.indexOf('?')}`)}
    ORDER BY ${opts.orderBy || 'rank DESC'}
    LIMIT $${baseIdx + whereParams.length + 1}
    OFFSET $${baseIdx + whereParams.length + 2}
  `;

  // Rebuild params for $N placeholders
  const params = [query, ...whereParams, opts.limit, opts.offset];

  return adapter.all(sql, params);
}

/**
 * Check if a table has FTS capabilities.
 * @param {string} table
 * @returns {boolean}
 */
function hasFts(table) {
  return ['episodic_memory', 'semantic_memory', 'memories'].includes(table);
}

module.exports = { ftsSearch, hasFts };
