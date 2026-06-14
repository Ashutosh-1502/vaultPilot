'use strict';

const tseslint = require('typescript-eslint');
const importPlugin = require('eslint-plugin-import');

const VSCODE_RESTRICTION = {
  name: 'vscode',
  message:
    'Pure-logic modules must NOT import the `vscode` namespace directly. Use src/vscode-host.ts.',
};

const FS_PATTERN_RESTRICTION = {
  group: ['fs', 'node:fs', 'fs/promises', 'node:fs/promises'],
  message:
    'Within src/vault/, only io.ts may import fs directly. Other vault modules use atomicWriteFile or io.ts read helpers.',
};

module.exports = tseslint.config(
  {
    ignores: ['dist/**', 'out/**', 'node_modules/**', '.vscode-test/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
      },
    },
    extends: [...tseslint.configs.strictTypeChecked],
    plugins: {
      import: importPlugin,
    },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'import/no-default-export': 'error',
    },
  },
  {
    // Pure-logic modules outside src/vault/ — forbid direct `vscode` import.
    // `src/archive/archive-view.ts` is excepted because it's a TreeDataProvider
    // that inherently needs the `vscode` namespace; the architecture's file
    // tree explicitly places it under src/archive/ for feature cohesion.
    files: [
      'src/result/**/*.ts',
      'src/fingerprint/**/*.ts',
      'src/credentials/**/*.ts',
      'src/archive/**/*.ts',
      'src/drive/**/*.ts',
      'src/keychain/**/*.ts',
      'src/settings/**/*.ts',
      'src/logging/**/*.ts',
    ],
    ignores: ['src/archive/archive-view.ts', 'src/drive/auth.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [VSCODE_RESTRICTION] }],
    },
  },
  {
    // src/vault/** (except io.ts) — forbid direct `vscode` AND direct `fs`.
    // Vault internals must route filesystem ops through io.ts.
    files: ['src/vault/**/*.ts'],
    ignores: ['src/vault/io.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [VSCODE_RESTRICTION],
          patterns: [FS_PATTERN_RESTRICTION],
        },
      ],
    },
  },
  {
    // io.ts — the sole filesystem gate. Still no `vscode` import (pure logic).
    files: ['src/vault/io.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [VSCODE_RESTRICTION] }],
    },
  },
  {
    // Test files relax type-checking strictness for mock convenience.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/require-await': 'off',
      'no-restricted-imports': 'off',
    },
  },
);
