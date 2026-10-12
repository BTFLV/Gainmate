import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import refresh from 'eslint-plugin-react-refresh';
export default tseslint.config({ignores:['dist','target','node_modules','src-tauri/gen','.audio-build','test-results']},js.configs.recommended,...tseslint.configs.recommended,{files:['src/**/*.{ts,tsx}'],languageOptions:{globals:globals.browser},plugins:{'react-hooks':hooks,'react-refresh':refresh},rules:{...hooks.configs.recommended.rules,'react-refresh/only-export-components':['warn',{allowConstantExport:true}]}},{files:['scripts/**/*.mjs','*.js'],languageOptions:{globals:globals.node}});
