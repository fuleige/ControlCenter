import { test, expect } from '@playwright/test';
import { writeFile, readFile, readdir, open, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DEFAULT_NODE_FILES_STUN_URLS } from '@controller-center/protocol';
import { nodeToolsHarness } from '../../../tests/node-tools-harness';
let harness: Awaited<ReturnType<typeof nodeToolsHarness>>;
test.beforeEach(async ({ context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Node tools initially target desktop Chrome');
  harness = await nodeToolsHarness({ webDirectory: path.resolve('dist'), direct: testInfo.title.includes('直连'),
    stunUrls: testInfo.title.includes('Cloudflare STUN') ? ['stun:stun.cloudflare.com:3478'] : testInfo.title.includes('STUN 默认') ? undefined : [] });
  await context.addCookies([{ name: 'test-session', value: 'one', url: harness.origin }]);
});
test.afterEach(async () => { await harness?.close(); });
async function installLocalPickers(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const target = window as unknown as { showSaveFilePicker: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>; showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> };
    target.showSaveFilePicker = async ({ suggestedName }) => (await navigator.storage.getDirectory()).getFileHandle(suggestedName, { create: true });
    target.showDirectoryPicker = async () => navigator.storage.getDirectory();
  });
}
test('直连 STUN 默认候选地址传递给网页', async () => {
  const response = await harness.request('/api/node-tools/nodes/node/pages', { method: 'POST' });
  expect((await response.json() as { stunUrls: string[] }).stunUrls).toEqual([...DEFAULT_NODE_FILES_STUN_URLS]);
});
test('直连部分 STUN 探测错误保留可用状态', async ({ page }) => {
  await page.route('**/api/node-tools/nodes/node/pages', async (route) => {
    const response = await route.fetch(); const body = await response.json();
    await route.fulfill({ response, json: { ...body, stunUrls: [...DEFAULT_NODE_FILES_STUN_URLS] } });
  });
  await page.addInitScript(() => {
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, { construct(target, args: [RTCConfiguration?]) { return new target({ ...args[0], iceServers: [] }); } });
    const create = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...args) {
      const channel = create.apply(this, args);
      channel.addEventListener('open', () => this.dispatchEvent(new RTCPeerConnectionIceErrorEvent('icecandidateerror', { url: 'stun:stun.l.google.com:19302', errorCode: 701, errorText: 'STUN binding request timed out.' })));
      return channel;
    };
  });
  await page.goto(`${harness.origin}/nodes/node/files`);
  await expect(page.getByRole('radio', { name: '直连上传', exact: true })).toBeChecked({ timeout: 25_000 });
  await page.getByText('直连诊断详情', { exact: true }).click();
  await expect(page.locator('.node-files-diagnostics')).toContainText('错误 701');
  await expect(page.getByRole('status').filter({ hasText: '直连可用' })).toBeVisible();
});
test('直连失败展示 STUN 地址错误与协商证据且不自动中转', async ({ page }) => {
  await page.route('**/api/node-tools/nodes/node/pages', async (route) => {
    const response = await route.fetch(); const body = await response.json();
    await route.fulfill({ response, json: { ...body, stunUrls: [...DEFAULT_NODE_FILES_STUN_URLS] } });
  });
  await page.addInitScript(() => {
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
      construct(target, args: [RTCConfiguration?]) { return new target({ ...args[0], iceServers: [] }); },
    });
    const original = RTCPeerConnection.prototype.setLocalDescription;
    RTCPeerConnection.prototype.setLocalDescription = async function (...args) {
      await original.apply(this, args);
      this.dispatchEvent(new RTCPeerConnectionIceErrorEvent('icecandidateerror', { url: 'stun:stun.cloudflare.com:3478', errorCode: 701, errorText: 'STUN binding request timed out.' }));
    };
  });
  await page.route('**/api/node-tools/files/direct/signal', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 'test-token' }) }));
  const messages: string[] = []; let tasks = 0;
  page.on('console', (message) => { if (message.type() === 'warning') messages.push(message.text()); });
  page.on('request', (request) => { if (/\/files\/(uploads|downloads)$/.test(request.url()) && request.method() === 'POST') tasks++; });
  await page.goto(`${harness.origin}/nodes/node/files`);
  await expect(page.locator('.node-file-browser')).toBeVisible();
  const browserBeforeFailure = await page.locator('.node-file-browser').boundingBox();
  await expect(page.getByRole('status').filter({ hasText: '两端建连超时' })).toBeVisible({ timeout: 15_000 });
  const details = page.locator('.node-files-diagnostics'); await expect(details).toHaveAttribute('open', '');
  await expect(details).toContainText('stun:stun.cloudflare.com:3478'); await expect(details).toContainText('错误 701');
  await expect(details).toContainText('STUN binding request timed out.'); await expect(details).toContainText('尚未收到节点协商响应');
  await expect(page.getByRole('radio', { name: '中转上传', exact: true })).toBeChecked(); expect(tasks).toBe(0);
  const browserAfterFailure = await page.locator('.node-file-browser').boundingBox();
  expect(browserAfterFailure!.y).toBeCloseTo(browserBeforeFailure!.y, 0);
  expect(browserAfterFailure!.height).toBeCloseTo(browserBeforeFailure!.height, 0);
  expect(messages.some((message) => message.includes('STUN 探测异常'))).toBe(true); expect(messages.some((message) => message.includes('直连失败'))).toBe(true);
  await page.screenshot({ path: '/tmp/controller-center-stun-diagnostics.png', fullPage: true });
});
test('直连协商接口失败展示真实原因及 HTTP 状态', async ({ page }) => {
  await page.route('**/api/node-tools/files/direct/signal', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '节点当前离线' }) }));
  await page.goto(`${harness.origin}/nodes/node/files`);
  await expect(page.getByRole('status').filter({ hasText: '控制中心与节点协商' })).toContainText('HTTP 409');
  await expect(page.locator('.node-files-diagnostics')).toContainText('节点当前离线');
  await expect(page.locator('.node-files-diagnostics')).toContainText('失败发生在协商消息');
});
test('直连浏览器初始化失败显示策略原因而非停留在检测中', async ({ page }) => {
  await page.addInitScript(() => { window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, { construct() { throw new DOMException('WebRTC is blocked by policy', 'NotAllowedError'); } }); });
  await page.goto(`${harness.origin}/nodes/node/files`);
  await expect(page.getByRole('status').filter({ hasText: '浏览器环境' })).toContainText('WebRTC is blocked by policy');
  await expect(page.getByRole('radio', { name: '中转上传', exact: true })).toBeChecked();
});
test('直连节点断开显示控制中心关闭原因', async ({ page }) => {
  await page.goto(`${harness.origin}/nodes/node/files`); await expect(page.getByRole('radio', { name: '直连上传', exact: true })).toBeChecked({ timeout: 25_000 });
  harness.tools.nodeDisconnected('node');
  await expect(page.getByRole('status').filter({ hasText: '直连中断' })).toContainText('节点连接已断开');
  await expect(page.locator('.node-files-diagnostics')).toHaveAttribute('open', '');
  await expect(page.locator('.node-files-diagnostics')).toContainText('文件传输连接');
});
test('直连 Cloudflare STUN 实际公网候选与文件上传下载', async ({ page }) => {
  test.skip(process.env.NODE_TOOLS_LIVE_STUN !== '1', 'Set NODE_TOOLS_LIVE_STUN=1 to test the public Cloudflare STUN service');
  test.setTimeout(60_000); await installLocalPickers(page);
  await page.addInitScript(() => {
    const create = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...args) {
      this.addEventListener('icecandidate', (event) => {
        if (event.candidate?.type === 'srflx') (window as unknown as { cloudflareCandidateObserved: boolean }).cloudflareCandidateObserved = true;
      });
      return create.apply(this, args);
    };
  });
  // A loopback connection can finish before external STUN replies and stop gathering.
  // Delay forwarding the offer until the browser has observed the real STUN response.
  await page.route('**/api/node-tools/files/direct/signal', async (route) => {
    if (route.request().postDataJSON()?.signal.type === 'offer') await page.waitForFunction(() => (window as unknown as { cloudflareCandidateObserved?: boolean }).cloudflareCandidateObserved, undefined, { timeout: 10_000 });
    await route.continue();
  });
  await page.goto(`${harness.origin}/nodes/node/files`);
  await expect(page.getByRole('radio', { name: '直连上传', exact: true })).toBeChecked({ timeout: 25_000 });
  await page.getByText('直连诊断详情', { exact: true }).click();
  const details = page.locator('.node-files-diagnostics');
  await expect(details).toContainText('stun:stun.cloudflare.com:3478：已取得公网候选', { timeout: 15_000 });
  await expect(details).toContainText(/浏览器候选：主机 \d+，公网 [1-9]\d*；节点候选：主机 \d+，公网 [1-9]\d*/);
  const bytes = Buffer.alloc(256 * 1024 + 17, 0x37);
  await page.locator('input[type=file]').setInputFiles({ name: 'Cloudflare-STUN.bin', mimeType: 'application/octet-stream', buffer: bytes });
  await expect(page.getByRole('status').filter({ hasText: '已上传到节点' })).toBeVisible({ timeout: 15_000 });
  expect(await readFile(path.join(harness.directory, 'Cloudflare-STUN.bin'))).toEqual(bytes);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 Cloudflare-STUN.bin' }).check(); await page.getByRole('button', { name: '下载所选文件（1）' }).click();
  await expect(page.getByRole('status').filter({ hasText: '已保存到电脑' })).toBeVisible({ timeout: 15_000 });
  const savedHash = await page.evaluate(async () => {
    const file = await (await (await navigator.storage.getDirectory()).getFileHandle('Cloudflare-STUN.bin')).getFile();
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), (byte) => byte.toString(16).padStart(2, '0')).join('');
  });
  expect(savedHash).toBe((await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'));
  expect(await readdir(path.join(harness.directory, 'stage'))).toEqual([]);
  console.log(`Cloudflare STUN 真实探测与上传下载通过：${(await details.innerText()).split('\n').slice(0, 5).join(' | ')}`);
});
test('直连上传和下载通过真实 DataChannel 与浏览器流式保存', async ({ page }) => {
  await installLocalPickers(page);
  let relayChunks = 0;
  page.on('request', (request) => { if (request.url().includes('/chunks/')) relayChunks++; });
  await page.goto(`${harness.origin}/nodes/node/files`);
  await expect(page.getByRole('radio', { name: '直连上传', exact: true })).toBeChecked({ timeout: 25_000 });
  await expect(page.getByRole('radio', { name: '直连下载', exact: true })).toBeChecked();
  const bytes = Buffer.alloc(3 * 1024 ** 2 + 17, 0x7b);
  await page.locator('input[type=file]').setInputFiles({ name: '直连完整性.bin', mimeType: 'application/octet-stream', buffer: bytes });
  await expect(page.getByRole('status').filter({ hasText: '已上传到节点' })).toBeVisible({ timeout: 30_000 });
  expect(await readFile(path.join(harness.directory, '直连完整性.bin'))).toEqual(bytes);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 直连完整性.bin' }).check();
  await page.getByRole('button', { name: '下载所选文件（1）' }).click();
  await expect(page.getByRole('status').filter({ hasText: '已保存到电脑' })).toBeVisible({ timeout: 30_000 });
  const saved = await page.evaluate(async () => { const file = await (await (await navigator.storage.getDirectory()).getFileHandle('直连完整性.bin')).getFile(); const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer()); return { size: file.size, hash: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('') }; });
  expect(saved.size).toBe(bytes.length); expect(saved.hash).toBe((await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'));
  expect(relayChunks).toBe(0); expect(await readdir(path.join(harness.directory, 'stage'))).toEqual([]);
});
test('直连下载取消保存选择不会启动任务或自动中转', async ({ page }) => {
  await installLocalPickers(page);
  await page.addInitScript(() => { (window as unknown as { showSaveFilePicker: () => Promise<never> }).showSaveFilePicker = async () => { throw new DOMException('cancelled', 'AbortError'); }; });
  await writeFile(path.join(harness.directory, '取消.txt'), 'keep'); let created = 0;
  page.on('request', (request) => { if (request.url().endsWith('/files/downloads') && request.method() === 'POST') created++; });
  await page.goto(`${harness.origin}/nodes/node/files`); await expect(page.getByRole('radio', { name: '直连下载', exact: true })).toBeChecked({ timeout: 25_000 });
  await page.getByRole('checkbox', { name: '选择 取消.txt' }).check(); await page.getByRole('button', { name: '下载所选文件（1）' }).click();
  await expect(page.locator('.node-transfer-card')).toHaveCount(0); expect(created).toBe(0); expect(await readdir(path.join(harness.directory, 'stage'))).toEqual([]);
});
test('直连缺少保存 API 时上传仍默认直连且手动中转选择保留', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined }); Object.defineProperty(window, 'showDirectoryPicker', { value: undefined }); });
  await page.goto(`${harness.origin}/nodes/node/files`); await expect(page.getByRole('radio', { name: '直连上传', exact: true })).toBeChecked({ timeout: 25_000 });
  await expect(page.getByRole('radio', { name: '中转下载', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: '直连下载', exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: '下载操作' })).toContainText('浏览器不支持直接保存文件');
  await expect(page.getByRole('region', { name: '上传操作' }).locator('.node-file-mode-status')).toHaveText('可用');
  await page.getByRole('radio', { name: '中转上传', exact: true }).check(); await page.getByRole('button', { name: '重新检测直连' }).click();
  await expect(page.getByRole('status').filter({ hasText: '直连可用' })).toBeVisible({ timeout: 25_000 }); await expect(page.getByRole('radio', { name: '中转上传', exact: true })).toBeChecked();
});
test('直连操作显示检测与可用状态且下载随选择变为蓝色', async ({ page }) => {
  await installLocalPickers(page);
  await writeFile(path.join(harness.directory, '操作样式.txt'), 'controls');
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/node-tools/files/direct/signal', async route => { await hold; await route.continue(); });
  let created = 0;
  page.on('request', request => { if (/\/files\/(uploads|downloads)$/.test(request.url()) && request.method() === 'POST') created++; });
  try {
    await page.goto(`${harness.origin}/nodes/node/files`);
    const upload = page.getByRole('region', { name: '上传操作' });
    const download = page.getByRole('region', { name: '下载操作' });
    await expect(page.getByRole('checkbox', { name: '选择 操作样式.txt' })).toBeVisible();
    for (const group of [upload, download]) {
      await expect(group.locator('.node-file-mode-status')).toHaveText('检测中');
      await expect(group.getByRole('radio').first()).toBeDisabled();
      await expect(group.getByRole('radio').last()).toBeChecked();
    }
    const button = download.getByRole('button');
    await expect(button).toBeDisabled();
    const disabledColor = await button.evaluate(element => getComputedStyle(element).backgroundColor);
    release();
    await expect(page.getByRole('radio', { name: '直连上传', exact: true })).toBeChecked({ timeout: 25_000 });
    await expect(page.getByRole('radio', { name: '直连下载', exact: true })).toBeChecked();
    for (const group of [upload, download]) {
      await expect(group.locator('.node-file-mode-status')).toHaveText('可用');
      await expect(group.getByRole('radio').first()).toBeEnabled();
    }
    const toolbar = await page.locator('.node-files-toolbar').boundingBox();
    expect(toolbar!.height, 'desktop controls leave room for the file list').toBeLessThanOrEqual(64);
    expect((await upload.getByRole('button').boundingBox())!.height).toBeLessThanOrEqual(34);
    await page.getByRole('checkbox', { name: '选择 操作样式.txt' }).check();
    await expect(button).toBeEnabled();
    await expect(button).toHaveCSS('background-color', 'rgb(37, 99, 235)');
    const colors = await button.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, text: getComputedStyle(element).color }));
    expect(colors.background).toBe('rgb(37, 99, 235)'); expect(colors.background).not.toBe(disabledColor); expect(colors.text).toBe('rgb(255, 255, 255)');
    await page.getByRole('radio', { name: '中转下载', exact: true }).check();
    await expect(page.getByRole('radio', { name: '直连上传', exact: true })).toBeChecked();
    expect(await button.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(colors.background);
    await page.getByRole('radio', { name: '中转下载', exact: true }).focus(); await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('radio', { name: '直连下载', exact: true })).toBeChecked();
    await page.getByRole('radio', { name: '中转上传', exact: true }).check();
    await page.getByRole('radio', { name: '直连上传', exact: true }).check();
    await page.screenshot({ path: '/tmp/controller-center-file-actions-available.png', fullPage: true });
    harness.tools.nodeDisconnected('node');
    await expect(upload.locator('.node-file-mode-status')).toHaveText('不可用');
    await expect(upload).toContainText('连接失败，查看连接诊断');
    await expect(page.getByRole('radio', { name: '直连上传', exact: true })).toBeChecked();
    await expect(page.getByRole('radio', { name: '直连下载', exact: true })).toBeChecked();
    await expect(button).toBeDisabled();
    await expect(button).toHaveCSS('background-color', 'rgb(233, 237, 243)');
    expect(created).toBe(0);
    await page.screenshot({ path: '/tmp/controller-center-file-actions-unavailable.png', fullPage: true });
  } finally { release(); await page.goto('about:blank'); }
});
test('文件操作清楚显示节点不支持和下载可操作状态', async ({ page }) => {
  await installLocalPickers(page);
  await writeFile(path.join(harness.directory, '中转选择.txt'), 'relay');
  await page.goto(`${harness.origin}/nodes/node/files`);
  const upload = page.getByRole('region', { name: '上传操作' });
  const download = page.getByRole('region', { name: '下载操作' });
  await expect(page.getByRole('checkbox', { name: '选择 中转选择.txt' })).toBeVisible();
  for (const group of [upload, download]) {
    await expect(group.locator('.node-file-mode-status')).toHaveText('不可用');
    await expect(group).toContainText('节点尚不支持直连');
    await expect(group.getByRole('radio').first()).toBeDisabled();
    await expect(group.getByRole('radio').last()).toBeChecked();
    await expect(group.locator('.node-file-action-note')).toBeVisible();
  }
  expect((await page.locator('.node-files-toolbar').boundingBox())!.height).toBeLessThanOrEqual(84);
  await expect(download.getByRole('button')).toBeDisabled();
  await expect(download).toContainText('先从下方列表选择文件');
  await page.getByRole('checkbox', { name: '选择 中转选择.txt' }).check();
  await expect(download.getByRole('button')).toBeEnabled();
  await expect(download.getByRole('button')).toHaveCSS('background-color', 'rgb(37, 99, 235)');
  await page.screenshot({ path: '/tmp/controller-center-file-actions-relay.png', fullPage: true });
});
test('直连中断只在用户确认后创建中转新任务', async ({ page }) => {
  await installLocalPickers(page);
  await page.addInitScript(() => {
    const original = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...args) {
      const channel = original.apply(this, args); const send = channel.send.bind(channel); let broken = false;
      channel.send = ((data: string | ArrayBuffer) => { if (!broken && typeof data !== 'string') { broken = true; channel.close(); throw new Error('forced connection loss'); } send(data as string); }) as typeof channel.send;
      return channel;
    };
  });
  const bytes = Buffer.alloc(1024 ** 2 + 9, 0x57); let relayTasks = 0; const ids: string[] = [];
  page.on('request', (request) => { if (request.url().endsWith('/files/uploads') && request.postDataJSON()?.transport === 'relay') relayTasks++; });
  page.on('response', async (response) => { if (response.url().endsWith('/files/uploads') && response.ok()) ids.push((await response.json() as { task: { id: string } }).task.id); });
  await page.goto(`${harness.origin}/nodes/node/files`); await expect(page.getByRole('radio', { name: '直连上传', exact: true })).toBeChecked({ timeout: 25_000 });
  await page.locator('input[type=file]').setInputFiles({ name: '确认中转.bin', mimeType: 'application/octet-stream', buffer: bytes });
  await expect(page.getByRole('button', { name: '改用中转', exact: true })).toBeVisible({ timeout: 30_000 }); expect(relayTasks).toBe(0);
  await page.getByRole('button', { name: '改用中转', exact: true }).click(); await expect(page.getByRole('dialog', { name: '确认改用中转' })).toBeVisible(); expect(relayTasks).toBe(0);
  await page.getByRole('button', { name: '确认改用中转', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已上传到节点' })).toBeVisible({ timeout: 30_000 });
  expect(relayTasks).toBe(1); expect(new Set(ids).size).toBe(2); expect(await readFile(path.join(harness.directory, '确认中转.bin'))).toEqual(bytes);
});
test('直连上传闪断从确认位置继续同一任务', async ({ page }) => {
  await installLocalPickers(page);
  await page.addInitScript(() => {
    const create = RTCPeerConnection.prototype.createDataChannel; let broken = false;
    RTCPeerConnection.prototype.createDataChannel = function (...args) {
      const channel = create.apply(this, args); const send = channel.send.bind(channel);
      channel.send = ((data: string | ArrayBuffer) => { if (!broken && typeof data === 'string') { const message = JSON.parse(data) as { kind?: string; offset?: number }; if (message.kind === 'chunk' && message.offset === 1024 ** 2) { broken = true; channel.close(); throw new Error('one interrupted channel'); } } send(data as string); }) as typeof channel.send;
      return channel;
    };
  });
  const bytes = Buffer.alloc(2 * 1024 ** 2 + 19, 0x36); let tasks = 0; let resumes = 0;
  page.on('request', (request) => { if (request.url().endsWith('/files/uploads')) tasks++; if (request.url().endsWith('/resume')) resumes++; });
  await page.goto(`${harness.origin}/nodes/node/files`); await expect(page.getByRole('radio', { name: '直连上传', exact: true })).toBeChecked({ timeout: 25_000 });
  await page.locator('input[type=file]').setInputFiles({ name: '同任务续传.bin', mimeType: 'application/octet-stream', buffer: bytes });
  await expect(page.getByRole('status').filter({ hasText: '已上传到节点' })).toBeVisible({ timeout: 25_000 });
  expect(tasks).toBe(1); expect(resumes).toBe(1); expect(await readFile(path.join(harness.directory, '同任务续传.bin'))).toEqual(bytes);
});
test('直连下载确认丢失后重连不重复写入', async ({ page }) => {
  await installLocalPickers(page);
  await page.addInitScript(() => {
    const create = RTCPeerConnection.prototype.createDataChannel; let broken = false;
    RTCPeerConnection.prototype.createDataChannel = function (...args) {
      const channel = create.apply(this, args); const send = channel.send.bind(channel);
      channel.send = ((data: string | ArrayBuffer) => { if (!broken && typeof data === 'string') { const message = JSON.parse(data) as { reply?: string; offset?: number }; if (message.reply && message.offset === 1024 ** 2) { broken = true; channel.close(); throw new Error('lost receiver acknowledgement'); } } send(data as string); }) as typeof channel.send;
      return channel;
    };
  });
  const bytes = Buffer.alloc(2 * 1024 ** 2 + 19, 0x4f); await writeFile(path.join(harness.directory, '接收续传.bin'), bytes); let tasks = 0; let resumes = 0;
  page.on('request', (request) => { if (request.url().endsWith('/files/downloads')) tasks++; if (request.url().endsWith('/resume')) resumes++; });
  await page.goto(`${harness.origin}/nodes/node/files`); await expect(page.getByRole('radio', { name: '直连下载', exact: true })).toBeChecked({ timeout: 25_000 });
  await page.getByRole('checkbox', { name: '选择 接收续传.bin' }).check(); await page.getByRole('button', { name: '下载所选文件（1）' }).click();
  await expect(page.getByRole('status').filter({ hasText: '已保存到电脑' })).toBeVisible({ timeout: 25_000 });
  expect(tasks).toBe(1); expect(resumes).toBe(1);
  expect(await page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('接收续传.bin')).getFile()).size)).toBe(bytes.length);
});
test('直连保存提交失败保留原文件且不提供中转替代业务错误', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { showSaveFilePicker: () => Promise<unknown> }).showSaveFilePicker = async () => {
      const handle = await (await navigator.storage.getDirectory()).getFileHandle('保留.txt', { create: true }); const initial = await handle.createWritable(); await initial.write('original'); await initial.close();
      return { getFile: () => handle.getFile(), createWritable: async () => { const stream = await handle.createWritable(); return { write: (bytes: Uint8Array<ArrayBuffer>) => stream.write(bytes), abort: () => stream.abort(), close: async () => { throw new DOMException('disk full', 'QuotaExceededError'); } }; } };
    };
  });
  await writeFile(path.join(harness.directory, '保留.txt'), 'new value');
  await page.goto(`${harness.origin}/nodes/node/files`); await expect(page.getByRole('radio', { name: '直连下载', exact: true })).toBeChecked({ timeout: 25_000 });
  await page.getByRole('checkbox', { name: '选择 保留.txt' }).check(); await page.getByRole('button', { name: '下载所选文件（1）' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'disk full' })).toBeVisible();
  expect(await page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('保留.txt')).getFile()).text())).toBe('original');
  await expect(page.getByRole('button', { name: '改用中转', exact: true })).toHaveCount(0);
});
test('直连批量下载一次选择目录并确认本地覆盖', async ({ page }) => {
  await installLocalPickers(page);
  await writeFile(path.join(harness.directory, '批量一.txt'), 'first'); await writeFile(path.join(harness.directory, '批量二.txt'), 'second');
  await page.goto(`${harness.origin}/nodes/node/files`); await expect(page.getByRole('radio', { name: '直连下载', exact: true })).toBeChecked({ timeout: 25_000 });
  await page.evaluate(async () => { const handle = await (await navigator.storage.getDirectory()).getFileHandle('批量一.txt', { create: true }); const stream = await handle.createWritable(); await stream.write('old'); await stream.close(); });
  await page.getByRole('checkbox', { name: '选择 批量一.txt' }).check(); await page.getByRole('checkbox', { name: '选择 批量二.txt' }).check(); await page.getByRole('button', { name: '下载所选文件（2）' }).click();
  await expect(page.getByRole('dialog', { name: '确认本地整批覆盖' })).toBeVisible(); await expect(page.locator('.node-transfer-card')).toHaveCount(0);
  await page.getByRole('button', { name: '确认覆盖并下载整批' }).click(); await expect(page.getByRole('status').filter({ hasText: '已保存到电脑' })).toHaveCount(2);
  expect(await page.evaluate(async () => { const directory = await navigator.storage.getDirectory(); return await Promise.all(['批量一.txt', '批量二.txt'].map(async (name) => (await (await directory.getFileHandle(name)).getFile()).text())); })).toEqual(['first', 'second']);
});
test('直连下载确认中转后复用保存位置并在网页完成保存', async ({ page }) => {
  test.setTimeout(60_000); await installLocalPickers(page);
  await page.addInitScript(() => {
    const state = window as unknown as { showSaveFilePicker: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>; pickerCalls: number };
    const pick = state.showSaveFilePicker; state.pickerCalls = 0; state.showSaveFilePicker = async (options) => { state.pickerCalls++; return pick(options); };
    const create = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...args) {
      const channel = create.apply(this, args); const send = channel.send.bind(channel);
      channel.send = ((data: string | ArrayBuffer) => { if (typeof data === 'string') { const message = JSON.parse(data) as { reply?: string; offset?: number }; if (message.reply && message.offset === 1024 ** 2) { channel.close(); throw new Error('repeated acknowledgement loss'); } } send(data as string); }) as typeof channel.send;
      return channel;
    };
  });
  const bytes = Buffer.alloc(1024 ** 2 + 27, 0x39); await writeFile(path.join(harness.directory, '复用位置.bin'), bytes); let relay = 0;
  page.on('request', (request) => { if (request.url().endsWith('/files/downloads') && request.postDataJSON()?.transport === 'relay') relay++; });
  await page.goto(`${harness.origin}/nodes/node/files`); await expect(page.getByRole('radio', { name: '直连下载', exact: true })).toBeChecked({ timeout: 25_000 });
  await page.getByRole('checkbox', { name: '选择 复用位置.bin' }).check(); await page.getByRole('button', { name: '下载所选文件（1）' }).click();
  await expect(page.getByRole('button', { name: '改用中转', exact: true })).toBeVisible({ timeout: 30_000 }); expect(relay).toBe(0);
  await page.getByRole('button', { name: '改用中转', exact: true }).click(); await page.getByRole('button', { name: '确认改用中转', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已保存到电脑' })).toBeVisible({ timeout: 25_000 }); expect(relay).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { pickerCalls: number }).pickerCalls)).toBe(1);
  const saved = await page.evaluate(async () => { const file = await (await (await navigator.storage.getDirectory()).getFileHandle('复用位置.bin')).getFile(); return Array.from(new Uint8Array(await file.arrayBuffer())); });
  expect(Buffer.from(saved)).toEqual(bytes);
});
test('直连 1 GiB 下载保存并完整上传的哈希与内存检查', async ({ playwright }) => {
  test.skip(process.env.NODE_TOOLS_DIRECT_LARGE_TEST !== '1', 'Explicit large file verification'); test.setTimeout(360_000);
  // Chromium's incognito OPFS stores file contents in memory. A regular profile
  // exercises disk-backed storage, so browser RSS measures the transport itself.
  const profile = await mkdtemp(path.join(os.tmpdir(), 'cc-direct-browser-'));
  const context = await playwright.chromium.launchPersistentContext(profile, { viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  await context.addCookies([{ name: 'test-session', value: 'one', url: harness.origin }]); const page = context.pages()[0]!;
  await installLocalPickers(page); const size = 1024 ** 3; const source = await open(path.join(harness.directory, 'limit.bin'), 'wx'); await source.truncate(size); await source.close();
  const browserPid = Number(execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).split('\n').find((line) => line.includes(`--user-data-dir=${profile}`))?.trim().split(/\s+/)[0]);
  const browserRss = () => {
    const processes = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
    const tree = new Set([browserPid]); for (let changed = true; changed;) { changed = false; for (const [pid, parent] of processes) if (tree.has(parent!) && !tree.has(pid!)) { tree.add(pid!); changed = true; } }
    return processes.reduce((total, [pid, , rss]) => total + (tree.has(pid!) ? rss! * 1024 : 0), 0);
  };
  let sample: ReturnType<typeof setInterval> | undefined;
  const { createHash } = await import('node:crypto'); const hash = createHash('sha256'); const chunk = Buffer.alloc(1024 ** 2); for (let i = 0; i < 1024; i++) hash.update(chunk); const expected = hash.digest('hex');
  try {
    await page.goto(`${harness.origin}/nodes/node/files`); await expect(page.getByRole('radio', { name: '直连下载', exact: true })).toBeChecked({ timeout: 25_000 });
    expect(browserPid).toBeGreaterThan(0); const baseline = process.memoryUsage().rss; let peak = baseline; const browserBaseline = browserRss(); let browserPeak = browserBaseline;
    sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); browserPeak = Math.max(browserPeak, browserRss()); }, 250);
    await page.getByRole('checkbox', { name: '选择 limit.bin' }).check(); await page.getByRole('button', { name: '下载所选文件（1）' }).click();
    await expect(page.getByRole('status').filter({ hasText: '已保存到电脑' })).toBeVisible({ timeout: 180_000 });
    expect(await page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('limit.bin')).getFile()).size)).toBe(size);
    await page.evaluate(async () => { const file = await (await (await navigator.storage.getDirectory()).getFileHandle('limit.bin')).getFile(); const selected = new DataTransfer(); selected.items.add(new File([file], 'limit-upload.bin')); const input = document.querySelector<HTMLInputElement>('input[type=file]')!; input.files = selected.files; input.dispatchEvent(new Event('change', { bubbles: true })); });
    await expect(page.getByRole('status').filter({ hasText: '已上传到节点' })).toBeVisible({ timeout: 180_000 });
    const uploaded = await open(path.join(harness.directory, 'limit-upload.bin'), 'r');
    try { expect(await (await import('@controller-center/node-files')).hashFile(uploaded, size, AbortSignal.timeout(30_000))).toBe(expected); } finally { await uploaded.close(); }
    expect(peak - baseline).toBeLessThan(256 * 1024 ** 2);
    expect(browserPeak - browserBaseline).toBeLessThan(256 * 1024 ** 2);
    console.log(`Direct 1 GiB download/upload SHA-256 ${expected}; Node RSS increase ${Math.round((peak - baseline) / 1024 ** 2)} MiB; Chromium process tree RSS increase ${Math.round((browserPeak - browserBaseline) / 1024 ** 2)} MiB`);
    expect(await readdir(path.join(harness.directory, 'stage'))).toEqual([]);
    await page.screenshot({ path: '/tmp/controller-center-direct-files.png' });
  } finally { clearInterval(sample); await context.close(); await rm(profile, { recursive: true, force: true }); }
});
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
  await page.getByRole('button', { name: '清理已结束' }).click();
  await expect(page.locator('.node-transfer-card')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '再次下载' })).toBeVisible();
  await page.getByRole('button', { name: '返回控制中心', exact: true }).click();
  const leave = page.getByRole('dialog', { name: '离开文件管理？' });
  await expect(leave).toContainText('浏览器下载列表');
  await leave.getByRole('button', { name: '继续传输' }).click();
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
  await expect(input).toBeFocused();
  await expect(page.locator('.node-terminal-toast')).toHaveCount(0);
  await page.keyboard.insertText("printf '%s\\n' FULLSCREEN_CTRL_W_OK UNEXPECTED_WORD");
  await page.keyboard.press('Control+w'); await page.keyboard.press('Enter');
  await expect.poll(() => harness.events.filter(event => event.action === 'terminal.output').map(event => event.data).join('')).toContain('FULLSCREEN_CTRL_W_OK\r\n');
  expect(harness.events.filter(event => event.action === 'terminal.output').map(event => event.data).join('')).not.toContain('UNEXPECTED_WORD\r\n');
  expect(page.isClosed()).toBe(false);
  await page.keyboard.insertText('vim -u NONE -n /tmp/cc-vim-smoke.txt'); await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('cc-vim-smoke.txt');
  await page.keyboard.press('i'); await page.keyboard.insertText('VIM_SCREEN_OK');
  await expect(page.locator('.xterm-rows')).toContainText('VIM_SCREEN_OK');
  await page.screenshot({ path: 'test-results/node-tools-vim.png' });
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.keyboard.insertText(':q!'); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(input).toBeFocused();
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
test('关闭运行中终端需要确认且取消后保留连接', async ({ page }) => {
  await page.goto(`${harness.origin}/nodes/node/terminal`);
  await expect(page.getByRole('status')).toHaveText('已连接');
  const input = page.locator('.xterm-helper-textarea');
  await page.getByLabel('终端信息').click();
  await expect(page.locator('.node-tool-info-popover')).toBeVisible();
  await page.getByLabel('终端信息').click(); await input.focus();
  expect(await page.evaluate(() => navigator.userActivation.hasBeenActive)).toBe(true);
  const opened = harness.events.filter(event => event.action === 'terminal.opened').map(event => event.id);
  const pending = page.waitForEvent('dialog');
  await page.close({ runBeforeUnload: true });
  const dialog = await pending; expect(dialog.type()).toBe('beforeunload'); await dialog.dismiss();
  expect(page.isClosed()).toBe(false);
  await expect(page.getByRole('status')).toHaveText('已连接');
  await input.focus(); await page.keyboard.insertText('printf "CLOSE_CANCELLED_INPUT_OK\\n"'); await page.keyboard.press('Enter');
  await expect.poll(() => harness.events.filter(event => event.action === 'terminal.output').map(event => event.data).join('')).toContain('CLOSE_CANCELLED_INPUT_OK\r\n');
  expect(harness.events.filter(event => event.action === 'terminal.opened').map(event => event.id)).toEqual(opened);
  const confirmed = page.waitForEvent('dialog'); const closed = page.waitForEvent('close');
  await page.close({ runBeforeUnload: true });
  const confirmation = await confirmed; expect(confirmation.type()).toBe('beforeunload'); await confirmation.accept();
  await closed;
});
for (const mode of ['button', 'shell'] as const) {
  test(`终端结束后关闭标签页不再确认（${mode}）`, async ({ page }) => {
    await page.goto(`${harness.origin}/nodes/node/terminal`);
    await expect(page.getByRole('status')).toHaveText('已连接');
    const input = page.locator('.xterm-helper-textarea'); await page.locator('.node-terminal').click();
    const dialogs: string[] = [];
    page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
    if (mode === 'button') await page.getByRole('button', { name: '关闭终端', exact: true }).click();
    else { await page.keyboard.insertText('exit'); await page.keyboard.press('Enter'); }
    await expect(input).toHaveJSProperty('readOnly', true);
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => page.isClosed()).toBe(true);
    expect(dialogs).toEqual([]);
  });
}
test('终端拖选结束自动复制且清空选区与只读输出保持可用', async ({ context, page }) => {
  await page.addInitScript(() => {
    const state = window as unknown as { terminalUnlocks: number; terminalClipboardWrites: string[] };
    state.terminalUnlocks = 0; state.terminalClipboardWrites = [];
    const keyboard = (navigator as Navigator & { keyboard: { unlock(): void } }).keyboard;
    const unlock = keyboard.unlock.bind(keyboard);
    keyboard.unlock = () => { state.terminalUnlocks++; unlock(); };
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = text => { state.terminalClipboardWrites.push(text); return write(text); };
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: harness.origin });
  await page.goto(`${harness.origin}/nodes/node/terminal`);
  await expect(page.getByRole('status')).toHaveText('已连接');
  const input = page.locator('.xterm-helper-textarea');
  const marker = 'TERMINAL_SELECTION_COPY_OK';
  await page.keyboard.insertText(`printf '%s\\n' ${marker}`); await page.keyboard.press('Enter');
  const text = page.locator('.xterm-rows').getByText(marker, { exact: true }).last();
  await expect(text).toBeVisible();
  await page.evaluate(() => navigator.clipboard.writeText('CLIPBOARD_SENTINEL'));
  const bounds = (await text.boundingBox())!;
  const terminalBounds = await page.locator('.node-terminal').boundingBox();
  await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2); await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 8 });
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('CLIPBOARD_SENTINEL');
  expect(await page.evaluate(() => (window as unknown as { terminalClipboardWrites: string[] }).terminalClipboardWrites)).toEqual(['CLIPBOARD_SENTINEL']);
  await expect(page.locator('.node-terminal-copy-toast')).toHaveCount(0);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(marker);
  expect(await page.evaluate(() => (window as unknown as { terminalClipboardWrites: string[] }).terminalClipboardWrites)).toEqual(['CLIPBOARD_SENTINEL', marker]);
  const notice = page.locator('.node-terminal-copy-toast');
  await expect(notice).toHaveText('复制成功');
  await expect(notice).toHaveAttribute('data-state', 'success');
  expect(await page.locator('.node-terminal').boundingBox()).toEqual(terminalBounds);
  await expect(input).toBeFocused();
  await expect(notice).toBeHidden({ timeout: 4000 });
  await page.mouse.click(bounds.x + 1, bounds.y + bounds.height / 2);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(marker);
  await page.keyboard.insertText('printf "AFTER_AUTO_COPY_OK\\n"'); await page.keyboard.press('Enter');
  await expect.poll(() => harness.events.filter(event => event.action === 'terminal.output').map(event => event.data).join('')).toContain('AFTER_AUTO_COPY_OK\r\n');
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  const unlocks = await page.evaluate(() => (window as unknown as { terminalUnlocks: number }).terminalUnlocks);
  await page.getByRole('button', { name: '关闭终端', exact: true }).click();
  await expect(input).toHaveJSProperty('readOnly', true);
  await expect.poll(() => page.evaluate(() => (window as unknown as { terminalUnlocks: number }).terminalUnlocks)).toBeGreaterThan(unlocks);
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await page.evaluate(() => navigator.clipboard.writeText('READONLY_SENTINEL'));
  const readOnlyBounds = (await text.boundingBox())!;
  await page.mouse.dblclick(readOnlyBounds.x + readOnlyBounds.width / 2, readOnlyBounds.y + readOnlyBounds.height / 2);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(marker);
  await expect(notice).toHaveText('复制成功');
  await expect(page.locator('.node-tool-connection')).toHaveText('终端已关闭');
});
test('键盘锁定和自动复制失败不影响全屏与终端输入', async ({ page }) => {
  await page.addInitScript(() => {
    const keyboard = (navigator as Navigator & { keyboard: { lock(keys: string[]): Promise<void> } }).keyboard;
    keyboard.lock = async () => { throw new DOMException('denied', 'NotAllowedError'); };
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new DOMException('denied', 'NotAllowedError'); } } });
  });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${harness.origin}/nodes/node/terminal`);
  await expect(page.getByRole('status')).toHaveText('已连接');
  const input = page.locator('.xterm-helper-textarea');
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await expect(page.getByRole('alert')).toHaveText('键盘锁定失败，Esc 仍会退出全屏');
  await expect(input).toBeFocused();
  await page.keyboard.insertText('printf "COPY_DENIED_OK\\n"'); await page.keyboard.press('Enter');
  const text = page.locator('.xterm-rows').getByText('COPY_DENIED_OK', { exact: true }).last();
  await expect(text).toBeVisible();
  const bounds = (await text.boundingBox())!;
  await page.mouse.dblclick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect(page.locator('.node-terminal-copy-toast')).toContainText('复制失败：浏览器未允许写入剪贴板，请检查网站的剪贴板权限');
  await expect(page.getByRole('alert').filter({ hasText: '键盘锁定失败' })).toBeVisible();
  await expect(input).toBeFocused();
  await page.keyboard.insertText('printf "INPUT_STILL_OK\\n"'); await page.keyboard.press('Enter');
  await expect.poll(() => harness.events.filter(event => event.action === 'terminal.output').map(event => event.data).join('')).toContain('INPUT_STILL_OK\r\n');
  await expect(page.getByRole('status')).toHaveText('已连接'); expect(errors).toEqual([]);
});
test('复制失败展示具体原因且后续成功可以替换错误提示', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: harness.origin });
  await page.addInitScript(() => {
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    let attempts = 0;
    navigator.clipboard.writeText = async text => {
      if (++attempts === 1) throw new Error('系统剪贴板暂时不可用');
      await write(text);
    };
  });
  await page.goto(`${harness.origin}/nodes/node/terminal`);
  await expect(page.getByRole('status')).toHaveText('已连接');
  const input = page.locator('.xterm-helper-textarea');
  const notice = page.locator('.node-terminal-copy-toast');
  for (const marker of ['FIRST_COPY_FAILED', 'SECOND_COPY_OK']) {
    await page.keyboard.insertText(`printf '%s\\n' ${marker}`); await page.keyboard.press('Enter');
    const text = page.locator('.xterm-rows').getByText(marker, { exact: true }).last(); await expect(text).toBeVisible();
    const bounds = (await text.boundingBox())!;
    await page.mouse.dblclick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    if (marker === 'FIRST_COPY_FAILED') {
      await expect(notice).toContainText('复制失败：系统剪贴板暂时不可用');
      await expect(notice).toHaveAttribute('data-state', 'error');
    } else {
      await expect(notice).toHaveText('复制成功');
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(marker);
    }
    await expect(input).toBeFocused();
  }
});
test('旧键盘锁定请求迟到不会影响后来进入的全屏或工具栏焦点', async ({ page }) => {
  await page.addInitScript(() => {
    const keyboard = (navigator as Navigator & { keyboard: { lock(keys: string[]): Promise<void> } }).keyboard;
    const lock = keyboard.lock.bind(keyboard);
    const state = { calls: 0, locked: false, reject: null as (() => void) | null };
    (window as unknown as { pendingKeyboardLock: typeof state }).pendingKeyboardLock = state;
    keyboard.lock = keys => {
      if (++state.calls === 1) return new Promise<void>((_resolve, reject) => {
        state.reject = () => reject(new DOMException('cancelled old request', 'AbortError'));
      });
      return lock(keys).then(() => { state.locked = true; });
    };
  });
  await page.goto(`${harness.origin}/nodes/node/terminal`);
  await expect(page.getByRole('status')).toHaveText('已连接');
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { pendingKeyboardLock: { locked: boolean } }).pendingKeyboardLock.locked)).toBe(true);
  const info = page.getByLabel('终端信息'); await info.focus();
  await page.evaluate(() => (window as unknown as { pendingKeyboardLock: { reject: () => void } }).pendingKeyboardLock.reject());
  await expect(info).toBeFocused();
  await expect(page.locator('.node-terminal-toast')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
});
test('全屏请求失败释放键盘锁定并恢复终端输入', async ({ page }) => {
  await page.addInitScript(() => {
    const state = { locked: false }; (window as unknown as { rejectedFullscreen: typeof state }).rejectedFullscreen = state;
    Object.defineProperty(navigator, 'keyboard', { value: {
      lock: async () => { state.locked = true; }, unlock: () => { state.locked = false; },
    } });
    HTMLElement.prototype.requestFullscreen = async () => { throw new DOMException('denied', 'NotAllowedError'); };
  });
  await page.goto(`${harness.origin}/nodes/node/terminal`);
  await expect(page.getByRole('status')).toHaveText('已连接');
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('无法进入全屏，请检查浏览器权限');
  expect(await page.evaluate(() => (window as unknown as { rejectedFullscreen: { locked: boolean } }).rejectedFullscreen.locked)).toBe(false);
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  await page.keyboard.insertText('printf "FULLSCREEN_FAILURE_INPUT_OK\\n"'); await page.keyboard.press('Enter');
  await expect.poll(() => harness.events.filter(event => event.action === 'terminal.output').map(event => event.data).join('')).toContain('FULLSCREEN_FAILURE_INPUT_OK\r\n');
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

test('文件管理支持点击选择、全选当前列表和取消选择', async ({ page }) => {
  await writeFile(path.join(harness.directory, '选择一.txt'), 'first');
  await writeFile(path.join(harness.directory, '选择二.txt'), 'second');
  await page.goto(`${harness.origin}/nodes/node/files`);
  await expect(page.locator('tbody tr').first().locator('.node-file-type')).toHaveText('目录');
  const first = page.getByRole('checkbox', { name: '选择 选择一.txt', exact: true });
  await page.getByRole('button', { name: '选择一.txt', exact: true }).click();
  await expect(first).toBeChecked();
  await expect(page.getByRole('button', { name: '下载所选文件（1）', exact: true })).toBeEnabled();
  await page.getByRole('checkbox', { name: '全选当前目录文件' }).check();
  const files = page.locator('tbody input[type=checkbox]');
  const count = await files.count();
  expect(count).toBeGreaterThanOrEqual(2);
  await expect(page.locator('tbody input:checked')).toHaveCount(count);
  await page.getByRole('button', { name: '取消选择', exact: true }).click();
  await expect(page.locator('tbody input:checked')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '下载所选文件（0）', exact: true })).toBeDisabled();
});

test('刷新目录保留已加载分页中的文件选择', async ({ page }) => {
  await Promise.all(Array.from({ length: 230 }, (_, index) => writeFile(path.join(harness.directory, `分页文件-${String(index).padStart(3, '0')}.txt`), 'pagination')));
  await page.goto(`${harness.origin}/nodes/node/files`);
  await expect(page.getByRole('button', { name: '加载更多' })).toBeVisible();
  const initial = await page.locator('tbody input[type=checkbox]').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
  await page.getByRole('button', { name: '加载更多' }).click();
  await expect(page.getByRole('button', { name: '加载更多' })).toHaveCount(0);
  const loaded = await page.locator('tbody input[type=checkbox]').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
  const label = loaded.find(name => name?.startsWith('选择 分页文件-') && !initial.includes(name));
  expect(label).toBeTruthy();
  const checkbox = page.getByRole('checkbox', { name: label!, exact: true });
  await checkbox.check();
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.locator('.node-files-list')).toHaveAttribute('aria-busy', 'false');
  await expect(checkbox).toBeChecked();
  await expect(page.locator('tbody input[type=checkbox]')).toHaveCount(loaded.length);
});

test('有传输时返回控制中心先确认且可继续传输', async ({ page }) => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/node-tools/tasks/*/chunks/*', async route => { await hold; await route.continue(); });
  try {
    await page.goto(`${harness.origin}/nodes/node/files`);
    await expect(page.getByRole('button', { name: '上传文件', exact: true })).toBeEnabled();
    await page.locator('input[type=file]').setInputFiles({ name: '保持传输.txt', mimeType: 'text/plain', buffer: Buffer.from('keep transferring') });
    await expect(page.locator('.node-transfer-card')).toHaveCount(1);
    await page.getByRole('button', { name: '返回控制中心', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '离开文件管理？' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: '继续传输' })).toBeFocused();
    await dialog.getByRole('button', { name: '继续传输' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(`${harness.origin}/nodes/node/files`);
    release();
    await expect(page.getByRole('status').filter({ hasText: '已上传到节点' })).toBeVisible();
    expect(await readFile(path.join(harness.directory, '保持传输.txt'), 'utf8')).toBe('keep transferring');
    await page.getByRole('button', { name: '返回控制中心', exact: true }).click();
    await expect(page).toHaveURL(harness.origin + '/');
  } finally { release(); await page.goto('about:blank'); }
});

test('文件上传完成自动刷新列表并保留选择和未提交的路径', async ({ page }) => {
  await writeFile(path.join(harness.directory, '保留选择.txt'), 'existing');
  await page.goto(`${harness.origin}/nodes/node/files`);
  const existing = page.getByRole('checkbox', { name: '选择 保留选择.txt' });
  await existing.check();
  await page.getByLabel('节点目录路径').fill('/尚未打开的目录');
  await page.locator('input[type=file]').setInputFiles({ name: '自动刷新.txt', mimeType: 'text/plain', buffer: Buffer.from('automatic refresh') });
  await expect(page.getByRole('status').filter({ hasText: '已上传到节点' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '选择 自动刷新.txt' })).toBeVisible();
  await expect(existing).toBeChecked();
  await expect(page.getByLabel('节点目录路径')).toHaveValue('/尚未打开的目录');
  expect(await readFile(path.join(harness.directory, '自动刷新.txt'), 'utf8')).toBe('automatic refresh');
  await page.screenshot({ path: '/tmp/controller-center-files-ui-after.png', fullPage: true });
});

test('清理传输记录保留正在进行的任务', async ({ page }) => {
  await page.goto(`${harness.origin}/nodes/node/files`);
  await expect(page.getByRole('button', { name: '上传文件', exact: true })).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles({ name: '已完成.txt', mimeType: 'text/plain', buffer: Buffer.from('complete') });
  await expect(page.getByRole('status').filter({ hasText: '已上传到节点' })).toBeVisible();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/node-tools/tasks/*/chunks/*', async route => { await hold; await route.continue(); });
  try {
    await page.locator('input[type=file]').setInputFiles({ name: '传输中.txt', mimeType: 'text/plain', buffer: Buffer.from('active') });
    await expect(page.locator('.node-transfer-card')).toHaveCount(2);
    await page.getByRole('button', { name: '清理已结束' }).click();
    await expect(page.locator('.node-transfer-card')).toHaveCount(1);
    await expect(page.locator('.node-transfer-card').getByText('传输中.txt', { exact: true })).toBeVisible();
    await expect(page.locator('.node-transfer-card').getByRole('button', { name: '取消', exact: true })).toBeVisible();
    release();
    await expect(page.getByRole('status').filter({ hasText: '已上传到节点' })).toBeVisible();
    expect(await readFile(path.join(harness.directory, '传输中.txt'), 'utf8')).toBe('active');
  } finally { release(); await page.goto('about:blank'); }
});

test('文件覆盖确认支持 Escape 和键盘焦点且不会提前传输', async ({ page }) => {
  await writeFile(path.join(harness.directory, '需要确认.txt'), 'original');
  await page.goto(`${harness.origin}/nodes/node/files`);
  await expect(page.getByRole('button', { name: '上传文件', exact: true })).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles({ name: '需要确认.txt', mimeType: 'text/plain', buffer: Buffer.from('replacement') });
  const dialog = page.getByRole('dialog', { name: '确认整批覆盖' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '取消整批' })).toBeFocused();
  await page.screenshot({ path: '/tmp/controller-center-file-confirm-after.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.node-transfer-card')).toHaveCount(0);
  expect(await readFile(path.join(harness.directory, '需要确认.txt'), 'utf8')).toBe('original');
});

test('文件管理在手机宽度下保留操作且没有水平溢出', async ({ page }) => {
  await writeFile(path.join(harness.directory, '很长的文件名用于验证手机显示不会挤出页面.txt'), 'mobile');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${harness.origin}/nodes/node/files`);
    await expect(page.getByRole('checkbox', { name: '选择 很长的文件名用于验证手机显示不会挤出页面.txt' })).toBeVisible();
    await expect(page.getByLabel('上传方式')).toBeVisible();
    await expect(page.getByLabel('下载方式')).toBeVisible();
    await page.getByRole('checkbox', { name: '选择 很长的文件名用于验证手机显示不会挤出页面.txt' }).check();
    await expect(page.getByRole('button', { name: '下载所选文件（1）' })).toBeEnabled();
    expect((await page.locator('.node-files-toolbar').boundingBox())!.height).toBeLessThanOrEqual(180);
    expect(await page.locator('.node-files-list').evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(160);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    const bounds = await page.locator('.node-file-browser').boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  }
  await page.screenshot({ path: '/tmp/controller-center-files-mobile-after.png', fullPage: true });
});
