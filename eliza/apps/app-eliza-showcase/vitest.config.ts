/**
 * Vitest configuration for scaffolded minimal app project tests.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["dist/**", "**/node_modules/**"],
    environment: "node",
    // Plain summary reporter guarantees an uncolored `Tests …` line the app
    // verifier can parse even when the default reporter colorizes under a PTY.
    reporters: ["default", "./test-reporter-plain.ts"],
  },
});
