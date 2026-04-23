module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-non-null-assertion': 'off',
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
  overrides: [
    {
      files: ['src/routes/dashboard.ts', 'src/routes/admin*.ts', 'src/routes/setup.ts'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [{
            group: ['**/cloud-api/**', '../cloud-api/**', '../../cloud-api/**'],
            message: 'Dashboard/admin/setup may not import from cloud-api. Duplicate the helper in routes/ or db/.',
          }],
        }],
      },
    },
    {
      files: ['src/cloud-api/**/*.ts'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [{
            group: [
              '**/routes/dashboard*',
              '**/routes/admin*',
              '**/routes/setup*',
              '../routes/dashboard*',
              '../routes/admin*',
              '../routes/setup*',
              '../../routes/dashboard*',
              '../../routes/admin*',
              '../../routes/setup*',
            ],
            message: 'cloud-api is a frozen tree. Only import from db/, mqtt/, types/, shared test harness.',
          }],
        }],
      },
    },
  ],
};
