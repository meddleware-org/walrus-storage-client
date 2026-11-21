import { defineConfig, globalIgnores } from 'eslint/config'
import tseslint from 'typescript-eslint'

// Flat ESLint config for a TypeScript library (no Vue SFCs): typescript-eslint's recommended
// rules — the same TypeScript rule set the Vue repos get via @vue/eslint-config-typescript,
// without that preset's Vue-only dependencies.
export default defineConfig(
  // localnet/ vendors an upstream Walrus checkout with its own tooling — not ours to lint.
  globalIgnores(['**/dist/**', '**/coverage/**', '**/*.d.ts', 'localnet/**']),
  // The TypeScript rule set, applied to every TypeScript file.
  {
    name: 'walrus-storage-client/typescript',
    files: ['**/*.{ts,mts,tsx}'],
    extends: [tseslint.configs.recommended],
  },

  // Repository-specific adjustments to that set.
  {
    name: 'walrus-storage-client/overrides',
    files: ['**/*.{ts,mts,tsx}'],
    rules: {
      // Underscore-prefixed args/vars are an intentional "unused" marker; rest-sibling
      // destructuring (`const { a, ...rest } = x`) is a legitimate key-omission pattern.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },

  {
    // Tests use deliberately loose typing for mocks/stubs.
    name: 'walrus-storage-client/test-overrides',
    files: ['**/*.{test,spec}.{ts,tsx}', 'tests/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
