/**
 * 002_add_search_vector.js — Add TSVECTOR search_vector columns for FTS.
 *
 * Adds search_vector TSVECTOR column + GIN index + auto-update trigger
 * to episodic_memory, semantic_memory, memories tables.
 * Backfills existing data.
 */
module.exports = {
  name: '002_add_search_vector',

  up: async (client) => {
    // 1. Add search_vector columns
    await client.query(`
      ALTER TABLE episodic_memory ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;
      ALTER TABLE semantic_memory ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;
      ALTER TABLE memories ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;
    `);

    // 2. Create GIN indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_episodic_fts ON episodic_memory USING GIN(search_vector);
      CREATE INDEX IF NOT EXISTS idx_semantic_fts ON semantic_memory USING GIN(search_vector);
      CREATE INDEX IF NOT EXISTS idx_memories_fts ON memories USING GIN(search_vector);
    `);

    // 3. Auto-update trigger function
    await client.query(`
      CREATE OR REPLACE FUNCTION update_search_vector() RETURNS trigger AS $$
      BEGIN
        NEW.search_vector := to_tsvector('simple', COALESCE(NEW.content, ''));
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // 4. Attach triggers to each table
    const tables = ['episodic_memory', 'semantic_memory', 'memories'];
    for (const table of tables) {
      await client.query(`
        DROP TRIGGER IF EXISTS trg_${table}_search_vector ON ${table};
        CREATE TRIGGER trg_${table}_search_vector
          BEFORE INSERT OR UPDATE OF content ON ${table}
          FOR EACH ROW EXECUTE FUNCTION update_search_vector();
      `);
    }

    // 5. Backfill existing data
    for (const table of tables) {
      await client.query(`
        UPDATE ${table} SET search_vector = to_tsvector('simple', COALESCE(content, ''))
        WHERE search_vector IS NULL;
      `);
    }
  },

  down: async (client) => {
    const tables = ['episodic_memory', 'semantic_memory', 'memories'];
    for (const table of tables) {
      await client.query(`DROP TRIGGER IF EXISTS trg_${table}_search_vector ON ${table}`);
      await client.query(`DROP INDEX IF EXISTS idx_${table.replace('_memory', '')}_fts`);
      await client.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS search_vector`);
    }
    await client.query(`DROP FUNCTION IF EXISTS update_search_vector()`);
  },
};
