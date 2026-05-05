// ESLint flat config (ESLint 9+).
//
// Kept intentionally minimal: typecheck (`tsc --noEmit`) catches the heavy
// stuff, so ESLint's job here is style consistency and the few semantic
// rules tsc can't enforce (e.g. unused locals with the underscore opt-out).

import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "examples/**",
      "**/*.cjs",
    ],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        // No `project` here — type-aware linting is doubled by tsc, and
        // adding it makes ESLint slow on every save in editors.
      },
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        ReadableStream: "readonly",
        Uint8Array: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        URL: "readonly",
        fetch: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      // tsc covers undefined symbols and type errors; eslint's `no-undef`
      // duplicates that and gets confused by ambient types.
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
