import js from '@eslint/js'
import tseslint from 'typescript-eslint'
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // These expressions intentionally reject control bytes in untrusted paths.
  { files: ['src/core.ts', 'src/safe-files.ts'], rules: { 'no-control-regex': 'off' } },
  { files: ['scripts/*.mjs'], languageOptions: { globals: { console: 'readonly', process: 'readonly' } } },
)
