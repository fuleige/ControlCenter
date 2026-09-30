import { test, expect } from '@playwright/test';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { nodeToolsHarness } from '../../../tests/node-tools-harness';
let harness: Awaited<ReturnType<typeof nodeToolsHarness>>;
test.beforeEach(async ({ context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Node tools initially target desktop Chrome');
  harness = await nodeToolsHarness({ webDirectory: path.resolve('dist') });
  await context.addCookies([{ name: 'test-session', value: 'one', url: harness.origin }]);
});
test.afterEach(async () => { await harness?.close(); });
test('file page performs batch overwrite and native Chrome download', async ({ page }) => {
  let lostAck = false;
  await page.route('**/api/node-tools/tasks/*/chunks/*', async (route) => {
    if (!lostAck && route.request().method() === 'PUT') {
      lostAck = true;
      expect((await route.fetch()).ok()).toBe(true); // The server commits the bytes, then the response is lost.
      await route.abort('failed');
    } else await route.continue();
  });
  await writeFile(path.join(harness.directory, '已有文件.txt'), 'old');
  await writeFile(path.join(harness.directory, '.隐藏文件'), 'hidden');
  await page.goto(`${harness.origin}/nodes/node/files`);
  await expect(page.getByRole('heading', { name: '测试节点 · 节点文件' })).toBeVisible();
  await expect(page.getByText('.隐藏文件', { exact: true })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles([{ name: '已有文件.txt', mimeType: 'text/plain', buffer: Buffer.from('覆盖内容') }, { name: '新文件.txt', mimeType: 'text/plain', buffer: Buffer.from('新文件内容') }]);
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '确认覆盖并上传整批' }).click();
  await expect(page.getByText('已上传到节点', { exact: true })).toHaveCount(2);
  expect(lostAck).toBe(true);
  expect(await readFile(path.join(harness.directory, '已有文件.txt'), 'utf8')).toBe('覆盖内容');
  expect(await readFile(path.join(harness.directory, '新文件.txt'), 'utf8')).toBe('新文件内容');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 新文件.txt', exact: true }).check();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载所选文件（1）' }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('新文件.txt');
  const downloaded = await download.path(); expect(await readFile(downloaded!, 'utf8')).toBe('新文件内容');
  await expect(page.getByRole('status').filter({ hasText: '已请求浏览器下载，请在 Chrome 下载栏查看进度' })).toBeVisible();
  await expect(page.getByRole('button', { name: '再次下载' })).toBeVisible();
});
test('real PTY renders vim and tmux, and closing one tab leaves another usable', async ({ context, page: second }) => {
  await second.goto(`${harness.origin}/nodes/node/terminal`);
  const opened = context.waitForEvent('page');
  await second.evaluate((url) => { window.open(url, '_blank', 'noopener'); }, `${harness.origin}/nodes/node/terminal`);
  const page = await opened;
  await expect(page.getByRole('status')).toHaveText('已连接'); await expect(second.getByRole('status')).toHaveText('已连接');
  const input = page.locator('.xterm-helper-textarea'); await input.focus();
  const terminalBounds = await page.locator('.node-terminal').boundingBox();
  expect(terminalBounds!.height / page.viewportSize()!.height).toBeGreaterThan(0.9);
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('terminal-page'))).toBe(true);
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await input.focus();
  await page.keyboard.insertText('vim -u NONE -n /tmp/cc-vim-smoke.txt'); await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('cc-vim-smoke.txt');
  await page.keyboard.press('i'); await page.keyboard.insertText('VIM_SCREEN_OK');
  await expect(page.locator('.xterm-rows')).toContainText('VIM_SCREEN_OK');
  await page.screenshot({ path: 'test-results/node-tools-vim.png' });
  await page.keyboard.press('Escape'); await page.keyboard.insertText(':q!'); await page.keyboard.press('Enter');
  const socketName = `cc-test-${randomUUID()}`;
  try {
    await page.keyboard.insertText(`tmux -L ${socketName} new-session -s screen`); await page.keyboard.press('Enter');
    await expect(page.locator('.xterm-rows')).toContainText('[screen]');
    await page.screenshot({ path: 'test-results/node-tools-tmux.png' });
    await page.getByRole('button', { name: '关闭终端', exact: true }).click();
    expect(page.isClosed()).toBe(false);
    await expect(page.getByRole('status')).toHaveText('终端已关闭');
    await expect(input).toHaveJSProperty('readOnly', true);
    await expect(page.locator('.xterm-cursor-blink')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '新开终端', exact: true })).toBeVisible();
    await expect(page.locator('.node-terminal-ended-notice')).toBeVisible();
    const frozenOutput = await page.locator('.xterm-rows').innerText();
    await input.focus(); await page.keyboard.insertText('IGNORED_AFTER_CLOSE'); await page.keyboard.press('Enter');
    await expect(page.locator('.xterm-cursor')).toHaveCount(0);
    expect(await page.locator('.xterm-rows').innerText()).toBe(frozenOutput);
    await page.screenshot({ path: 'test-results/node-tools-ended.png' });
    await second.locator('.xterm-helper-textarea').focus(); await second.keyboard.insertText('printf "SECOND_TAB_OK\\n"'); await second.keyboard.press('Enter');
    await expect(second.locator('.xterm-rows')).toContainText('SECOND_TAB_OK');
    await second.close();
  } finally { try { execFileSync('tmux', ['-L', socketName, 'kill-server'], { stdio: 'ignore' }); } catch { /* test daemon already exited */ } }
});
test('file browser and transfers remain visible and scroll independently in a short window', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 520 });
  await Promise.all(Array.from({ length: 80 }, (_, index) => writeFile(path.join(harness.directory, `列表文件-${String(index).padStart(3, '0')}.txt`), 'scroll check')));
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/node-tools/tasks/*/chunks/*', async (route) => { await hold; await route.continue(); });
  try {
    await page.goto(`${harness.origin}/nodes/node/files`);
    await expect(page.getByRole('checkbox', { name: '选择 列表文件-000.txt', exact: true })).toBeVisible();
    await page.locator('input[type=file]').setInputFiles(Array.from({ length: 16 }, (_, index) => ({ name: `排队上传-${String(index).padStart(2, '0')}.txt`, mimeType: 'text/plain', buffer: Buffer.from('queued file') })));
    await expect(page.locator('.node-transfer-card')).toHaveCount(16);
    await expect(page.locator('.node-transfer-card').first().getByRole('status')).toHaveText('正在创建上传任务');
    for (const selector of ['.node-file-browser', '.node-file-transfer-panel']) {
      const bounds = await page.locator(selector).boundingBox();
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(520);
      expect(bounds!.height).toBeGreaterThan(300);
    }
    for (const selector of ['.node-files-list', '.node-file-transfers-list']) {
      const scrolling = await page.locator(selector).evaluate((element) => {
        const overflows = element.scrollHeight > element.clientHeight;
        element.scrollTop = element.scrollHeight;
        return { overflows, scrollTop: element.scrollTop };
      });
      expect(scrolling.overflows).toBe(true); expect(scrolling.scrollTop).toBeGreaterThan(0);
    }
    const last = page.locator('.node-transfer-card').last();
    await expect(last.getByText('排队上传-15.txt', { exact: true })).toBeVisible();
    await last.getByRole('button', { name: '取消', exact: true }).click();
    await expect(last.getByRole('status')).toHaveText('已取消');
    await page.screenshot({ path: 'test-results/node-tools-short-window.png' });
  } finally {
    release();
    await page.goto('about:blank');
  }
});
