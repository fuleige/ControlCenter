import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { NODE_FILE_CHUNK_BYTES, NODE_FILE_MAX_BYTES, type NodeFileIdentity } from '@controller-center/protocol';

export function fileSize(size: unknown): number {
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > NODE_FILE_MAX_BYTES) {
    throw new Error('文件超过单文件大小限制（最大 1 GB）或大小无效');
  }
  return size;
}
export function filePath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096 || value.includes('\0')) {
    throw new Error('请输入有效的绝对路径');
  }
  return value;
}
export function fileName(value: unknown): string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\0]/u.test(value) || Buffer.byteLength(value) > 255) {
    throw new Error('文件名称无效');
  }
  return value;
}
export function identity(stat: Stats): NodeFileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, mode: stat.mode, uid: stat.uid, gid: stat.gid };
}
export function sameIdentity(actual: NodeFileIdentity | null, expected: NodeFileIdentity | null): boolean {
  return actual === null || expected === null ? actual === expected
    : (Object.keys(expected) as Array<keyof NodeFileIdentity>).every((key) => actual[key] === expected[key]);
}
export function sha256(buffer: Uint8Array): string { return createHash('sha256').update(buffer).digest('hex'); }
export function validHash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }

/** Positional bounded reads do not transfer ownership of the caller's file handle. */
export async function readChunk(handle: FileHandle, offset: number, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.min(NODE_FILE_CHUNK_BYTES, size - offset));
  let done = 0;
  while (done < buffer.length) {
    const read = await handle.read(buffer, done, buffer.length - done, offset + done);
    if (read.bytesRead === 0) throw new Error('文件内容已变化或缺少数据');
    done += read.bytesRead;
  }
  return buffer;
}
export async function hashFile(handle: FileHandle, size: number, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for (let offset = 0; offset < size; offset += NODE_FILE_CHUNK_BYTES) {
    signal?.throwIfAborted();
    hash.update(await readChunk(handle, offset, size));
  }
  signal?.throwIfAborted();
  return hash.digest('hex');
}
/** Caller serializes writes and persists the returned offset only after this resolves. */
export async function writeChunk(handle: FileHandle, confirmed: number, offset: number, size: number, buffer: Buffer, checksum: string): Promise<number> {
  if (!Number.isSafeInteger(offset) || offset < 0 || buffer.length === 0 || buffer.length > NODE_FILE_CHUNK_BYTES || offset + buffer.length > fileSize(size)) {
    throw new Error('文件分片位置或大小无效');
  }
  if (!validHash(checksum) || sha256(buffer) !== checksum) throw new Error('文件分片校验失败');
  const actual = (await handle.stat()).size;
  if (actual !== confirmed) throw new Error('暂存文件长度与确认位置不一致');
  if (offset < confirmed && offset + buffer.length <= confirmed) {
    const existing = Buffer.alloc(buffer.length);
    const read = await handle.read(existing, 0, existing.length, offset);
    if (read.bytesRead !== existing.length || !existing.equals(buffer)) throw new Error('重复分片内容不一致');
    return confirmed;
  }
  if (offset !== confirmed) throw Object.assign(new Error('文件分片位置不一致，请查询已确认位置'), { statusCode: 409 });
  try {
    let written = 0;
    while (written < buffer.length) {
      const result = await handle.write(buffer, written, buffer.length - written, offset + written);
      if (!result.bytesWritten) throw new Error('文件分片写入失败');
      written += result.bytesWritten;
    }
    await handle.datasync();
    return offset + buffer.length;
  } catch (error) {
    await handle.truncate(confirmed).catch(() => undefined);
    throw error;
  }
}
export function readableError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'Agent 系统用户没有文件或目录访问权限';
  if (code === 'ENOENT') return '文件或目录不存在';
  if (code === 'ENOTDIR') return '目标路径不是目录';
  if (code === 'EISDIR') return '目标是目录，请选择普通文件';
  if (code === 'ELOOP') return '软链接指向循环路径，无法访问';
  if (code === 'EROFS') return '目标文件系统为只读，无法上传';
  if (code === 'ENOSPC' || code === 'EDQUOT') return '磁盘空间或配额不足';
  return error instanceof Error ? error.message : '文件操作失败';
}
