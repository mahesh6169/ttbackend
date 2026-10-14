import globals from "globals";
import pluginJs from "@eslint/js";

/** @type {import('eslint').Linter.Config[]} */
export default [
  // Default configurations already present
  {
    files: ["**/*.js"],
    languageOptions: { sourceType: "commonjs" },
  },
  {
    languageOptions: { globals: globals.browser },
  },
  pluginJs.configs.recommended,

  // Custom rules and configurations
  {
    files: ["**/*.js"], // Apply these rules to all JS files
    plugins: {
      prettier: "eslint-plugin-prettier",
      node: "eslint-plugin-node",
    },
    extends: [
      "airbnb", 
      "plugin:prettier/recommended", 
      "plugin:node/recommended",
    ],
    rules: {
      "prettier/prettier": "error",
      "no-unused-vars": "warn",
      "no-console": "off",
      "func-names": "off",
      "no-process-exit": "off",
      "object-shorthand": "off",
      "class-methods-use-this": "off",
    },
  },
];
