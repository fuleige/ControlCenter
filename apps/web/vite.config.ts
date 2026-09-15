import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The displayed version is fixed when Vite starts; restart the dev server after a version bump.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
const allowedHosts = (process.env.WEB_ALLOWED_HOSTS ?? "c.llmdev.cn")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/katex/")) return "katex-vendor";
          if (id.includes("/@tanstack/")) return "virtualizer-vendor";
          if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/scheduler/")) return "react-vendor";
          if (/\/(?:react-markdown|remark-|rehype-|micromark|mdast-|hast-|unist-|unified|vfile)/.test(id)) return "markdown-vendor";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    allowedHosts,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
      "/agent/connect": {
        target: "ws://127.0.0.1:8787",
        ws: true,
      },
      "/agent/enroll": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
      "/agent/attachments": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
      "/healthz": "http://127.0.0.1:8787",
      "/readyz": "http://127.0.0.1:8787",
    },
  },
});
