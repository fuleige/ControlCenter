import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './e2e', testMatch: '**/node-tools.e2e.ts', fullyParallel: false, workers: 1, reporter: 'line',
  use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, locale: 'zh-CN' }, projects: [{ name: 'desktop' }] });
