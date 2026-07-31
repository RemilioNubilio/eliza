/**
 * Vite configuration for the scaffolded minimal React app.
 */

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset URLs so the same bundle serves both from the verifier root
  // and from the nubilio.org/apps/<slug>/ subpath.
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
