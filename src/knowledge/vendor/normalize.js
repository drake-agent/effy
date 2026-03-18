// Vendor: Context Hub (@aisuite/chub) — ESM→CJS conversion for Effy v3.6.1

const ALIASES = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  rb: 'ruby',
  cs: 'csharp',
};

const DISPLAY = {
  javascript: 'js',
  typescript: 'ts',
  python: 'py',
  ruby: 'rb',
  csharp: 'cs',
};

function normalizeLanguage(lang) {
  if (!lang) return null;
  const lower = lang.toLowerCase();
  return ALIASES[lower] || lower;
}

function displayLanguage(lang) {
  return DISPLAY[lang] || lang;
}

module.exports = { normalizeLanguage, displayLanguage };
