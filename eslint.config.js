/**
 * eslint.config.js — flat ESLint config for the whole monorepo.
 *
 * Two typed-linting blocks:
 *  1. Client (client/** + shared/**) with tsconfig.app.json as the project.
 *  2. Server (server/** + shared/**) with tsconfig.node.json as the project.
 *
 * The shared/ directory is linted under both configs so cross-cutting types
 * are checked consistently. Import aliases (@, @client, @server, @shared) are
 * wired into the import resolver for both blocks.
 */
const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');

module.exports = tseslint.config(
  {
    ignores: [
      'dist',
      'dist-server',
      'node_modules',
      'source_package',
      'client/src/api/gen',
      '**/*.d.ts',
      '**/*.js.map',
      '**/*.spec.ts',
      '**/*.e2e-spec.ts',
    ],
  },
  // Client configuration
  {
    files: ['client/**/*.{ts,tsx}', 'shared/**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommended],
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      parserOptions: {
        project: './tsconfig.app.json',
      },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
    settings: {
      'import/resolver': {
        alias: {
          map: [
            ['@', './client/src'],
            ['@client', './client'],
            ['@shared', './shared'],
          ],
          extensions: ['.js', '.jsx', '.ts', '.tsx'],
        },
      },
    },
  },
  // Server configuration
  {
    files: ['server/**/*.{ts,tsx}', 'shared/**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.node.json',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
    settings: {
      'import/resolver': {
        alias: {
          map: [
            ['@server', './server'],
            ['@shared', './shared'],
          ],
          extensions: ['.js', '.jsx', '.ts', '.tsx'],
        },
      },
    },
  },
);
