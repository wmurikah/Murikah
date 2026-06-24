// Flat ESLint config (ESLint 10) — TypeScript + Astro, kept pragmatic.
import tseslint from 'typescript-eslint';
import astro from 'eslint-plugin-astro';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      '.astro/',
      'node_modules/',
      '.wrangler/',
      'worker-configuration.d.ts',
      'pnpm-lock.yaml',
    ],
  },

  // Base TypeScript recommendations (also covers React .tsx islands).
  ...tseslint.configs.recommended,

  // Astro component linting (.astro parser + recommended rules).
  ...astro.configs['flat/recommended'],

  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // Underscore-prefixed args/vars are intentional throwaways.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  {
    // Declaration files legitimately use triple-slash references and empty
    // interface extensions (the standard Astro env.d.ts pattern).
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/triple-slash-reference': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
);
