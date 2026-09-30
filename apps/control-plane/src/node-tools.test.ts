import { writeFile, readFile, readdir, stat, chmod, symlink, open } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NODE_FILE_MAX_BYTES, type NodeFileTaskView } from '@controller-center/protocol';
import { sha256, hashFile } from '@controller-center/node-files';
import { nodeToolsHarness } from '../../../tests/node-tools-harness.js';
let harness: Awaited<ReturnType<typeof nodeToolsHarness>> | null = null;
afterEach(async () => { await harness?.close(); harness = null; });
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function task(id: string, pageId: string): Promise<NodeFileTaskView> { return (await (await harness!.request(`/api/node-tools/tasks/${id}`, {}, pageId)).json() as { task: NodeFileTaskView }).task; }
async function uploadPlan(pageId: string, name: string, size: number) {
  const response = await harness!.request('/api/node-tools/files/preflight', json({ directory: harness!.directory, files: [{ name, size }] }), pageId);
  expect(response.status).toBe(200); return await response.json() as { planId: string; targets: Array<{ existing: unknown }> };
}
async function createUpload(pageId: string, planId: string, overwrite = false) {
  const response = await harness!.request('/api/node-tools/files/uploads', json({ planId, index: 0, overwrite }), pageId);
  expect(response.status).toBe(200); return (await response.json() as { task: NodeFileTaskView }).task;
}
async function put(id: string, pageId: string, offset: number, body: Buffer) {
  return harness!.request(`/api/node-tools/tasks/${id}/chunks/${offset}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': sha256(body) }, body }, pageId);
}
describe('node tools real transport', () => {
  it('uploads with duplicate ACK retries, validates content and preserves mode on confirmed overwrite', async () => {
    harness = await nodeToolsHarness(); const page = await harness.page();
    const name = '中文 空格.txt'; const destination = path.join(harness.directory, name);
    await writeFile(destination, 'old'); await chmod(destination, 0o640);
    const content = Buffer.from('新的内容\n'.repeat(2000));
    const plan = await uploadPlan(page.id, name, content.length);
    expect(plan.targets[0]?.existing).not.toBeNull();
    expect((await harness.request('/api/node-tools/files/uploads', json({ planId: plan.planId, index: 0, overwrite: false }), page.id)).status).toBe(409);
    const created = await createUpload(page.id, plan.planId, true);
    const first = content.subarray(0, 1000), second = content.subarray(1000);
    expect((await put(created.id, page.id, 0, first)).status).toBe(200);
    expect((await put(created.id, page.id, 0, first)).status).toBe(200);
    expect((await task(created.id, page.id)).offset).toBe(1000);
    expect((await put(created.id, page.id, 1000, second)).status).toBe(200);
    expect((await harness.request(`/api/node-tools/tasks/${created.id}/finalize`, json({ sha256: sha256(content) }), page.id)).status).toBe(200);
    await expect.poll(async () => (await task(created.id, page.id)).status).toBe('completed');
    expect(await readFile(destination)).toEqual(content);
    expect((await stat(destination)).mode & 0o777).toBe(0o640);
    await expect.poll(async () => (await readdir(path.join(harness!.directory, 'stage'))).length).toBe(0);
    expect((await harness.request(`/api/node-tools/tasks/${created.id}/finalize`, json({ sha256: sha256(content) }), page.id)).status).toBe(200);
  });
  it('downloads source snapshots with HTTP ranges, suffixes, If-Range and 416', async () => {
    harness = await nodeToolsHarness(); const page = await harness.page(); const content = Buffer.from('0123456789 中文');
    const source = path.join(harness.directory, '源文件.txt'); await writeFile(source, content);
    const response = await harness.request('/api/node-tools/files/downloads', json({ path: source, requestId: randomUUID() }), page.id);
    const created = (await response.json() as { task: NodeFileTaskView }).task;
    await expect.poll(async () => (await task(created.id, page.id)).status).toBe('ready');
    const endpoint = `/api/node-tools/tasks/${created.id}/content`;
    const range = await harness.request(endpoint, { headers: { Range: 'bytes=2-5' } });
    expect(range.status).toBe(206); expect(range.headers.get('content-range')).toBe(`bytes 2-5/${content.length}`); expect(await range.text()).toBe('2345');
    const full = await harness.request(endpoint, { headers: { Range: 'bytes=2-5', 'If-Range': '"different"' } });
    expect(full.status).toBe(200); expect(Buffer.from(await full.arrayBuffer())).toEqual(content);
    const suffix = await harness.request(endpoint, { headers: { Range: 'bytes=-3' } }); expect(Buffer.from(await suffix.arrayBuffer())).toEqual(content.subarray(-3));
    expect((await harness.request(endpoint, { headers: { Range: `bytes=${content.length}-` } })).status).toBe(416);
    const other = await fetch(`${harness.origin}${endpoint}`, { headers: { Cookie: 'test-session=two' } }); expect(other.status).toBe(410);
    const unauthenticated = await fetch(`${harness.origin}${endpoint}`); expect(unauthenticated.status).toBe(401);
  });
  it('refuses changed targets, oversized sources and final symlinks and cleans cancelled tasks', async () => {
    harness = await nodeToolsHarness(); const page = await harness.page(); const content = Buffer.from('expected');
    const destination = path.join(harness.directory, 'target'); await writeFile(destination, 'old');
    const plan = await uploadPlan(page.id, 'target', content.length); const created = await createUpload(page.id, plan.planId, true);
    await writeFile(destination, 'externally changed');
    await put(created.id, page.id, 0, content);
    await harness.request(`/api/node-tools/tasks/${created.id}/finalize`, json({ sha256: sha256(content) }), page.id);
    await expect.poll(async () => (await task(created.id, page.id)).status).toBe('failed');
    expect(await readFile(destination, 'utf8')).toBe('externally changed');
    await symlink(destination, path.join(harness.directory, 'link'));
    const link = await harness.request('/api/node-tools/files/preflight', json({ directory: harness.directory, files: [{ name: 'link', size: 1 }] }), page.id); expect(link.status).toBe(400);
    const large = await open(path.join(harness.directory, 'too-large'), 'wx'); await large.truncate(NODE_FILE_MAX_BYTES + 1); await large.close();
    expect((await harness.request('/api/node-tools/files/downloads', json({ path: path.join(harness.directory, 'too-large'), requestId: randomUUID() }), page.id)).status).toBe(400);
    const cancelPlan = await uploadPlan(page.id, 'cancelled', content.length); const cancelTask = await createUpload(page.id, cancelPlan.planId);
    await put(cancelTask.id, page.id, 0, content.subarray(0, 2));
    await harness.request(`/api/node-tools/tasks/${cancelTask.id}`, { method: 'DELETE' }, page.id);
    expect((await harness.request(`/api/node-tools/tasks/${cancelTask.id}/finalize`, json({ sha256: sha256(content) }), page.id)).status).toBe(410);
    await expect.poll(async () => (await readdir(path.join(harness!.directory, 'stage'))).length).toBe(0);
    expect(harness.events.some((event) => event.action === 'files.error' && event.id === created.id)).toBe(true);
  });
  it('enforces websocket Origin and session before upgrade and closes terminal on logout', async () => {
    harness = await nodeToolsHarness();
    const rejected = new WebSocket(`${harness.origin.replace('http:', 'ws:')}/api/node-tools/nodes/node/terminal`, { headers: { Origin: 'https://evil.invalid', Cookie: 'test-session=one' } });
    const status = await new Promise<number>((resolve) => { rejected.on('unexpected-response', (_request, response) => { resolve(response.statusCode!); response.resume(); rejected.terminate(); }); rejected.on('error', () => undefined); });
    expect(status).toBe(403);
    const socket = new WebSocket(`${harness.origin.replace('http:', 'ws:')}/api/node-tools/nodes/node/terminal`, { headers: { Origin: harness.origin, Cookie: 'test-session=one' } });
    const events: Array<{ action: string; data?: string }> = []; socket.on('message', (message) => events.push(JSON.parse(message.toString())));
    await new Promise<void>((resolve) => socket.once('open', resolve)); socket.send(JSON.stringify({ action: 'open', cols: 80, rows: 24 }));
    await expect.poll(() => events.some((event) => event.action === 'terminal.opened')).toBe(true);
    socket.send(JSON.stringify({ action: 'input', data: 'printf "SHELL_OK\\n"\r' }));
    await expect.poll(() => events.map((event) => event.data || '').join('')).toContain('SHELL_OK');
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    harness.sessions.delete('one'); await harness.tools.revokeSession('one'); await closed;
    expect(events.some((event) => event.action === 'terminal.exit')).toBe(true);
  });
  it('expires orphan file pages and revokes unfinished task access', async () => {
    harness = await nodeToolsHarness({ leaseMs: 300 }); const page = await harness.page();
    const plan = await uploadPlan(page.id, 'orphan', 100); const created = await createUpload(page.id, plan.planId);
    page.socket.terminate();
    await expect.poll(async () => (await harness!.request(`/api/node-tools/tasks/${created.id}`, {}, page.id)).status).toBe(410);
    await expect.poll(async () => (await readdir(path.join(harness!.directory, 'stage'))).length).toBe(0);
  });
  it('handles empty files without requiring an empty chunk', async () => {
    harness = await nodeToolsHarness(); const page = await harness.page();
    const plan = await uploadPlan(page.id, 'empty', 0); const created = await createUpload(page.id, plan.planId);
    await harness.request(`/api/node-tools/tasks/${created.id}/finalize`, json({ sha256: sha256(Buffer.alloc(0)) }), page.id);
    await expect.poll(async () => (await task(created.id, page.id)).status).toBe('completed');
    expect((await stat(path.join(harness.directory, 'empty'))).size).toBe(0);
  });
});

it.runIf(process.env.NODE_TOOLS_LARGE_TEST === '1')('transfers exactly 1 GiB through all hops with bounded buffers and matching hashes', async () => {
  harness = await nodeToolsHarness(); const page = await harness.page();
  const sourceName = 'one-gib.bin'; const size = NODE_FILE_MAX_BYTES;
  const plan = await uploadPlan(page.id, sourceName, size); const created = await createUpload(page.id, plan.planId);
  const chunk = Buffer.alloc(1024 ** 2, 0x57);
  const expectedHash = (await import('node:crypto')).createHash('sha256');
  let peakArrayBuffers = process.memoryUsage().arrayBuffers;
  for (let offset = 0; offset < size; offset += chunk.length) {
    expectedHash.update(chunk);
    const response = await put(created.id, page.id, offset, chunk);
    expect(response.status).toBe(200); await response.arrayBuffer();
    if (offset === 300 * 1024 ** 2) {
      // The previous response can be lost after the server commits the chunk.
      expect((await put(created.id, page.id, offset, chunk)).status).toBe(200);
    }
    peakArrayBuffers = Math.max(peakArrayBuffers, process.memoryUsage().arrayBuffers);
  }
  const checksum = expectedHash.digest('hex');
  expect((await harness.request(`/api/node-tools/tasks/${created.id}/finalize`, json({ sha256: checksum }), page.id)).status).toBe(200);
  await expect.poll(async () => (await task(created.id, page.id)).status, { timeout: 60_000 }).toBe('completed');
  const nodeFile = await open(path.join(harness.directory, sourceName), 'r');
  try { expect((await nodeFile.stat()).size).toBe(size); expect(await hashFile(nodeFile, size)).toBe(checksum); } finally { await nodeFile.close(); }
  const download = (await (await harness.request('/api/node-tools/files/downloads', json({ path: path.join(harness.directory, sourceName), requestId: randomUUID() }), page.id)).json() as { task: NodeFileTaskView }).task;
  await expect.poll(async () => (await task(download.id, page.id)).status, { timeout: 60_000 }).toBe('ready');
  const response = await harness.request(`/api/node-tools/tasks/${download.id}/content`);
  const hash = (await import('node:crypto')).createHash('sha256'); let bytes = 0;
  for await (const buffer of response.body!) { bytes += buffer.length; hash.update(buffer); peakArrayBuffers = Math.max(peakArrayBuffers, process.memoryUsage().arrayBuffers); }
  expect(bytes).toBe(size); expect(hash.digest('hex')).toBe(checksum);
  // This process includes browser simulation, control plane and Agent at once.
  // Buffers should remain far below a single complete file, including GC headroom.
  expect(peakArrayBuffers).toBeLessThan(256 * 1024 ** 2);
  console.log(`1 GiB verified across four hops; peak ArrayBuffer memory ${(peakArrayBuffers / 1024 ** 2).toFixed(1)} MiB`);
}, 180_000);

it('settles cancel-versus-commit without deleting a committed file or falsely reporting no write', async () => {
  harness = await nodeToolsHarness(); const page = await harness.page(); const bytes = Buffer.from('committed content');
  harness.pauseCompletions();
  const plan = await uploadPlan(page.id, 'race-committed', bytes.length); const created = await createUpload(page.id, plan.planId);
  await put(created.id, page.id, 0, bytes);
  await harness.request(`/api/node-tools/tasks/${created.id}/finalize`, json({ sha256: sha256(bytes) }), page.id);
  await expect.poll(async () => { try { return await readFile(path.join(harness!.directory, 'race-committed'), 'utf8'); } catch { return ''; } }).toBe(bytes.toString());
  const cancelled = await harness.request(`/api/node-tools/tasks/${created.id}`, { method: 'DELETE' }, page.id);
  expect((await cancelled.json() as { task: NodeFileTaskView }).task.status).not.toBe('cancelled');
  harness.releaseCompletions();
  await expect.poll(async () => (await task(created.id, page.id)).status).toBe('completed');
  expect(await readFile(path.join(harness.directory, 'race-committed'))).toEqual(bytes);

  harness.pauseCompletions();
  const uncertainPlan = await uploadPlan(page.id, 'race-unknown', bytes.length); const uncertain = await createUpload(page.id, uncertainPlan.planId);
  await put(uncertain.id, page.id, 0, bytes);
  await harness.request(`/api/node-tools/tasks/${uncertain.id}/finalize`, json({ sha256: sha256(bytes) }), page.id);
  await expect.poll(async () => { try { return await readFile(path.join(harness!.directory, 'race-unknown'), 'utf8'); } catch { return ''; } }).toBe(bytes.toString());
  await harness.request(`/api/node-tools/tasks/${uncertain.id}`, { method: 'DELETE' }, page.id);
  await expect.poll(async () => (await task(uncertain.id, page.id)).error, { timeout: 7000 }).toContain('提交结果不确定');
  expect(await readFile(path.join(harness.directory, 'race-unknown'))).toEqual(bytes);
}, 15_000);
