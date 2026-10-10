import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist", "src-tauri", "node_modules", "android", "gen"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      // Deliberate best-effort fallbacks (localStorage writes, optional
      // cleanup) throughout the codebase use an intentionally empty
      // `catch {}` rather than logging noise for errors nobody acts on.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // TerminalView.tsx matches raw ANSI escape/bell bytes (\x1b, \x07) to
      // parse terminal control sequences — that's the feature, not a typo.
      "no-control-regex": "off",
    },
  },
);
