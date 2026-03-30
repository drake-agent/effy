#!/usr/bin/env node
/**
 * migrate-sqlite-to-pg.js — SQLite → PostgreSQL data migration script.
 *
 * Migrates all data from a SQLite database to PostgreSQL.
 * The PostgreSQL schema must already be created (pg-adapter.createSchema()).
 *
 * Usage:
 *   node scripts/migrate-sqlite-to-pg.js [options]
 *
 * Options:
 *   --sqlite-path <path>     SQLite database file (default: ./data/effy.db)
 *   --pg-url <url>           PostgreSQL connection URL (or set DATABASE_URL env)
 *   --batch-size <n>         Rows per batch insert (default: 500)
 *   --tables <list>          Comma-separated table list (default: all)
 *   --dry-run                Show counts without migrating
 *   --force                  Skip confirmation prompt
 *
 * Example:
 *   DATABASE_URL=postgres://effy:pass@localhost:5432/effy \
 *     node scripts/migrate-sqlite-to-pg.js --sqlite-path ./data/effy.db
 */

const fs = require('fs');
const path = require('path');

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return defaultVal;
  return args[idx + 1] || defaultVal;
}
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const batchSize = parseInt(getArg('batch-size', '500'), 10);
const sqlitePath = getArg('sqlite-path', './data/effy.db');
const pgUrl = getArg('pg-url', process.env.DATABASE_URL || '');

// Tables to migrate (order matters for FK constraints)
const ALL_TABLES = [
  'sessions',
  'episodic_memory',
  'semantic_memory',
  'entities',
  'entity_relationships',
  'cost_log',
  'github_events',
  'user_mappings',
  'memory_promotions',
  'memories',
  'memory_edges',
  'tasks',
  'incidents',
  'cron_jobs',
  // v3.9
  'circuit_breaker_log',
  'agent_messages',
  'bulletins',
  'compaction_jobs',
  // v4.0
  'session_snapshots',
  'distributed_locks',
  'event_outbox',
];

const tableFilter = getArg('tables', '');
const tables = tableFilter ? tableFilter.split(',').map(t => t.trim()) : ALL_TABLES;

