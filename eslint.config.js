import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/node_modules/**',
      'packages/db/src/generated/**',
      '.claude/**',
      '**/next-env.d.ts',
      '**/test-results/**',
      '**/playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    // Test clients read untyped JSON responses.
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // packages/domain must stay free of framework imports (NFR-MAINT-01).
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['@nestjs/*', 'next', 'next/*', 'react', '@prisma/*', 'bullmq', '@datoflow/db'],
        },
      ],
    },
  },
  {
    // Raw hex colours are not allowed in components; use the Caldera tokens.
    files: ['apps/web/src/**/*.tsx', 'packages/ui/src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/#[0-9a-fA-F]{3,8}\b/]',
          message: 'Use a Caldera token utility, not a raw hex value.',
        },
      ],
    },
  },
);
