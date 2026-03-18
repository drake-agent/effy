/**
 * init.js — 독립 실행 스크립트. DB 스키마 초기화.
 * Usage: node src/db/init.js
 */
const { config } = require('../config');
const sqlite = require('./sqlite');

console.log('[db:init] Initializing database...');
const dbPath = config.db.sqlitePath;
sqlite.init(dbPath);
console.log('[db:init] Done. Tables created.');
sqlite.close();
