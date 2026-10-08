import { afterEach, describe, expect, it } from 'vitest';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '@controller-center/node-files';
import { NODE_FILE_CHUNK_BYTES, type NodeFileTaskView, type NodeUploadTarget } from '@controller-center/protocol';
import { nodeToolsHarness } from '../../../tests/node-tools-harness.js';
import { directFilesPeer } from '../../../tests/direct-files-peer.js';
let harness: Awaited<ReturnType<typeof nodeToolsHarness>> | undefined;
let peer: Awaited<ReturnType<typeof directFilesPeer>> | undefined;
afterEach(async () => { peer?.close(); peer = undefined; await harness?.close(); harness = undefined; });
async function json<T>(endpoint: string, body: unknown): Promise<T> {
  const response = await harness!.request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, peer!.page.id);
  expect(response.status, await response.clone().text()).toBe(200); return await response.json() as T;
}
async function taskState(id: string, status: string) {
  await expect.poll(async () => ((await (await harness!.request(`/api/node-tools/tasks/${id}`, {}, peer!.page.id)).json()) as { task: NodeFileTaskView }).task.status, { timeout: 10_000, interval: 25 }).toBe(status);
}
describe('authenticated direct file transfers', () => {
  it('revokes live RTC tasks on logout and rejects another page using the task', async () => {
    harness = await nodeToolsHarness({ direct: true }); peer = await directFilesPeer(harness);
    const plan = await json<{ planId: string }>('/api/node-tools/files/preflight', { directory: harness.directory, files: [{ name: 'revoked.bin', size: NODE_FILE_CHUNK_BYTES * 2 }] });
    const upload = await json<{ task: NodeFileTaskView; token: string }>('/api/node-tools/files/uploads', { planId: plan.planId, index: 0, overwrite: false, transport: 'direct' });
    const other = await harness.page(); expect((await harness.request(`/api/node-tools/tasks/${upload.task.id}`, {}, other.id)).status).toBe(403); other.socket.close();
    await peer.wire.request({ kind: 'start', id: upload.task.id, token: upload.token }, AbortSignal.timeout(5000));
    const bytes = Buffer.alloc(NODE_FILE_CHUNK_BYTES, 0x17); await peer.wire.request({ kind: 'chunk', id: upload.task.id, token: upload.token, offset: 0, sha256: sha256(bytes) }, AbortSignal.timeout(5000), bytes);
    harness.sessions.delete('one'); await harness.tools.revokeSession('one');
    await expect(peer.wire.request({ kind: 'finish', id: upload.task.id, token: upload.token, sha256: sha256(bytes) }, AbortSignal.timeout(5000))).rejects.toThrow();
    await expect.poll(async () => (await readdir(harness!.directory)).filter((name) => name.startsWith('.cc-upload')), { timeout: 10_000 }).toEqual([]);
    expect((await readdir(harness.directory)).includes('revoked.bin')).toBe(false);
  }, 20_000);
  it('detects a source changed during direct download before final approval', async () => {
    harness = await nodeToolsHarness({ direct: true }); const source = path.join(harness.directory, 'changing.bin');
    await writeFile(source, Buffer.alloc(NODE_FILE_CHUNK_BYTES + 13, 0x41)); let changed = false; let finished = false;
    peer = await directFilesPeer(harness, async (value, bytes) => {
      if (value.kind === 'chunk') { if (!changed) { changed = true; await writeFile(source, Buffer.alloc(NODE_FILE_CHUNK_BYTES + 13, 0x42)); } return { offset: Number(value.offset) + bytes!.length }; }
      finished = true; return { sha256: value.sha256 };
    });
    const download = await json<{ task: NodeFileTaskView; token: string }>('/api/node-tools/files/downloads', { path: source, requestId: crypto.randomUUID(), transport: 'direct' });
    await peer.wire.request({ kind: 'start', id: download.task.id, token: download.token }, AbortSignal.timeout(5000)); await taskState(download.task.id, 'failed');
    const state = await (await harness.request(`/api/node-tools/tasks/${download.task.id}`, {}, peer.page.id)).json() as { task: NodeFileTaskView };
    expect(state.task.error).toContain('源文件'); expect(finished).toBe(false); expect(state.task.sha256).toBeNull();
  }, 20_000);
  it('resumes the same upload task at a verified boundary and accepts a duplicate chunk', async () => {
    harness = await nodeToolsHarness({ direct: true }); peer = await directFilesPeer(harness);
    const content = Buffer.alloc(NODE_FILE_CHUNK_BYTES + 7, 0x6f);
    const plan = await json<{ planId: string }>('/api/node-tools/files/preflight', { directory: harness.directory, files: [{ name: 'resume.bin', size: content.length }] });
    const upload = await json<{ task: NodeFileTaskView; token: string }>('/api/node-tools/files/uploads', { planId: plan.planId, index: 0, overwrite: false, transport: 'direct' });
    await peer.wire.request({ kind: 'start', id: upload.task.id, token: upload.token }, AbortSignal.timeout(5000));
    const first = content.subarray(0, NODE_FILE_CHUNK_BYTES);
    const message = { kind: 'chunk', id: upload.task.id, token: upload.token, offset: 0, sha256: sha256(first) };
    await peer.wire.request(message, AbortSignal.timeout(5000), first);
    const page = peer.page; peer.wire.close(); peer.pc.close(); peer = await directFilesPeer(harness, undefined, page);
    await json(`/api/node-tools/tasks/${upload.task.id}/resume`, {});
    const started = await peer.wire.request({ kind: 'start', id: upload.task.id, token: upload.token }, AbortSignal.timeout(5000)); expect(started.offset).toBe(first.length);
    expect((await peer.wire.request(message, AbortSignal.timeout(5000), first)).offset).toBe(first.length);
    const tail = content.subarray(first.length); await peer.wire.request({ kind: 'chunk', id: upload.task.id, token: upload.token, offset: first.length, sha256: sha256(tail) }, AbortSignal.timeout(5000), tail);
    await peer.wire.request({ kind: 'finish', id: upload.task.id, token: upload.token, sha256: sha256(content) }, AbortSignal.timeout(5000));
    await taskState(upload.task.id, 'completed'); expect(await readFile(path.join(harness.directory, 'resume.bin'))).toEqual(content);
  }, 20_000);
  it('uploads and downloads across real DataChannels without reserving relay disk', async () => {
    harness = await nodeToolsHarness({ direct: true, quotaBytes: 1 });
    const content = Buffer.alloc(NODE_FILE_CHUNK_BYTES * 2 + 37, 0xa7); const wholeHash = sha256(content);
    const received: Buffer[] = [];
    peer = await directFilesPeer(harness, async (value, bytes) => {
      if (value.kind === 'chunk') { expect(sha256(bytes!)).toBe(value.sha256); received.push(Buffer.from(bytes!)); return { offset: Number(value.offset) + bytes!.length }; }
      expect(value.sha256).toBe(wholeHash); return { sha256: value.sha256 };
    });
    const plan = await json<{ planId: string; targets: NodeUploadTarget[] }>('/api/node-tools/files/preflight', { directory: harness.directory, files: [{ name: '直连.bin', size: content.length }] });
    const upload = await json<{ task: NodeFileTaskView; token: string }>('/api/node-tools/files/uploads', { planId: plan.planId, index: 0, overwrite: false, transport: 'direct' });
    expect(await readdir(path.join(harness.directory, 'stage'))).toEqual([]);
    await expect(peer.wire.request({ kind: 'start', id: upload.task.id, token: 'wrong' }, AbortSignal.timeout(5000))).rejects.toThrow('令牌');
    await peer.wire.request({ kind: 'start', id: upload.task.id, token: upload.token }, AbortSignal.timeout(5000));
    for (let offset = 0; offset < content.length; offset += NODE_FILE_CHUNK_BYTES) {
      const bytes = content.subarray(offset, offset + NODE_FILE_CHUNK_BYTES);
      const ack = await peer.wire.request({ kind: 'chunk', id: upload.task.id, token: upload.token, offset, sha256: sha256(bytes) }, AbortSignal.timeout(5000), bytes);
      expect(ack.offset).toBe(offset + bytes.length);
    }
    const final = await peer.wire.request({ kind: 'finish', id: upload.task.id, token: upload.token, sha256: wholeHash }, AbortSignal.timeout(5000));
    expect(final.committed).toBe(true); await taskState(upload.task.id, 'completed'); expect(await readFile(plan.targets[0]!.path)).toEqual(content);
    const download = await json<{ task: NodeFileTaskView; token: string }>('/api/node-tools/files/downloads', { path: plan.targets[0]!.path, requestId: crypto.randomUUID(), transport: 'direct' });
    await peer.wire.request({ kind: 'start', id: download.task.id, token: download.token }, AbortSignal.timeout(5000));
    await taskState(download.task.id, 'ready'); expect(Buffer.concat(received)).toEqual(content);
    await json(`/api/node-tools/tasks/${download.task.id}/saved`, { sha256: wholeHash }); await taskState(download.task.id, 'completed');
    expect(await readdir(path.join(harness.directory, 'stage'))).toEqual([]);
    const relay = await harness.request('/api/node-tools/files/downloads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: plan.targets[0]!.path, requestId: crypto.randomUUID(), transport: 'relay' }) }, peer.page.id);
    expect(relay.status).toBe(507);
  }, 20_000);
  it('rejects corrupt data and cleans the uncommitted upload', async () => {
    harness = await nodeToolsHarness({ direct: true }); peer = await directFilesPeer(harness);
    const plan = await json<{ planId: string }>('/api/node-tools/files/preflight', { directory: harness.directory, files: [{ name: 'corrupt.bin', size: 3 }] });
    const upload = await json<{ task: NodeFileTaskView; token: string }>('/api/node-tools/files/uploads', { planId: plan.planId, index: 0, overwrite: false, transport: 'direct' });
    await peer.wire.request({ kind: 'start', id: upload.task.id, token: upload.token }, AbortSignal.timeout(5000));
    await expect(peer.wire.request({ kind: 'chunk', id: upload.task.id, token: upload.token, offset: 0, sha256: '0'.repeat(64) }, AbortSignal.timeout(5000), new Uint8Array([1, 2, 3]))).rejects.toThrow();
    await taskState(upload.task.id, 'failed');
    await expect.poll(async () => (await readdir(harness!.directory)).filter((name) => name.startsWith('.cc-upload'))).toEqual([]);
    expect((await readdir(harness.directory)).includes('corrupt.bin')).toBe(false);
  }, 20_000);
});
