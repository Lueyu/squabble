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
    extends: [
      ...tseslint.configs.recommended,
    ],
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
    extends: [
      ...tseslint.configs.recommended,
    ],
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
          map: [['@server', './server'], ['@shared', './shared']],
          extensions: ['.js', '.jsx', '.ts', '.tsx'],
        },
      },
    },
  },
  // Retained executors and readers consume neutral team context, never the Teams orchestration module.
  { files: ['server/modules/research-runtime/**/*.ts', 'server/modules/council/**/*.ts', 'server/modules/research-memory/**/*.ts', 'server/modules/research-tools/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ regex: '(^|/)teams(/|$)', message: 'Use neutral shared/database team context rather than TeamsModule.' }] }] } },
  // Pages compose features. Features must stay reusable without pulling page
  // routing, polling or lifecycle state back into their own implementation.
  {
    files: ['client/src/features/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/pages/**', '@/pages/**', '@client/src/pages/**'],
          message: 'Features may use shared UI and APIs; pages compose features, not the reverse.',
        }],
      }],
    },
  },
  {
    files: ['shared/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '^(@/|@client/|@server/)|(^|/)(client|server)(/|$)',
          message: 'Shared contracts must not depend on client or server implementations.',
        }],
      }],
    },
  },
  // Keep shared research infrastructure below both current and retained
  // orchestration. These are static import/re-export checks, not DI validation.
  {
    files: ['server/modules/research-core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '(^|/)(multi-agent|experience|paper-trading|council|channel|research-routing|research-runtime|research-tools|tool-connections|tool-actions|tool-capabilities|teams)(/|$)',
          message: 'Research core provides infrastructure to workflows and must not import them.',
        }],
      }],
    },
  },
  {
    files: ['server/modules/tool-connections/**/*.ts', 'server/modules/tool-actions/**/*.ts', 'server/modules/tool-capabilities/**/*.ts',
      'server/modules/research-artifacts/**/*.ts', 'server/modules/research-compute/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '(^|/)(multi-agent|experience|paper-trading|council|channel|research-routing|research-tools|teams)(/|$)',
          message: 'Tool infrastructure must not depend on investment workflows or their research-tool facade.',
        }],
      }],
    },
  },
  {
    files: ['server/modules/research-routing/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '(^|/)(multi-agent|experience|paper-trading|council|channel|teams)(/|$)',
          message: 'Research routing selects an executor independently of its feature consumers.',
        }],
      }],
    },
  },
  {
    files: ['server/modules/paper-trading/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '(^|/)experience(/|$)',
          message: 'Use research-routing or research-core instead of the experience facade.',
        }],
      }],
    },
  },
);
