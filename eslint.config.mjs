import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/coverage/**",
      ".agents/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@voxel-maker/*/*"],
              message: "Use only another package's exported root entrypoint.",
            },
          ],
        },
      ],
    },
  },
  { ...tseslint.configs.disableTypeChecked, files: ["**/*.mjs", "**/*.cjs"] },
  {
    files: ["**/*.mjs", "**/*.cjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        module: "readonly",
      },
    },
  },
);
