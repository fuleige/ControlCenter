import { readFileSync } from "node:fs";
import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

// The displayed version is fixed when Vite starts; restart the dev server after a version bump.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
const allowedHosts = (process.env.WEB_ALLOWED_HOSTS ?? "c.llmdev.cn")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);
const controlPlaneUrl = process.env.CONTROL_PROXY_URL?.trim() || "http://127.0.0.1:8787";
const controlPlaneWebSocketUrl = controlPlaneUrl.replace(/^http/, "ws");
const controlProxyOrigin = process.env.CONTROL_PROXY_ORIGIN?.trim();
const developmentSessionCookie = "cc_dev_session";

function upstreamCookieHeader(cookieHeader: string): string {
  const cookies = cookieHeader.split(/;\s*/u);
  const developmentCookie = cookies.find((cookie) => cookie.startsWith(`${developmentSessionCookie}=`));
  if (!developmentCookie) return cookieHeader;
  const value = developmentCookie.slice(developmentSessionCookie.length + 1);
  const withoutDevelopmentCookie = cookies.filter((cookie) => !cookie.startsWith(`${developmentSessionCookie}=`));
  return [...withoutDevelopmentCookie, `__Host-cc_session=${value}`, `cc_session=${value}`].join("; ");
}

function developmentSetCookieHeader(value: string): string {
  return value
    .replace(/^(?:__Host-cc_session|cc_session)=/u, `${developmentSessionCookie}=`)
    .replace(/;\s*Secure\b/giu, "");
}

function controlProxy(target: string, websocket = false): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    ...(websocket ? { ws: true } : {}),
    configure(proxy) {
      proxy.on("proxyReq", (proxyRequest, request) => {
        if (request.headers.cookie) proxyRequest.setHeader("Cookie", upstreamCookieHeader(request.headers.cookie));
        if (controlProxyOrigin && request.headers.origin) proxyRequest.setHeader("Origin", controlProxyOrigin);
      });
      proxy.on("proxyReqWs", (proxyRequest, request) => {
        if (controlProxyOrigin && request.headers.origin) proxyRequest.setHeader("Origin", controlProxyOrigin);
      });
      proxy.on("proxyRes", (proxyResponse) => {
        const setCookie = proxyResponse.headers["set-cookie"];
        if (!setCookie) return;
        proxyResponse.headers["set-cookie"] = (Array.isArray(setCookie) ? setCookie : [setCookie])
          .map(developmentSetCookieHeader);
      });
    },
  };
}

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
    port: 5174,
    strictPort: true,
    allowedHosts,
    proxy: {
      "/api": controlProxy(controlPlaneUrl),
      "/agent/connect": controlProxy(controlPlaneWebSocketUrl, true),
      "/agent/enroll": controlProxy(controlPlaneUrl),
      "/agent/attachments": controlProxy(controlPlaneUrl),
      "/healthz": controlProxy(controlPlaneUrl),
      "/readyz": controlProxy(controlPlaneUrl),
    },
  },
});
