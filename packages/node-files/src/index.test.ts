import { mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileName, fileSize, hashFile, sha256, writeChunk } from './index.js';
import { NODE_FILE_MAX_BYTES } from '@controller-center/protocol';

describe('bounded node file I/O', () => {
  it('retries a confirmed chunk without appending and rejects wrong content/offset', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cc-chunks-'));
    const handle = await open(path.join(directory, 'file'), 'wx+');
    try {
      const chunk = Buffer.from('中文 test');
      const offset = await writeChunk(handle, 0, 0, chunk.length * 2, chunk, sha256(chunk));
      expect(await writeChunk(handle, offset, 0, chunk.length * 2, chunk, sha256(chunk))).toBe(offset);
      await expect(writeChunk(handle, offset, 0, chunk.length * 2, Buffer.alloc(chunk.length), sha256(Buffer.alloc(chunk.length)))).rejects.toThrow('重复分片内容不一致');
      await expect(writeChunk(handle, offset, offset + 1, chunk.length * 2, chunk.subarray(1), sha256(chunk.subarray(1)))).rejects.toThrow('位置不一致');
      await expect(writeChunk(handle, offset, offset, chunk.length * 2, chunk, '0'.repeat(64))).rejects.toThrow('校验失败');
      const complete = await writeChunk(handle, offset, offset, chunk.length * 2, chunk, sha256(chunk));
      expect(await hashFile(handle, complete)).toBe(sha256(Buffer.concat([chunk, chunk])));
      expect((await handle.stat()).size).toBe(complete);
    } finally { await handle.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it('accepts exactly 1 GiB and rejects over-limit and unsafe names', () => {
    expect(fileSize(NODE_FILE_MAX_BYTES)).toBe(NODE_FILE_MAX_BYTES);
    for (const size of [NODE_FILE_MAX_BYTES + 1, -1, 1.5, NaN]) expect(() => fileSize(size)).toThrow();
    for (const name of ['../file', '/', '.', '..', 'bad\0name']) expect(() => fileName(name)).toThrow();
    expect(fileName('中文 空格.txt')).toBe('中文 空格.txt');
  });
});
