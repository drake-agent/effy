// Vendor: Context Hub (@aisuite/chub) — ESM→CJS conversion for Effy v3.6.1

const { readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { getChubDir } = require('./config');

function getAnnotationsDir() {
  return join(getChubDir(), 'annotations');
}

function annotationPath(entryId) {
  // SEC-3: Proper filename sanitization using encodeURIComponent
  const safe = encodeURIComponent(entryId);
  return join(getAnnotationsDir(), `${safe}.json`);
}

function readAnnotation(entryId) {
  try {
    return JSON.parse(readFileSync(annotationPath(entryId), 'utf8'));
  } catch {
    return null;
  }
}

function writeAnnotation(entryId, note) {
  const dir = getAnnotationsDir();
  mkdirSync(dir, { recursive: true });
  const data = {
    id: entryId,
    note,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(annotationPath(entryId), JSON.stringify(data, null, 2));
  return data;
}

function clearAnnotation(entryId) {
  try {
    unlinkSync(annotationPath(entryId));
    return true;
  } catch {
    return false;
  }
}

function listAnnotations() {
  const dir = getAnnotationsDir();
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    return files.map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  readAnnotation,
  writeAnnotation,
  clearAnnotation,
  listAnnotations,
};
