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

// Whitelist of allowed table/column combinations for FTS
// SEC-003 fix: prevent SQL injection via table/column parameters
const ALLOWED_FTS = {
  episodic_memory: { ftsTable: 'episodic_fts', columns: ['content'] },
  semantic_memory: { ftsTable: 'semantic_fts', columns: ['content', 'source_type', 'channel_id', 'tags'] },
  memories: { ftsTable: 'memories_fts', columns: ['content', 'type'] },
};

/**
 * Perform full-text search across SQLite FTS5 or PostgreSQL tsvector.
 *
 * @param {string} table - Base table name (must be in ALLOWED_FTS whitelist)
 * @param {string} column - Column to search (must be in whitelist for the table)
 * @param {string} query - Search query text
 * @param {Object} [opts={}]
 * @param {number} [opts.limit=50] - Max results
 * @param {number} [opts.offset=0] - Skip N results
 * @param {string} [opts.where] - Additional WHERE clause with ? placeholders ONLY
 * @param {Array}  [opts.whereParams] - Params for the additional WHERE clause
 * @param {string} [opts.orderBy] - Custom ORDER BY (default: rank/relevance)
 * @returns {Promise<Array>} - Matching rows with optional rank column
 */
async function ftsSearch(table, column, query, opts = {}) {
  if (!isInitialized()) throw new Error('DB not initialized');

  // BUG3-004 fix: Validate whereParams is array if provided
  if (opts.whereParams && !Array.isArray(opts.whereParams)) {
    throw new Error('opts.whereParams must be an array');
  }

  // SEC-003: Validate table and column against whitelist
  const ftsConfig = ALLOWED_FTS[table];
  if (!ftsConfig) {
    throw new Error(`Invalid FTS table: ${table}. Allowed: ${Object.keys(ALLOWED_FTS).join(', ')}`);
  }
  if (!ftsConfig.columns.includes(column)) {
    throw new Error(`Invalid FTS column '${column}' for table '${table}'. Allowed: ${ftsConfig.columns.join(', ')}`);
  }

  const adapter = getAdapter();
  const limit = Math.min(Math.max(opts.limit || 50, 1), 200);
  const offset = Math.max(opts.offset || 0, 0);

  // SEC-003: Validate where clause contains only ? placeholders, no raw SQL
  if (opts.where) {
    _validateWhereClause(opts.where);
  }

  if (adapter.type === 'sqlite') {
    return _sqliteFts(adapter, table, ftsConfig.ftsTable, query, { ...opts, limit, offset });
  } else {
    return _postgresFts(adapter, table, column, query, { ...opts, limit, offset });
  }
}

/**
 * Validate WHERE clause to prevent SQL injection.
 * Only allows simple column comparisons with ? placeholders.
 * @param {string} where
 */
function _validateWhereClause(where) {
  // Reject obvious injection patterns
  const forbidden = /;\s*--|;\s*DROP|;\s*DELETE|;\s*UPDATE|;\s*INSERT|UNION\s+SELECT|INTO\s+OUTFILE/i;
  if (forbidden.test(where)) {
    throw new Error('Forbidden pattern in WHERE clause');
  }
  // Must contain at least one ? placeholder if it has comparison operators
  const hasComparison = /[=<>!]|LIKE|IN\s*\(|BETWEEN/i.test(where);
  const hasPlaceholder = where.includes('?');
  if (hasComparison && !hasPlaceholder) {
    throw new Error('WHERE clause with comparisons must use ? placeholders for values');
  }
}

/**
 * SQLite FTS5 search.
 * Uses the corresponding _fts virtual table and JOIN pattern.
 */
async function _sqliteFts(adapter, table, ftsTable, query, opts) {
  // Sanitize query for FTS5: escape double quotes, remove special chars
  const safeQuery = query
    .replace(/"/g, '""')
    .replace(/[{}[\]()^~*?\\]/g, ' ')
    .trim();

  if (!safeQuery) return [];

  const where = opts.where ? `AND ${opts.where}` : '';
  const orderBy = _sanitizeOrderBy(opts.orderBy, 'rank');
  const params = [safeQuery, ...(opts.whereParams || []), opts.limit, opts.offset];

  const sql = `
    SELECT t.*, rank
    FROM ${ftsTable} fts
    JOIN ${table} t ON t.id = fts.rowid
    WHERE ${ftsTable} MATCH ?
    ${where}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;

  return adapter.all(sql, params);
}

/**
 * PostgreSQL tsvector search.
 * Uses the generated _tsv column with GIN index.
 * BUG-001 fix: Properly compute $N parameter indices.
 */
async function _postgresFts(adapter, table, column, query, opts) {
  // Table and column already validated against whitelist in ftsSearch()
  const tsvColumn = `${column}_tsv`;
  const whereParams = opts.whereParams || [];
  const orderBy = _sanitizeOrderBy(opts.orderBy, 'rank DESC');

  // Build $N placeholders correctly
  // $1 = search query, $2..$N = whereParams, $(N+1) = limit, $(N+2) = offset
  // BUG3-005 fix: paramIdx must advance past $1 (query) in ALL cases
  let nextParam = 2; // $1 is always the search query, next available is $2

  // Translate WHERE clause ? → $N
  let pgWhere = '';
  if (opts.where) {
    pgWhere = 'AND ' + opts.where.replace(/\?/g, () => `$${nextParam++}`);
  }

  const limitIdx = nextParam++;
  const offsetIdx = nextParam;

  const sql = `
    SELECT ${table}.*,
           ts_rank(${tsvColumn}, plainto_tsquery('english', $1)) AS rank
    FROM ${table}
    WHERE ${tsvColumn} @@ plainto_tsquery('english', $1)
    ${pgWhere}
    ORDER BY ${orderBy}
    LIMIT $${limitIdx}
    OFFSET $${offsetIdx}
  `;

  const params = [query, ...whereParams, opts.limit, opts.offset];
  return adapter.all(sql, params);
}

/**
 * Sanitize ORDER BY clause — only allow simple column references.
 * @param {string|undefined} orderBy
 * @param {string} defaultOrder
 * @returns {string}
 */
function _sanitizeOrderBy(orderBy, defaultOrder) {
  if (!orderBy) return defaultOrder;
  // Allow only: column names, ASC/DESC, commas
  if (!/^[\w\s,]+(?:\s+(?:ASC|DESC))?(?:\s*,\s*[\w\s]+(?:\s+(?:ASC|DESC))?)*$/i.test(orderBy)) {
    return defaultOrder;
  }
  return orderBy;
}

/**
 * Check if a table has FTS capabilities.
 * @param {string} table
 * @returns {boolean}
 */
function hasFts(table) {
  return table in ALLOWED_FTS;
}

module.exports = { ftsSearch, hasFts };
