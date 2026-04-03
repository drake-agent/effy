/**
 * migrations/runner.js — PostgreSQL migration runner for Effy v4.0.
 *
 * Scans src/db/migrations/ for files matching NNN_*.js pattern,
 * tracks applied migrations in a _migrations table, and runs
 * unapplied migrations in order inside transactions.
 *
 * Usage:
 *   const { migrate, rollback, status } = require('./migrations/runner');
 *   await migrate();              // apply all pending
 *   await rollback(1);            // roll back last 1 migration
 *   const list = await status();  // list all with applied/pending
 */
const path = require('path');
const fs = require('fs');
const { createLogger } = require('../../shared/logger');

const log = createLogger('db:migrations');

const MIGRATIONS_DIR = __dirname;
const MIGRATION_FILE_PATTERN = /^(\d{3})_.+\.js$/;

/**
 * Ensure the _migrations tracking table exists.
 * @param {import('pg').Pool} pool
 */
async function ensureMigrationsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

/**
 * Discover migration files on disk, sorted by numeric prefix.
 * @returns {Array<{name: string, filePath: string, seq: number}>}
 */
function discoverMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => MIGRATION_FILE_PATTERN.test(f))
    .sort();

  return files.map(f => {
    const match = f.match(MIGRATION_FILE_PATTERN);
    return {
      name: match[1] + '_' + f.slice(match[1].length + 1).replace(/\.js$/, ''),
      filePath: path.join(MIGRATIONS_DIR, f),
      seq: parseInt(match[1], 10),
    };
  });
}

/**
 * Get the set of already-applied migration names.
 * @param {import('pg').Pool} pool
 * @returns {Promise<Set<string>>}
 */
async function getApplied(pool) {
  const { rows } = await pool.query('SELECT name FROM _migrations ORDER BY id');
  return new Set(rows.map(r => r.name));
}

/**
 * Run all pending migrations in order.
 * Each migration runs inside its own transaction.
 * @param {import('pg').Pool} [pool] - Optional pool override; defaults to adapter pool.
 * @returns {Promise<string[]>} Names of applied migrations.
 */
async function migrate(pool) {
  pool = pool || _getPool();
  await ensureMigrationsTable(pool);

  const allMigrations = discoverMigrations();
  const applied = await getApplied(pool);
  const pending = allMigrations.filter(m => !applied.has(m.name));

  if (pending.length === 0) {
    log.info('No pending migrations');
    return [];
  }

  const results = [];
  for (const migration of pending) {
    const mod = require(migration.filePath);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      log.info(`Applying migration: ${migration.name}`);
      await mod.up(client);
      await client.query(
        'INSERT INTO _migrations (name) VALUES ($1)',
        [migration.name]
      );
      await client.query('COMMIT');
      results.push(migration.name);
      log.info(`Migration applied: ${migration.name}`);
    } catch (err) {
      await client.query('ROLLBACK');
      log.error(`Migration failed: ${migration.name}`, { error: err.message });
      throw err;
    } finally {
      client.release();
    }
  }

  return results;
}

/**
 * Roll back the last N applied migrations in reverse order.
 * @param {number} [steps=1]
 * @param {import('pg').Pool} [pool]
 * @returns {Promise<string[]>} Names of rolled-back migrations.
 */
async function rollback(steps = 1, pool) {
  pool = pool || _getPool();
  await ensureMigrationsTable(pool);

  const { rows } = await pool.query(
    'SELECT name FROM _migrations ORDER BY id DESC LIMIT $1',
    [steps]
  );

  if (rows.length === 0) {
    log.info('No migrations to roll back');
    return [];
  }

  const allMigrations = discoverMigrations();
  const migrationMap = new Map(allMigrations.map(m => [m.name, m]));
  const results = [];

  for (const row of rows) {
    const migration = migrationMap.get(row.name);
    if (!migration) {
      log.warn(`Migration file not found for: ${row.name}, skipping rollback`);
      continue;
    }

    const mod = require(migration.filePath);
    if (typeof mod.down !== 'function') {
      log.warn(`No down() function in migration: ${row.name}, skipping`);
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      log.info(`Rolling back migration: ${row.name}`);
      await mod.down(client);
      await client.query('DELETE FROM _migrations WHERE name = $1', [row.name]);
      await client.query('COMMIT');
      results.push(row.name);
      log.info(`Migration rolled back: ${row.name}`);
    } catch (err) {
      await client.query('ROLLBACK');
      log.error(`Rollback failed: ${row.name}`, { error: err.message });
      throw err;
    } finally {
      client.release();
    }
  }

  return results;
}

/**
 * Get status of all migrations (applied vs pending).
 * @param {import('pg').Pool} [pool]
 * @returns {Promise<Array<{name: string, status: 'applied'|'pending', applied_at: string|null}>>}
 */
async function status(pool) {
  pool = pool || _getPool();
  await ensureMigrationsTable(pool);

  const allMigrations = discoverMigrations();
  const { rows } = await pool.query('SELECT name, applied_at FROM _migrations ORDER BY id');
  const appliedMap = new Map(rows.map(r => [r.name, r.applied_at]));

  return allMigrations.map(m => ({
    name: m.name,
    status: appliedMap.has(m.name) ? 'applied' : 'pending',
    applied_at: appliedMap.get(m.name) || null,
  }));
}

/**
 * Get the pg pool from the adapter.
 * @returns {import('pg').Pool}
 */
function _getPool() {
  const { getAdapter } = require('../adapter');
  const adapter = getAdapter();
  if (!adapter.pool) {
    throw new Error('[migrations] Adapter has no pool. Is PostgreSQL initialized?');
  }
  return adapter.pool;
}

module.exports = { migrate, rollback, status };
