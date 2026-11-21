import { fileURLToPath } from "node:url";
import react from "@eslint-react/eslint-plugin";
import js from "@eslint/js";
import next from "@next/eslint-plugin-next";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import hooks from "eslint-plugin-react-hooks";
import globals from "globals";
import typescript from "typescript-eslint";

export default defineConfig(
  includeIgnoreFile(fileURLToPath(new URL(".gitignore", import.meta.url)), { gitignoreResolution: true }),
  js.configs.recommended,
  { languageOptions: { globals: globals.node } },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [typescript.configs.recommended],
  },
  {
    files: ["src/**/*.tsx"],
    extends: [react.configs["recommended-typescript"], hooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "@next/next": next },
    rules: { ...next.configs.recommended.rules, ...next.configs["core-web-vitals"].rules },
  },
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
);
