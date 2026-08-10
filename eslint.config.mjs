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
              // Only the non-public mutation surface of @voxel-maker/document
              // (issue #91) may be imported below the root entrypoint; the
              // boundary check additionally limits it to integration
              // packages (command bus, lifecycle, fixtures).
              group: ["@voxel-maker/*/*", "!@voxel-maker/document/internal"],
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
