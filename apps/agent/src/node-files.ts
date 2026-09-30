import { constants, mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { access, lstat, open, opendir, realpath, rename, stat, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {
  NODE_FILE_CHUNK_BYTES, NODE_TOOL_LEASE_MS, type NodeDownloadSource, type NodeToolCommand, type NodeToolEvent,
  type NodeUploadTarget, type NodeFileIdentity,
} from '@controller-center/protocol';
import { fileName, filePath, fileSize, hashFile, identity, readChunk, readableError, sameIdentity, sha256, validHash } from '@controller-center/node-files';
import type { OutboundNetwork } from './outbound-network.js';

type FileCommand = Extract<NodeToolCommand, { action: `files.${string}` }>;
interface Transfer { controller: AbortController; expires: number; generation: string; path: string; committing: boolean }
interface CleanupEntry { path: string; dev?: number; ino?: number }

export class NodeFiles {
  private readonly transfers = new Map<string, Transfer>();
  private readonly cancelled = new Set<string>();
  private readonly registryPath: string;
  private registry: Record<string, CleanupEntry> = {};
  private registryDirty = false;
  private readonly timer: NodeJS.Timeout;
  constructor(private readonly dataDirectory: string, private readonly cwd: string,
    private readonly network: OutboundNetwork, private readonly controlUrl: string,
    private readonly emit: (event: NodeToolEvent, generation: string) => boolean, private readonly limit = 2) {
    this.registryPath = path.join(dataDirectory, 'node-upload-cleanup.json');
    if (existsSync(this.registryPath)) {
      const value: unknown = JSON.parse(readFileSync(this.registryPath, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('上传清理登记损坏，需检查 Agent 数据目录');
      this.registry = value as Record<string, CleanupEntry>;
    }
    this.cleanupRegistered();
    this.timer = setInterval(() => {
      for (const [id, transfer] of this.transfers) if (transfer.expires <= Date.now()) this.cancel(id);
      this.cleanupRegistered();
    }, 5_000);
    this.timer.unref();
  }
  private saveRegistry(): void {
    mkdirSync(this.dataDirectory, { recursive: true, mode: 0o700 });
    const temp = `${this.registryPath}.tmp`;
    writeFileSync(temp, JSON.stringify(this.registry), { mode: 0o600 }); renameSync(temp, this.registryPath);
    this.registryDirty = false;
  }
  private cleanupRegistered(): void {
    let changed = false;
    for (const [id, entry] of Object.entries(this.registry)) {
      if (this.transfers.has(id)) continue;
      if (!/^[a-f0-9-]{36}$/i.test(id) || typeof entry.path !== 'string' || path.basename(entry.path) !== `.cc-upload-${id}.part`) continue;
      try {
        const info = lstatSync(entry.path);
        if (!info.isFile() || info.uid !== process.getuid?.() || (entry.dev !== undefined && (info.dev !== entry.dev || info.ino !== entry.ino))) continue;
        unlinkSync(entry.path); delete this.registry[id]; changed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { delete this.registry[id]; changed = true; }
      }
    }
    if (changed) this.registryDirty = true;
    if (this.registryDirty) {
      try { this.saveRegistry(); }
      catch (error) { console.warn('[agent] upload cleanup registry update failed; will retry:', readableError(error)); }
    }
  }
  async handle(command: FileCommand, generation: string): Promise<void> {
    if (command.action === 'files.cancel') { this.cancel(command.id); return; }
    if (command.action === 'files.lease') {
      if (!Array.isArray(command.ids) || command.ids.length > 100) return;
      for (const id of command.ids) {
        const current = this.transfers.get(id);
        if (current?.generation === generation) current.expires = Date.now() + NODE_TOOL_LEASE_MS;
      }
      return;
    }
    if ('requestId' in command) {
      try {
        const result = command.action === 'files.list' ? await this.list(command.path || this.cwd, command.cursor)
          : command.action === 'files.preflight' ? await this.preflight(command.directory, command.files)
          : await this.source(command.path);
        this.emit({ action: 'files.result', requestId: command.requestId, result }, generation);
      } catch (error) { this.emit({ action: 'files.result', requestId: command.requestId, error: readableError(error) }, generation); }
      return;
    }
    const id = command.id;
    if (!/^[a-f0-9-]{36}$/i.test(id) || this.transfers.has(id) || this.cancelled.has(id)) return;
    try {
      if (this.transfers.size >= this.limit) throw new Error('节点同时进行的文件任务过多，请稍后再试');
      this.transferUrl(command.url);
      const targetPath = command.action === 'files.upload' ? command.target.path : command.source.path;
      filePath(targetPath);
      if (command.action === 'files.upload' && [...this.transfers.values()].some((current) => current.path === targetPath)) throw new Error('此目标文件正在上传');
      const transfer: Transfer = { controller: new AbortController(), expires: Date.now() + NODE_TOOL_LEASE_MS, generation, path: targetPath, committing: false };
      this.transfers.set(id, transfer);
      try {
        if (command.action === 'files.upload') await this.upload(command, transfer);
        else await this.download(command, transfer);
      } catch (error) {
        if (transfer.committing) throw new Error(`提交结果不确定，请检查目标文件；${readableError(error)}`, { cause: error });
        throw error;
      } finally {
        this.transfers.delete(id); this.cleanupRegistered();
      }
    } catch (error) {
      this.emit({ action: 'files.error', id, error: readableError(error) }, generation);
    }
  }
  private transferUrl(value: string): void {
    const allowed = new URL(this.controlUrl); allowed.protocol = allowed.protocol === 'wss:' ? 'https:' : 'http:';
    const actual = new URL(value);
    if (actual.origin !== allowed.origin || !actual.pathname.startsWith('/agent/node-files/') || actual.username || actual.password || actual.search) throw new Error('文件传输地址无效');
  }
  private async currentTarget(file: string): Promise<NodeFileIdentity | null> {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('上传不能覆盖目录、软链接或特殊文件');
      return identity(info);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private async list(input: string, cursor: number) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 1_000_000) throw new Error('目录分页位置无效');
    const canonical = await realpath(filePath(input));
    const directory = await opendir(canonical);
    const entries = [];
    let index = 0; let more = false;
    try {
      for await (const item of directory) {
        if (index++ < cursor) continue;
        if (entries.length >= 200) { more = true; break; }
        const requested = path.join(canonical, item.name);
        try {
          const info = await lstat(requested);
          let linked: Awaited<ReturnType<typeof stat>> | null = null;
          if (info.isSymbolicLink()) { try { linked = await stat(requested); } catch { /* inaccessible/dangling link remains visible */ } }
          entries.push({ name: item.name, path: requested, type: info.isSymbolicLink() ? 'symlink' as const : info.isDirectory() ? 'directory' as const : info.isFile() ? 'file' as const : 'other' as const,
            size: linked?.isFile() ? linked.size : info.size, modifiedAt: info.mtime.toISOString(),
            ...(info.isSymbolicLink() ? { linkType: !linked ? 'unavailable' as const : linked.isFile() ? 'file' as const : linked.isDirectory() ? 'directory' as const : 'other' as const } : {}) });
        } catch { /* entries can disappear during a bounded directory read */ }
      }
    } finally { await directory.close().catch(() => undefined); }
    return { path: canonical, parent: path.dirname(canonical), entries, nextCursor: more ? index - 1 : null, user: os.userInfo().username };
  }
  private async preflight(directory: string, files: Array<{ name: string; size: number }>): Promise<NodeUploadTarget[]> {
    if (!Array.isArray(files) || files.length === 0 || files.length > 100) throw new Error('每批请选择 1 至 100 个文件');
    const canonical = await realpath(filePath(directory));
    if (!(await stat(canonical)).isDirectory()) throw new Error('上传目标不是目录');
    await access(canonical, constants.W_OK | constants.X_OK);
    const seen = new Set<string>(); const targets = [];
    for (const file of files) {
      const name = fileName(file.name); const size = fileSize(file.size);
      if (seen.has(name)) throw new Error('同一批次不能包含重名文件'); seen.add(name);
      const target = path.join(canonical, name);
      targets.push({ name, path: target, size, existing: await this.currentTarget(target) });
    }
    return targets;
  }
  private async source(input: string): Promise<NodeDownloadSource> {
    const canonical = await realpath(filePath(input));
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('只能下载普通文件');
      return { path: canonical, name: path.basename(canonical), size: fileSize(info.size), identity: identity(info) };
    } finally { await handle.close(); }
  }
  private async request(url: string, token: string, transfer: Transfer, init: Parameters<OutboundNetwork['fetch']>[1] = {}) {
    return this.network.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([transfer.controller.signal, AbortSignal.timeout(30_000)]),
      headers: { ...init?.headers as Record<string, string>, Authorization: `Bearer ${token}` } });
  }
  private async retry<T>(operation: () => Promise<T>, transfer: Transfer): Promise<T> {
    for (let attempt = 0;; attempt++) {
      transfer.controller.signal.throwIfAborted();
      try { return await operation(); } catch (error) {
        if (transfer.controller.signal.aborted || (error as { permanent?: boolean }).permanent || attempt >= 5) throw error;
        await new Promise<void>((resolve, reject) => {
          const signal = transfer.controller.signal;
          const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.min(5_000, 500 * 2 ** attempt));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    }
  }
  private async responseJson(response: Awaited<ReturnType<OutboundNetwork['fetch']>>) {
    const value = await response.json() as { offset?: number; error?: string };
    if (!response.ok) throw Object.assign(new Error(value.error || `文件传输请求失败 (${response.status})`), { permanent: response.status >= 400 && response.status < 500 && response.status !== 409 });
    return value;
  }
  private async upload(command: Extract<FileCommand, { action: 'files.upload' }>, transfer: Transfer): Promise<void> {
    const { id, target, token, url } = command;
    const size = fileSize(target.size);
    if (!validHash(command.sha256)) throw new Error('上传校验值无效');
    const directory = path.dirname(target.path);
    if (await realpath(directory) !== directory || fileName(target.name) !== path.basename(target.path)) throw new Error('目标目录已变化');
    if (!sameIdentity(await this.currentTarget(target.path), target.existing)) throw new Error('目标文件在确认后已变化，请重新上传');
    const tempPath = path.join(directory, `.cc-upload-${id}.part`);
    this.registry[id] = { path: tempPath }; this.saveRegistry();
    let handle: FileHandle | null = null;
    let created = false;
    try {
      handle = await open(tempPath, 'wx+', 0o600); created = true;
      const initial = await handle.stat(); this.registry[id] = { path: tempPath, dev: initial.dev, ino: initial.ino }; this.saveRegistry();
      for (let offset = 0; offset < size;) {
        transfer.controller.signal.throwIfAborted();
        const end = Math.min(offset + NODE_FILE_CHUNK_BYTES, size) - 1;
        const response = await this.retry(async () => {
          const received = await this.request(url, token, transfer, { headers: { Range: `bytes=${offset}-${end}` } });
          if (!received.ok) { await this.responseJson(received); throw new Error('无法获取文件分片'); }
          const expected = end - offset + 1;
          if (received.status !== 206 || received.headers.get('content-length') !== String(expected) || received.headers.get('content-range') !== `bytes ${offset}-${end}/${size}`) {
            await received.body?.cancel(); throw Object.assign(new Error('文件分片响应无效'), { permanent: true });
          }
          // A malicious/misconfigured endpoint must not bypass the bounded-chunk limit.
          const chunks: Uint8Array[] = []; let length = 0;
          for await (const chunk of received.body!) {
            length += chunk.length;
            if (length > expected) throw Object.assign(new Error('文件分片超过声明大小'), { permanent: true });
            chunks.push(chunk);
          }
          if (length !== expected) throw new Error('文件分片传输中断');
          return Buffer.concat(chunks, length);
        }, transfer);
        let written = 0;
        while (written < response.length) {
          const result = await handle.write(response, written, response.length - written, offset + written);
          if (!result.bytesWritten) throw new Error('节点写入失败'); written += result.bytesWritten;
        }
        offset += written;
        this.emit({ action: 'files.progress', id, offset, phase: 'transferring' }, transfer.generation);
      }
      this.emit({ action: 'files.progress', id, offset: size, phase: 'verifying' }, transfer.generation);
      const hash = await hashFile(handle, size, transfer.controller.signal);
      if (hash !== command.sha256) throw new Error('节点文件整体校验失败');
      transfer.controller.signal.throwIfAborted();
      if (await realpath(directory) !== directory || !sameIdentity(await this.currentTarget(target.path), target.existing)) throw new Error('目标文件在确认后已变化，请重新上传');
      if (target.existing) {
        await handle.chown(target.existing.uid, target.existing.gid);
        await handle.chmod(target.existing.mode & 0o7777);
      } else await handle.chmod(0o666 & ~process.umask());
      await handle.sync(); await handle.close(); handle = null;
      // Cancellation is checked immediately before commit. Rename is the commit boundary;
      // cancellation during the syscall never deletes the committed target.
      transfer.controller.signal.throwIfAborted(); transfer.committing = true;
      this.emit({ action: 'files.progress', id, offset: size, phase: 'committing' }, transfer.generation);
      await rename(tempPath, target.path);
      const parent = await open(directory, constants.O_RDONLY);
      try { await parent.sync(); } finally { await parent.close(); }
      delete this.registry[id]; this.saveRegistry();
      this.emit({ action: 'files.complete', id, sha256: hash }, transfer.generation);
    } finally {
      await handle?.close().catch(() => undefined);
      // Registry removal is deferred until transfer ownership ends; failed deletes
      // remain registered and will be retried by the startup/periodic collector.
      if (!created) { delete this.registry[id]; this.saveRegistry(); }
    }
  }
  private async download(command: Extract<FileCommand, { action: 'files.download' }>, transfer: Transfer): Promise<void> {
    const { id, source, token, url } = command;
    const size = fileSize(source.size);
    const handle = await open(filePath(source.path), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || !sameIdentity(identity(info), source.identity)) throw new Error('源文件在开始下载前已变化');
      let offset = 0;
      while (offset < size) {
        transfer.controller.signal.throwIfAborted();
        const chunk = await readChunk(handle, offset, size);
        const checksum = sha256(chunk);
        offset = await this.retry(async () => {
          // Query acknowledged offset on every retry, including a lost PUT response.
          const current = await this.responseJson(await this.request(url, token, transfer));
          if (!Number.isSafeInteger(current.offset) || current.offset! < offset || current.offset! > offset + chunk.length) throw Object.assign(new Error('暂存文件位置无效'), { permanent: true });
          if (current.offset === offset + chunk.length) return current.offset;
          if (current.offset !== offset) throw Object.assign(new Error('暂存文件位置不一致'), { permanent: true });
          const response = await this.request(`${url}/chunks/${offset}`, token, transfer,
            { method: 'PUT', body: chunk, headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': checksum } });
          const result = await this.responseJson(response);
          if (result.offset !== offset + chunk.length) throw new Error('分片确认位置无效');
          return result.offset;
        }, transfer);
        this.emit({ action: 'files.progress', id, offset, phase: 'transferring' }, transfer.generation);
      }
      this.emit({ action: 'files.progress', id, offset: size, phase: 'verifying' }, transfer.generation);
      const hash = await hashFile(handle, size, transfer.controller.signal);
      if (!sameIdentity(identity(await handle.stat()), source.identity) || !sameIdentity(identity(await stat(source.path)), source.identity)) throw new Error('源文件在下载期间已变化，请停止修改后重试');
      await this.retry(async () => {
        const response = await this.request(`${url}/finalize`, token, transfer,
          { method: 'POST', body: JSON.stringify({ sha256: hash }), headers: { 'Content-Type': 'application/json' } });
        await this.responseJson(response);
      }, transfer);
      this.emit({ action: 'files.complete', id, sha256: hash }, transfer.generation);
    } finally { await handle.close(); }
  }
  cancel(id: string): void {
    this.cancelled.add(id); if (this.cancelled.size > 1024) this.cancelled.delete(this.cancelled.values().next().value!);
    const transfer = this.transfers.get(id);
    if (transfer && !transfer.committing) transfer.controller.abort(new Error('文件任务已取消或连接已失联'));
  }
  reset(): void { for (const id of this.transfers.keys()) this.cancel(id); }
  dispose(): void { clearInterval(this.timer); this.reset(); }
}
