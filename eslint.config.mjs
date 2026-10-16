import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.recommended],
  },
  {
    files: ['homebridge-ui/public/**/*.js'],
    languageOptions: { globals: { ...globals.browser, homebridge: 'readonly' } },
  },
  {
    files: ['homebridge-ui/server.js', 'test/**/*.js', 'tools/**/*.mjs', '*.mjs'],
    languageOptions: { globals: globals.node },
  },
);