async function main() {
  // Validate inputs
  if (!pgUrl) {
    console.error('ERROR: PostgreSQL URL required. Set DATABASE_URL or use --pg-url');
    process.exit(1);
  }
  if (!fs.existsSync(sqlitePath)) {
    console.error(`ERROR: SQLite file not found: ${sqlitePath}`);
    process.exit(1);
  }

  console.log('=== Effy SQLite → PostgreSQL Migration ===');
  console.log(`  SQLite:     ${sqlitePath}`);
  console.log(`  PostgreSQL: ${pgUrl.replace(/:[^:@]+@/, ':****@')}`);
  console.log(`  Batch size: ${batchSize}`);
  console.log(`  Tables:     ${tables.length}`);
  console.log(`  Dry run:    ${dryRun}`);
  console.log('');

  // Open SQLite
  const Database = require('better-sqlite3');
  const sqliteDb = new Database(sqlitePath, { readonly: true });
  sqliteDb.pragma('journal_mode = WAL');

  // Open PostgreSQL
  const { Pool } = require('pg');
  const pgPool = new Pool({ connectionString: pgUrl });

  try {
    // Test PG connection
    await pgPool.query('SELECT 1');
    console.log('  PostgreSQL connection: OK');
    console.log('');

    // Count rows in each table
    const counts = {};
    for (const table of tables) {
      try {
        const row = sqliteDb.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get();
        counts[table] = row.cnt;
      } catch {
        counts[table] = -1; // Table doesn't exist in SQLite
      }
    }

    // Show summary
    console.log('Table Row Counts:');
    let totalRows = 0;
    for (const [table, count] of Object.entries(counts)) {
      if (count === -1) {
        console.log(`  ${table.padEnd(25)} SKIP (not in SQLite)`);
      } else if (count === 0) {
        console.log(`  ${table.padEnd(25)} 0 rows (empty)`);
      } else {
        console.log(`  ${table.padEnd(25)} ${count.toLocaleString()} rows`);
        totalRows += count;
      }
    }
    console.log(`  ${'TOTAL'.padEnd(25)} ${totalRows.toLocaleString()} rows`);
    console.log('');

    if (dryRun) {
      console.log('DRY RUN — no data migrated.');
      process.exit(0);
    }

    if (!force) {
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise(resolve => {
        rl.question('Proceed with migration? (yes/no): ', resolve);
      });
      rl.close();
      if (answer.toLowerCase() !== 'yes') {
        console.log('Aborted.');
        process.exit(0);
      }
    }

    // Migrate each table
    let migratedTotal = 0;
    const startTime = Date.now();

    for (const table of tables) {
      if (counts[table] <= 0) continue;

      console.log(`\nMigrating: ${table} (${counts[table].toLocaleString()} rows)`);

      // Get column info from SQLite
      const columns = sqliteDb.prepare(`PRAGMA table_info(${table})`).all();
      const colNames = columns
        .filter(c => c.name !== 'id' || !columns.some(cc => cc.name === 'id' && cc.type.includes('INTEGER') && cc.pk))
        .map(c => c.name);

      // For tables with AUTOINCREMENT id, skip the id column (PG SERIAL handles it)
      const hasSerialId = columns.some(c => c.name === 'id' && c.type.includes('INTEGER') && c.pk);
      const selectCols = hasSerialId ? colNames.filter(c => c !== 'id') : colNames;

      // If we filtered out 'id', also remove it from insert
      const insertCols = selectCols;

      if (insertCols.length === 0) {
        console.log(`  SKIP — no columns to migrate`);
        continue;
      }

      // Build PG INSERT with conflict handling
      const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(', ');
      const conflictCol = getConflictColumn(table, columns);
      const onConflict = conflictCol
        ? ` ON CONFLICT (${conflictCol}) DO NOTHING`
        : '';

      const insertSql = `INSERT INTO ${table} (${insertCols.join(', ')}) VALUES (${placeholders})${onConflict}`;

      // Batch migrate
      let offset = 0;
      let migrated = 0;

      while (offset < counts[table]) {
        const rows = sqliteDb.prepare(
          `SELECT ${selectCols.join(', ')} FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`
        ).all(batchSize, offset);

        if (rows.length === 0) break;

        // Use PG transaction for batch
        const client = await pgPool.connect();
        try {
          await client.query('BEGIN');
          for (const row of rows) {
            const values = insertCols.map(col => {
              const val = row[col];
              // Convert SQLite integers used as booleans
              if (val === 0 || val === 1) {
                const colDef = columns.find(c => c.name === col);
                if (colDef && colDef.type === 'INTEGER' && (col === 'archived' || col === 'enabled')) {
                  return Boolean(val);
                }
              }
              return val;
            });
            await client.query(insertSql, values);
          }
          await client.query('COMMIT');
          migrated += rows.length;
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`  ERROR at offset ${offset}: ${err.message}`);
          break;
        } finally {
          client.release();
        }

        offset += batchSize;
        process.stdout.write(`  ${migrated.toLocaleString()} / ${counts[table].toLocaleString()} rows\r`);
      }

      console.log(`  ${migrated.toLocaleString()} / ${counts[table].toLocaleString()} rows — DONE`);
      migratedTotal += migrated;

      // Reset PG serial sequence to max migrated id
      if (hasSerialId) {
        try {
          await pgPool.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`);
        } catch {
          // Non-critical — sequence might not exist for non-SERIAL tables
        }
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n=== Migration Complete ===`);
    console.log(`  Total rows: ${migratedTotal.toLocaleString()}`);
    console.log(`  Time: ${elapsed}s`);
    console.log(`  Speed: ${(migratedTotal / parseFloat(elapsed)).toFixed(0)} rows/s`);

  } finally {
    sqliteDb.close();
    await pgPool.end();
  }
}

/**
 * Determine conflict column for ON CONFLICT DO NOTHING.
 */
function getConflictColumn(table, columns) {
  // Tables with TEXT PRIMARY KEY
  const textPkTables = {
    sessions: 'id',
    user_mappings: 'slack_user_id',
    session_snapshots: 'session_id',
    distributed_locks: 'lock_key',
  };
  if (textPkTables[table]) return textPkTables[table];

  // Tables with UNIQUE constraints
  const uniqueConstraints = {
    episodic_memory: 'content_hash',
    semantic_memory: 'content_hash',
    memories: 'content_hash',
    cron_jobs: 'name',
    agent_messages: 'msg_id',
    bulletins: 'agent_id, channel_id',
  };
  if (uniqueConstraints[table]) return uniqueConstraints[table];

  return null;
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
