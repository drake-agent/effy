// Vendor: Context Hub (@aisuite/chub) — ESM→CJS conversion for Effy v3.6.2

const { parse: parseYaml } = require('yaml');

/**
 * Parse YAML frontmatter from markdown content.
 * Returns { attributes, body } where attributes is the parsed YAML object.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { attributes: {}, body: content };
  return {
    attributes: parseYaml(match[1]) || {},
    body: match[2],
  };
}

module.exports = { parseFrontmatter };
