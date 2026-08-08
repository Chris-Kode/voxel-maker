import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite configuration for the desktop web app (plan S6.1). The Tauri shell
 * loads this dev server in development and the built `dist` in packaged
 * builds; the strict content-security policy itself lives in
 * `src-tauri/tauri.conf.json`.
 */
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three"],
        },
      },
    },
  },
});
