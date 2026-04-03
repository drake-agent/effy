#!/usr/bin/env node
/**
 * migrate-cli.js — CLI entry point for Effy database migrations.
 *
 * Usage:
 *   node src/db/migrate-cli.js [up|down|status]
 *
 *   up      (default) — apply all pending migrations
 *   down    — roll back the last applied migration
 *   status  — show migration status
 *
 * Environment:
 *   DATABASE_URL or DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
 */
const { migrate, rollback, status } = require('./migrations/runner');

// Minimal bootstrap: connect pg pool without full Effy init
async function createPool() {
  const { Pool } = require('pg');

  const url = process.env.DATABASE_URL;
  if (url) {
    const parsed = new URL(url);
    return new Pool({
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port || '5432', 10),
      database: (parsed.pathname || '/effy').slice(1),
      user: parsed.username || 'effy',
      password: parsed.password || '',
      ssl: parsed.searchParams.get('ssl') === 'true' ||
           parsed.searchParams.get('sslmode') === 'require'
             ? { rejectUnauthorized: false }
             : false,
    });
  }

  return new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'effy',
    user: process.env.DB_USER || 'effy',
    password: process.env.DB_PASSWORD || '',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
}

async function main() {
  // Load .env if available
  try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

  const command = (process.argv[2] || 'up').toLowerCase();
  const pool = await createPool();

  try {
    switch (command) {
      case 'up': {
        console.log('Running pending migrations...');
        const applied = await migrate(pool);
        if (applied.length === 0) {
          console.log('No pending migrations.');
        } else {
          console.log(`Applied ${applied.length} migration(s):`);
          applied.forEach(name => console.log(`  + ${name}`));
        }
        break;
      }

      case 'down': {
        const steps = parseInt(process.argv[3] || '1', 10);
        console.log(`Rolling back ${steps} migration(s)...`);
        const rolledBack = await rollback(steps, pool);
        if (rolledBack.length === 0) {
          console.log('No migrations to roll back.');
        } else {
          console.log(`Rolled back ${rolledBack.length} migration(s):`);
          rolledBack.forEach(name => console.log(`  - ${name}`));
        }
        break;
      }

      case 'status': {
        const list = await status(pool);
        if (list.length === 0) {
          console.log('No migrations found.');
        } else {
          console.log('Migration status:');
          const maxName = Math.max(...list.map(m => m.name.length));
          list.forEach(m => {
            const pad = m.name.padEnd(maxName);
            const tag = m.status === 'applied' ? 'APPLIED' : 'PENDING';
            const at = m.applied_at ? `  (${new Date(m.applied_at).toISOString()})` : '';
            console.log(`  ${pad}  ${tag}${at}`);
          });
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.error('Usage: node src/db/migrate-cli.js [up|down|status]');
        process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Migration error:', err.message);
  process.exit(1);
});
