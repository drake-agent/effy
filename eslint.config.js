/**
 * eslint.config.js — ESLint v10 Flat Config.
 *
 * Migrated from .eslintrc.json (ESLint 8) to flat config (ESLint 10).
 * v3.9: Node.js 24 LTS + ESLint 10
 */
const js = require('@eslint/js');
const pluginSecurity = require('eslint-plugin-security');
const pluginPromise = require('eslint-plugin-promise');
const pluginNoUnsanitized = require('eslint-plugin-no-unsanitized');

module.exports = [
  // ─── Global ignores ───
  {
    ignores: [
      'node_modules/',
      'data/',
      'coverage/',
      'src/dashboard/app.jsx',
      'shared/',
      'reviews/',
    ],
  },

  // ─── Base: eslint recommended ───
  js.configs.recommended,

  // ─── Plugin: security recommended ───
  pluginSecurity.configs.recommended,

  // ─── Plugin: promise recommended ───
  pluginPromise.configs['flat/recommended'],

  // ─── Main config for all JS files ───
  {
    files: ['src/**/*.js', 'tests/**/*.js'],
    plugins: {
      'no-unsanitized': pluginNoUnsanitized,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        // Node.js globals
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        fetch: 'readonly',
        structuredClone: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        // ES2022
        Map: 'readonly',
        Set: 'readonly',
        WeakMap: 'readonly',
        WeakSet: 'readonly',
        Promise: 'readonly',
        Symbol: 'readonly',
        BigInt: 'readonly',
        globalThis: 'readonly',
        queueMicrotask: 'readonly',
      },
    },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-return-await': 'warn',
      'no-throw-literal': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'warn',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-constant-binary-expression': 'error',

      'security/detect-object-injection': 'off',
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-non-literal-require': 'off',

      'promise/always-return': 'off',
      'promise/catch-or-return': ['warn', { allowFinally: true }],
      'promise/no-nesting': 'warn',

      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',

      'no-empty': 'warn',
      'no-useless-escape': 'warn',
      'no-fallthrough': 'warn',
      'promise/param-names': 'warn',
    },
  },

  // ─── Override: test files ───
  {
    files: ['tests/**/*.js', 'test-*.js'],
    rules: {
      'no-unused-vars': 'off',
      'security/detect-possible-timing-attacks': 'off',
    },
  },

  // ─── Override: browser tool ───
  {
    files: ['src/tools/a11y-browser.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        HTMLElement: 'readonly',
        NodeFilter: 'readonly',
        TreeWalker: 'readonly',
      },
    },
    rules: {
      'no-undef': 'off',
    },
  },

  // ─── Override: skills ───
  {
    files: ['src/skills/*.js'],
    rules: {
      'no-empty': 'warn',
    },
  },
];
