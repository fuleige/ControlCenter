import { defineConfig } from "@playwright/test";

const requestedPort = process.env.PLAYWRIGHT_PORT ?? "5173";
const port = /^\d+$/.test(requestedPort) ? requestedPort : "5173";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  reporter: "line",
  use: {
    baseURL,
    locale: "zh-CN",
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: true,
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "tablet", use: { viewport: { width: 820, height: 900 }, hasTouch: true } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: "compact-mobile", use: { viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true } },
  ],
});
