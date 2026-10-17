import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2025, sourceType: 'module', globals: globals.node },
    rules: { 'no-unused-vars': 'error', 'no-empty': 'error', eqeqeq: 'error', 'prefer-const': 'error' },
  },
];
