import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  define: {
    "process.version": "undefined",
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      external: (id, importer) =>
        id === "@puppeteer/browsers" ||
        id === "chromium-bidi/lib/bidiMapper/BidiMapper.js" ||
        id.includes("/puppeteer-core/lib/puppeteer/node/") ||
        (id.startsWith("node:") && importer?.includes("/puppeteer-core/") === true),
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        background: fileURLToPath(new URL("./src/background.ts", import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
      },
    },
  },
});
