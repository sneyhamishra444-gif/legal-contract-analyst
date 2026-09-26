import path from "node:path";
import { fileURLToPath } from "node:url";

import { FlatCompat } from "@eslint/eslintrc";

/**
 * ESLint 9 reads a flat config; `eslint-config-next` is still published in the
 * older `extends` format, so it is bridged here rather than pinning the project
 * to ESLint 8. This is the migration Next's own docs recommend.
 */
const compat = new FlatCompat({
  baseDirectory: path.dirname(fileURLToPath(import.meta.url)),
});

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "docs/screenshots/**",
      "fixtures/**",
      "next-env.d.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // The codebase uses `void promise` to mark a deliberately unawaited call.
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
];

export default config;
