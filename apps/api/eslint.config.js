import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'src/matching/**', 'src/db/migrations/**', 'storage', '.pgdata', '.test-pgdata'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
