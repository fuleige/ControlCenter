import { createReadStream, mkdirSync, chmodSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { open, statfs, unlink, type FileHandle } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import {
  NODE_FILES_CAPABILITY, TERMINAL_PTY_CAPABILITY, NODE_TOOL_LEASE_MS, TERMINAL_FRAME_BYTES, TERMINAL_WINDOW_BYTES,
  isRecord, type AgentNodeToolMessage, type NodeToolCommand, type NodeFileTaskView,
  type NodeUploadTarget, type NodeDownloadSource, type NodeDirectory,
} from '@controller-center/protocol';
import { fileSize, hashFile, readableError, validHash, writeChunk } from '@controller-center/node-files';
import type { AgentConnections } from './connections.js';

interface Options {
  directory: string; sqlite: DatabaseSync; connections: AgentConnections; publicOrigin: string; allowedOrigins: string[];
  session: (request: FastifyRequest, touch?: boolean) => { id: string; expiresAt: string } | null;
  quotaBytes?: number; reserveBytes?: number; terminalLimit?: number; fileLimit?: number; leaseMs?: number;
}
interface Page {
  id: string; nodeId: string; sessionId: string; request: FastifyRequest; expires: number;
  socket: WebSocket | null; pingOutstanding: boolean; plans: Map<string, NodeUploadTarget[]>;
}
interface Terminal {
  id: string; nodeId: string; socket: WebSocket; request: FastifyRequest; sessionId: string; generation: string;
  expires: number; pending: number; pingOutstanding: boolean; inputBytes: number; inputWindow: number; opened: boolean;
}
interface Task {
  view: NodeFileTaskView; pageId: string; nodeId: string; sessionId: string; generation: string; token: string;
  target?: NodeUploadTarget; source?: NodeDownloadSource; stagePath: string; handle: FileHandle | null;
  controller: AbortController; queue: Promise<unknown>; streams: Set<ReturnType<typeof createReadStream>>;
  updated: number; readyAt: number | null; started: boolean; cancelRequested: boolean; retained: boolean;
  chunkRequests: number; queuedChunks: number;
  log: { at: number; phase: string; status: string };
  identityKey: string; // idempotent creation key scoped to the current page
}
interface Pending { nodeId: string; generation: string; resolve: (value: NodeDirectory | NodeUploadTarget[] | NodeDownloadSource) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }
const ended = new Set(['completed', 'failed', 'cancelled']);
export class NodeToolError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); this.name = 'NodeToolError'; }
}
function failure(message: string, statusCode = 400): Error { return new NodeToolError(message, statusCode); }
function positive(value: number | undefined, fallback: number): number { return value && Number.isSafeInteger(value) && value > 0 ? value : fallback; }
function safeSend(socket: WebSocket, value: unknown): boolean {
  if (socket.readyState !== socket.OPEN || socket.bufferedAmount > TERMINAL_WINDOW_BYTES * 2) return false;
  socket.send(JSON.stringify(value)); return true;
}

/** Owns only ephemeral node tools. Codex history/commands are deliberately untouched. */
export class NodeTools {
  private readonly generations = new Map<string, string>();
  private readonly terminals = new Map<string, Terminal>();
  private readonly pages = new Map<string, Page>();
  private readonly tasks = new Map<string, Task>();
  private readonly pending = new Map<string, Pending>();
  private readonly timer: NodeJS.Timeout;
  private readonly leaseMs: number;
  private readonly quota: number;
  private readonly diskReserve: number;
  private readonly terminalLimit: number;
  private readonly fileLimit: number;
  private closing = false;
  private readonly startupCleanup = new Set<string>();
  private readonly allocationQueues = new Map<string, Promise<unknown>>();
  constructor(private readonly app: FastifyInstance, private readonly options: Options) {
    this.leaseMs = positive(options.leaseMs, NODE_TOOL_LEASE_MS);
    this.quota = positive(options.quotaBytes, 8 * 1024 ** 3);
    this.diskReserve = positive(options.reserveBytes, 512 * 1024 ** 2);
    this.terminalLimit = positive(options.terminalLimit, 8); this.fileLimit = positive(options.fileLimit, 2);
    mkdirSync(options.directory, { recursive: true, mode: 0o700 }); chmodSync(options.directory, 0o700);
    options.sqlite.exec('CREATE TABLE IF NOT EXISTS node_file_tasks (id TEXT PRIMARY KEY, metadata TEXT NOT NULL)');
    // A restart never resumes an old task. Keep failed-cleanup records accounted for.
    for (const row of options.sqlite.prepare('SELECT id FROM node_file_tasks').all() as Array<{ id: string }>) this.startupCleanup.add(row.id);
    for (const name of readdirSync(options.directory)) {
      if (/^[a-f0-9-]{36}\.part$/i.test(name)) this.startupCleanup.add(name.slice(0, -5));
    }
    this.cleanupStartup();
    this.routes();
    this.timer = setInterval(() => { void this.tick().catch((error) => this.app.log.error({ error: readableError(error) }, 'Node tools cleanup failed')); }, Math.min(15_000, this.leaseMs / 3));
    this.timer.unref();
  }
  nodeConnected(nodeId: string): void {
    this.nodeDisconnected(nodeId);
    if (!this.options.connections.hasCapability(nodeId, TERMINAL_PTY_CAPABILITY) && !this.options.connections.hasCapability(nodeId, NODE_FILES_CAPABILITY)) return;
    const generation = randomUUID(); this.generations.set(nodeId, generation);
    this.options.connections.send(nodeId, { type: 'control.nodeTool', generation, command: { action: 'reset' } });
  }
  nodeDisconnected(nodeId: string): void {
    for (const terminal of this.terminals.values()) if (terminal.nodeId === nodeId) this.closeTerminal(terminal, '节点连接已断开');
    for (const task of this.tasks.values()) if (task.nodeId === nodeId && !ended.has(task.view.status) && task.view.status !== 'ready') {
      this.failTask(task, task.view.direction === 'upload' && task.started ? '提交结果不确定，请检查目标文件；节点连接已断开' : '节点连接已断开，文件任务已中断');
    }
    for (const [id, pending] of this.pending) if (pending.nodeId === nodeId) {
      clearTimeout(pending.timer); this.pending.delete(id); pending.reject(failure('节点已离线', 409));
    }
    this.generations.delete(nodeId);
  }
  handleAgent(nodeId: string, message: AgentNodeToolMessage): void {
    if (message.generation !== this.generations.get(nodeId) || !isRecord(message.event)) return;
    const event = message.event;
    if (event.action === 'files.result') {
      const pending = this.pending.get(event.requestId);
      if (!pending || pending.nodeId !== nodeId || pending.generation !== message.generation) return;
      clearTimeout(pending.timer); this.pending.delete(event.requestId);
      if (event.error) pending.reject(failure(event.error));
      else if (event.result) pending.resolve(event.result);
      else pending.reject(failure('节点返回的文件结果无效'));
      return;
    }
    if (event.action.startsWith('terminal.') && 'id' in event) {
      const terminal = this.terminals.get(event.id);
      if (!terminal || terminal.nodeId !== nodeId || terminal.generation !== message.generation) return;
      if (event.action === 'terminal.output') {
        if (typeof event.data !== 'string' || Buffer.byteLength(event.data) !== event.bytes || event.bytes > TERMINAL_FRAME_BYTES || event.bytes <= 0) {
          this.closeTerminal(terminal, '终端输出格式无效'); return;
        }
        terminal.pending += event.bytes;
        if (terminal.pending > TERMINAL_WINDOW_BYTES * 2 || !safeSend(terminal.socket, event)) this.closeTerminal(terminal, '终端输出超过连接容量');
      } else if (event.action === 'terminal.opened') {
        terminal.opened = true; safeSend(terminal.socket, event);
      } else if (event.action === 'terminal.exit' || event.action === 'terminal.error') {
        safeSend(terminal.socket, event); this.closeTerminal(terminal, event.action === 'terminal.exit' ? event.reason : event.error);
      }
      return;
    }
    if (!('id' in event)) return;
    const task = this.tasks.get(event.id);
    if (!task || task.nodeId !== nodeId || task.generation !== message.generation || ended.has(task.view.status)) return;
    if (event.action === 'files.progress') {
      if (task.view.status === 'ready') return;
      if (!Number.isSafeInteger(event.offset) || event.offset < task.view.agentOffset || event.offset > task.view.size) return;
      task.view.agentOffset = event.offset;
      task.view.phase = event.phase === 'committing' ? 'committing' : event.phase === 'verifying' ? 'verifying'
        : task.view.direction === 'upload' ? 'node-upload' : 'node-download';
      if (event.phase !== 'transferring') task.view.status = event.phase;
      task.updated = Date.now(); this.persist(task);
      this.logTask(task, 'progress');
    } else if (event.action === 'files.error') this.failTask(task, event.error);
    else if (event.action === 'files.complete') {
      if (!validHash(event.sha256) || event.sha256 !== task.view.sha256) { this.failTask(task, '节点整体校验结果不一致'); return; }
      if (task.view.direction === 'upload') {
        task.view.status = 'completed'; task.view.phase = 'completed'; task.view.agentOffset = task.view.size;
        this.persist(task); void this.cleanupTask(task);
        this.logTask(task, 'completed');
      } // Download readiness is established by the HTTP finalize/streamed hash, never this event alone.
    }
  }
  private send(nodeId: string, command: NodeToolCommand): boolean {
    const generation = this.generations.get(nodeId);
    return Boolean(generation && this.options.connections.send(nodeId, { type: 'control.nodeTool', generation, command }));
  }
  private requireNode(nodeId: string, capability: string): void {
    if (!this.options.connections.has(nodeId) || !this.generations.has(nodeId)) throw failure('节点当前离线', 409);
    if (!this.options.connections.hasCapability(nodeId, capability)) throw failure('需升级 Agent 才能使用此功能', 409);
  }
  private session(request: FastifyRequest): { id: string; expiresAt: string } {
    const session = this.options.session(request, true);
    if (!session) throw failure('登录状态已失效', 401);
    return session;
  }
  private socketAuth(request: FastifyRequest, capability: string): void {
    this.session(request);
    if (!request.headers.origin || !this.options.allowedOrigins.includes(request.headers.origin)) throw failure('终端或文件页面来源不受信任', 403);
    const nodeId = (request.params as { nodeId: string }).nodeId;
    this.requireNode(nodeId, capability);
  }
  private page(request: FastifyRequest): Page {
    const session = this.session(request);
    const id = request.headers['x-node-page'];
    const page = typeof id === 'string' ? this.pages.get(id) : null;
    if (!page || page.sessionId !== session.id || page.expires <= Date.now()) throw failure('文件页面已关闭或失联，请重新打开节点文件', 410);
    return page;
  }
  private browserTask(request: FastifyRequest, id: string, download = false): Task {
    const task = this.tasks.get(id); const session = this.session(request);
    const page = task ? this.pages.get(task.pageId) : null;
    if (!task || task.sessionId !== session.id || !page || page.expires <= Date.now()) throw failure('文件任务已失效', 410);
    if (!download && this.page(request).id !== task.pageId) throw failure('文件任务不属于当前页面', 403);
    return task;
  }
  private agentTask(request: FastifyRequest, id: string): Task {
    const task = this.tasks.get(id);
    const header = request.headers.authorization || ''; const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const page = task ? this.pages.get(task.pageId) : null;
    const actual = Buffer.from(token); const expected = Buffer.from(task?.token || '');
    if (!task || !page || page.expires <= Date.now() || actual.length !== expected.length || !timingSafeEqual(actual, expected)
      || task.generation !== this.generations.get(task.nodeId) || !this.options.session(page.request)) throw failure('文件任务令牌无效或已过期', 401);
    if (ended.has(task.view.status) || task.cancelRequested) throw failure('文件任务已结束', 410);
    return task;
  }
  private rpc(nodeId: string, command: (requestId: string) => NodeToolCommand): Promise<NodeDirectory | NodeUploadTarget[] | NodeDownloadSource> {
    this.requireNode(nodeId, NODE_FILES_CAPABILITY);
    if (this.pending.size >= 64) return Promise.reject(failure('节点文件请求过多，请稍后再试', 429));
    const id = randomUUID(); const generation = this.generations.get(nodeId)!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(failure('节点文件操作超时', 504)); }, 15_000);
      this.pending.set(id, { nodeId, generation, resolve, reject, timer });
      if (!this.send(nodeId, command(id))) { clearTimeout(timer); this.pending.delete(id); reject(failure('节点当前离线', 409)); }
    });
  }
  private closeTerminal(terminal: Terminal, reason: string): void {
    if (this.terminals.get(terminal.id) !== terminal) return;
    this.terminals.delete(terminal.id);
    this.send(terminal.nodeId, { action: 'terminal.close', id: terminal.id });
    safeSend(terminal.socket, { action: 'terminal.exit', id: terminal.id, exitCode: -1, reason });
    terminal.socket.close(1000, 'Terminal ended');
    const timer = setTimeout(() => { if (terminal.socket.readyState !== terminal.socket.CLOSED) terminal.socket.terminate(); }, 2_000); timer.unref();
  }
  private persist(task: Task): void {
    this.options.sqlite.prepare('INSERT INTO node_file_tasks(id,metadata) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata')
      .run(task.view.id, JSON.stringify({ ...task.view, nodeId: task.nodeId, pageId: task.pageId, sessionId: task.sessionId, stagePath: task.stagePath }));
  }
  private logTask(task: Task, event: string): void {
    const now = Date.now(); const view = task.view;
    if (event === 'progress' && task.log.phase === view.phase && task.log.status === view.status && now - task.log.at < 10_000) return;
    task.log = { at: now, phase: view.phase, status: view.status };
    this.app.log.info({ event, taskId: view.id, nodeId: task.nodeId, direction: view.direction, name: view.name,
      size: view.size, offset: view.offset, agentOffset: view.agentOffset, status: view.status, phase: view.phase,
      ...(view.error ? { error: view.error } : {}) }, 'Node file task');
  }
  private failTask(task: Task, error: string): void {
    if (ended.has(task.view.status)) return;
    task.view.status = 'failed'; task.view.error = error; task.controller.abort(); this.send(task.nodeId, { action: 'files.cancel', id: task.view.id });
    this.persist(task); void this.cleanupTask(task);
    this.logTask(task, 'failed');
  }
  private cancelTask(task: Task): void {
    if (ended.has(task.view.status)) return;
    task.cancelRequested = true; task.controller.abort(); this.send(task.nodeId, { action: 'files.cancel', id: task.view.id });
    this.logTask(task, 'cancel-requested');
    if (task.view.direction === 'upload' && task.started) {
      // The Agent may already have committed, with its confirmation still in flight.
      // Keep the event owner briefly so completion/error can settle the race.
      task.view.error = '正在取消；若节点已提交文件，将保留已完成结果';
      task.updated = Date.now(); this.persist(task);
      const timer = setTimeout(() => {
        if (!ended.has(task.view.status)) this.failTask(task, '提交结果不确定，请检查目标文件');
      }, 5_000); timer.unref();
    } else {
      task.view.status = 'cancelled'; task.view.error = '文件任务已取消'; this.persist(task); void this.cleanupTask(task);
      this.logTask(task, 'cancelled');
    }
  }
  private async cleanupTask(task: Task): Promise<void> {
    if (!ended.has(task.view.status)) return;
    for (const stream of task.streams) stream.destroy(); task.streams.clear();
    await task.queue.catch(() => undefined);
    await task.handle?.close().catch(() => undefined); task.handle = null;
    try {
      await unlink(task.stagePath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      task.retained = false;
      this.options.sqlite.prepare('DELETE FROM node_file_tasks WHERE id=?').run(task.view.id);
      if (!this.pages.has(task.pageId)) this.tasks.delete(task.view.id);
    } catch { /* still charged to the quota and retried by tick/startup */ }
  }
  private cleanupStartup(): void {
    for (const id of this.startupCleanup) {
      if (!/^[a-f0-9-]{36}$/i.test(id)) continue;
      try { unlinkSync(path.join(this.options.directory, `${id}.part`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue; }
      this.options.sqlite.prepare('DELETE FROM node_file_tasks WHERE id=?').run(id); this.startupCleanup.delete(id);
    }
  }
  private async expirePage(page: Page, reason = 'page-close-request'): Promise<void> {
    if (this.pages.get(page.id) !== page) return;
    this.pages.delete(page.id); page.socket?.close(1000, 'File page ended');
    this.app.log.info({ pageId: page.id, nodeId: page.nodeId, reason }, 'Node file page ended');
    for (const task of this.tasks.values()) if (task.pageId === page.id) {
      this.cancelTask(task);
      if (ended.has(task.view.status)) await this.cleanupTask(task);
    }
  }
  private async tick(): Promise<void> {
    if (this.closing) return;
    const now = Date.now(); this.cleanupStartup();
    for (const terminal of this.terminals.values()) {
      const session = this.options.session(terminal.request, true);
      if (!session || session.id !== terminal.sessionId || terminal.expires <= now || (!terminal.opened && now - terminal.inputWindow > 15_000)) {
        this.closeTerminal(terminal, !session ? '登录状态已失效' : '终端连接已失联'); continue;
      }
      if (!terminal.pingOutstanding) { terminal.pingOutstanding = true; terminal.socket.ping(); }
    }
    for (const page of this.pages.values()) {
      const session = this.options.session(page.request, true);
      if (!session || session.id !== page.sessionId || page.expires <= now) { await this.expirePage(page, !session ? 'session-expired' : 'page-lease-expired'); continue; }
      if (page.socket && page.socket.readyState === page.socket.OPEN && !page.pingOutstanding) { page.pingOutstanding = true; page.socket.ping(); }
      const activeIds = [...this.tasks.values()].filter((task) => task.pageId === page.id && task.started && !ended.has(task.view.status) && !task.cancelRequested).map((task) => task.view.id);
      if (activeIds.length) this.send(page.nodeId, { action: 'files.lease', ids: activeIds });
    }
    for (const task of this.tasks.values()) {
      if (ended.has(task.view.status) && task.retained) await this.cleanupTask(task);
      else if (task.view.status === 'ready' && task.readyAt && now - task.readyAt > 30 * 60_000 && task.streams.size === 0) this.failTask(task, '准备文件已过期，请重新下载');
      else if (!ended.has(task.view.status) && task.view.status !== 'ready' && now - task.updated > 5 * 60_000) this.failTask(task, '文件任务长时间没有进展，已中断');
    }
  }
  async revokeSession(id: string): Promise<void> {
    for (const terminal of this.terminals.values()) if (terminal.sessionId === id) this.closeTerminal(terminal, '登录已退出');
    for (const page of this.pages.values()) if (page.sessionId === id) await this.expirePage(page, 'logout');
  }
  async close(): Promise<void> {
    this.closing = true; clearInterval(this.timer);
    for (const terminal of this.terminals.values()) this.closeTerminal(terminal, '控制中心正在关闭');
    for (const page of this.pages.values()) await this.expirePage(page, 'control-plane-shutdown');
    for (const task of this.tasks.values()) {
      if (!ended.has(task.view.status)) this.failTask(task, task.started && task.view.direction === 'upload' ? '提交结果不确定，请检查目标文件；控制中心正在关闭' : '控制中心正在关闭');
      await this.cleanupTask(task);
    }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(failure('控制中心正在关闭', 503)); }
    this.pending.clear();
  }
  private async allocate(page: Page, view: NodeFileTaskView, extra: { target?: NodeUploadTarget; source?: NodeDownloadSource }, key: string): Promise<Task> {
    // Serialize allocations globally: reserve check and creation must be atomic
    // across concurrent requests, even while opening the staging file awaits I/O.
    const previous = this.allocationQueues.get("global") || Promise.resolve();
    const allocation = previous.catch(() => undefined).then(async () => {
      if (!this.pages.has(page.id) || page.expires <= Date.now()) throw failure('文件页面已失联', 410);
      const existing = [...this.tasks.values()].find((task) => task.pageId === page.id && task.identityKey === key);
      if (existing) return existing;
      if ([...this.tasks.values()].filter((task) => task.nodeId === page.nodeId && !ended.has(task.view.status) && task.view.status !== 'ready').length >= this.fileLimit) throw failure('节点文件任务已满，请等待当前传输结束', 429);
      if (this.tasks.size >= 512) throw failure('文件任务过多，请关闭已完成任务所在页面', 429);
      if (extra.target && [...this.tasks.values()].some((task) => task.nodeId === page.nodeId && task.target?.path === extra.target!.path && !ended.has(task.view.status))) throw failure('此目标文件正在上传，请等待其完成', 409);
      let used = [...this.tasks.values()].filter((task) => task.retained).reduce((total, task) => total + task.view.size, 0);
      for (const id of this.startupCleanup) { try { used += statSync(path.join(this.options.directory, `${id}.part`)).size; } catch { /* missing */ } }
      const disk = await statfs(this.options.directory);
      const pendingDiskBytes = [...this.tasks.values()].filter((task) => task.retained).reduce((total, task) => total + Math.max(0, task.view.size - task.view.offset), 0);
      if (used + view.size > this.quota || disk.bavail * disk.bsize - view.size - pendingDiskBytes < this.diskReserve) throw failure('服务器暂存空间或磁盘余量不足', 507);
      const task: Task = { view, ...extra, pageId: page.id, nodeId: page.nodeId, sessionId: page.sessionId, generation: this.generations.get(page.nodeId)!,
        token: randomBytes(32).toString('base64url'), stagePath: path.join(this.options.directory, `${view.id}.part`), handle: null,
        controller: new AbortController(), queue: Promise.resolve(), streams: new Set(), updated: Date.now(), readyAt: null, started: false, cancelRequested: false, retained: true, identityKey: key, chunkRequests: 0, queuedChunks: 0, log: { at: 0, phase: '', status: '' } };
      this.tasks.set(view.id, task); this.persist(task);
      try { task.handle = await open(task.stagePath, 'wx+', 0o600); }
      catch (error) { this.failTask(task, readableError(error)); throw failure(readableError(error), 507); }
      if (!this.pages.has(page.id) || ended.has(task.view.status) || task.generation !== this.generations.get(page.nodeId)) { this.cancelTask(task); await this.cleanupTask(task); throw failure('文件页面或节点已失联', 410); }
      this.logTask(task, 'created');
      return task;
    });
    this.allocationQueues.set("global", allocation);
    try { return await allocation; }
    finally { if (this.allocationQueues.get("global") === allocation) this.allocationQueues.delete("global"); }
  }
  private serial<T>(task: Task, operation: () => Promise<T>): Promise<T> {
    const pending = task.queue.catch(() => undefined).then(operation); task.queue = pending; return pending;
  }
  private reserveChunk(request: FastifyRequest, agent: boolean): void {
    const id = (request.params as { id: string }).id;
    const task = agent ? this.agentTask(request, id) : this.browserTask(request, id);
    if (task.chunkRequests >= 2) throw failure('文件分片请求过多，请稍后重试', 429);
    task.chunkRequests++;
    let released = false;
    const release = () => { if (!released) { released = true; task.chunkRequests--; } };
    request.raw.once('aborted', release);
    request.raw.socket.once('close', release);
    const response = request.raw.socket;
    // Removed after reply completion below; never accumulate listeners on a keepalive socket.
    (request as FastifyRequest & { releaseNodeChunk?: () => void }).releaseNodeChunk = () => {
      request.raw.removeListener('aborted', release); response.removeListener('close', release); release();
    };
  }
  private releaseChunk(request: FastifyRequest): void {
    (request as FastifyRequest & { releaseNodeChunk?: () => void }).releaseNodeChunk?.();
  }
  private async receiveChunk(task: Task, offset: number, body: unknown, checksum: unknown): Promise<{ offset: number }> {
    if (!Buffer.isBuffer(body) || typeof checksum !== 'string') throw failure('文件分片格式无效');
    if (task.queuedChunks >= 2) throw failure('文件分片写入队列已满，请稍后重试', 429);
    task.queuedChunks++;
    try { return await this.serial(task, async () => {
      if (ended.has(task.view.status) || task.cancelRequested || task.controller.signal.aborted || !task.handle || task.view.sha256) throw failure('任务已结束或不再接受分片', 410);
      try {
        task.view.offset = await writeChunk(task.handle, task.view.offset, offset, task.view.size, body, checksum);
        task.updated = Date.now(); this.persist(task); this.logTask(task, 'progress'); return { offset: task.view.offset };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOSPC' || (error as NodeJS.ErrnoException).code === 'EDQUOT') this.failTask(task, '磁盘空间不足');
        throw failure(readableError(error), (error as { statusCode?: number }).statusCode || 400);
      }
    }); } finally { task.queuedChunks--; }
  }
  private async finalize(task: Task, checksum: unknown): Promise<void> {
    if (!validHash(checksum)) throw failure('文件整体校验值无效');
    await this.serial(task, async () => {
      if (task.view.status === 'completed' && task.view.sha256 === checksum) return;
      if (ended.has(task.view.status) || task.cancelRequested || task.controller.signal.aborted || !task.handle) throw failure('文件任务已结束', 410);
      if (task.view.sha256) { if (task.view.sha256 !== checksum) throw failure('重复提交的校验值不同'); return; }
      if (task.view.offset !== task.view.size || (await task.handle.stat()).size !== task.view.size) throw failure('文件还未传输完整', 409);
      task.view.status = 'verifying'; task.view.phase = 'verifying'; task.updated = Date.now(); this.persist(task);
      this.logTask(task, 'verifying');
      const actual = await hashFile(task.handle, task.view.size, task.controller.signal);
      if (actual !== checksum) { this.failTask(task, '文件整体校验失败'); throw failure('文件整体校验失败'); }
      task.controller.signal.throwIfAborted(); await task.handle.sync(); task.view.sha256 = actual;
      if (task.view.direction === 'download') {
        task.view.status = 'ready'; task.view.phase = 'ready'; task.view.agentOffset = task.view.size; task.readyAt = Date.now();
      } else {
        task.view.status = 'transferring'; task.view.phase = 'node-upload'; task.started = true;
        if (!this.send(task.nodeId, { action: 'files.upload', id: task.view.id, target: task.target!, sha256: actual, url: `${this.options.publicOrigin}/agent/node-files/${task.view.id}/content`, token: task.token })) {
          this.failTask(task, '节点已离线'); throw failure('节点已离线', 409);
        }
      }
      task.updated = Date.now(); this.persist(task);
      this.logTask(task, task.view.status === 'ready' ? 'ready' : 'node-upload-started');
    });
  }
  private serve(task: Task, request: FastifyRequest, reply: FastifyReply, browser: boolean) {
    if (!task.view.sha256 || ended.has(task.view.status) || task.cancelRequested || !task.retained) throw failure('文件暂存尚未准备好或已过期', 410);
    const total = task.view.size; const etag = `"${task.view.sha256}"`;
    reply.header('Accept-Ranges', 'bytes').header('ETag', etag).header('Cache-Control', 'private, no-store')
      .header('Content-Type', 'application/octet-stream').header('X-Content-Type-Options', 'nosniff');
    if (browser) reply.header('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(task.view.name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`);
    let start = 0; let end = total - 1;
    const range = request.headers.range;
    if (range && (!request.headers['if-range'] || request.headers['if-range'] === etag)) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2]) || total === 0) return reply.code(416).header('Content-Range', `bytes */${total}`).send();
      if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) return reply.code(416).header('Content-Range', `bytes */${total}`).send(); start = Math.max(0, total - suffix); }
      else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), total - 1); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= total || start > end) return reply.code(416).header('Content-Range', `bytes */${total}`).send();
      reply.code(206).header('Content-Range', `bytes ${start}-${end}/${total}`);
    }
    reply.header('Content-Length', String(Math.max(0, end - start + 1)));
    task.updated = Date.now();
    if (task.streams.size >= 4) throw failure('此文件下载连接过多', 429);
    if (browser) this.app.log.info({ taskId: task.view.id, nodeId: task.nodeId, name: task.view.name, size: total, start, end }, 'Node file browser download started');
    if (total === 0) return reply.send(Buffer.alloc(0));
    const stream = createReadStream(task.stagePath, { start, end, highWaterMark: 64 * 1024 }); task.streams.add(stream);
    stream.on('close', () => {
      task.streams.delete(stream); task.updated = Date.now();
      if (browser && task.view.status === 'ready') task.readyAt = Date.now();
    });
    reply.raw.once('close', () => {
      stream.destroy();
      if (browser) this.app.log.info({ taskId: task.view.id, bytesRead: stream.bytesRead, responseFinished: reply.raw.writableFinished }, 'Node file browser response ended');
    });
    return reply.send(stream);
  }
  private routes(): void {
    const app = this.app;
    app.get<{ Params: { nodeId: string } }>('/api/node-tools/nodes/:nodeId/info', async (request) => {
      this.session(request); const nodeId = request.params.nodeId;
      return { online: this.options.connections.has(nodeId), terminal: this.options.connections.hasCapability(nodeId, TERMINAL_PTY_CAPABILITY),
        files: this.options.connections.hasCapability(nodeId, NODE_FILES_CAPABILITY) };
    });
    app.get<{ Params: { nodeId: string } }>('/api/node-tools/nodes/:nodeId/terminal', {
      websocket: true, preValidation: async (request) => this.socketAuth(request, TERMINAL_PTY_CAPABILITY),
    }, (socket: WebSocket, request) => {
      const nodeId = request.params.nodeId;
      if ([...this.terminals.values()].filter((terminal) => terminal.nodeId === nodeId).length >= this.terminalLimit) {
        safeSend(socket, { action: 'terminal.error', error: `节点最多同时打开 ${this.terminalLimit} 个终端` }); socket.close(); return;
      }
      const terminal: Terminal = { id: randomUUID(), nodeId, socket, request, sessionId: this.session(request).id, generation: this.generations.get(nodeId)!,
        expires: Date.now() + this.leaseMs, pending: 0, pingOutstanding: false, inputBytes: 0, inputWindow: Date.now(), opened: false };
      this.terminals.set(terminal.id, terminal);
      let requested = false;
      socket.on('pong', () => {
        if (!terminal.pingOutstanding || this.terminals.get(terminal.id) !== terminal || !this.options.session(request)) return;
        terminal.pingOutstanding = false; terminal.expires = Date.now() + this.leaseMs; this.send(nodeId, { action: 'terminal.lease', id: terminal.id });
      });
      socket.on('message', (raw) => {
        try {
          if (raw.toString().length > 128 * 1024) throw failure('终端消息过长');
          const value: unknown = JSON.parse(raw.toString());
          if (!isRecord(value) || typeof value.action !== 'string') throw failure('终端消息无效');
          if (!this.options.session(request)) throw failure('登录状态已失效');
          if (value.action === 'open' && !requested) {
            if (![value.cols, value.rows].every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 2 && n <= 500)) throw failure('终端尺寸无效');
            requested = true; this.send(nodeId, { action: 'terminal.open', id: terminal.id, cols: value.cols as number, rows: value.rows as number });
          } else if (value.action === 'input' && terminal.opened) {
            if (typeof value.data !== 'string' || Buffer.byteLength(value.data) > TERMINAL_FRAME_BYTES) throw failure('终端输入过长');
            if (Date.now() - terminal.inputWindow > 1_000) { terminal.inputWindow = Date.now(); terminal.inputBytes = 0; }
            terminal.inputBytes += Buffer.byteLength(value.data);
            if (terminal.inputBytes > 256 * 1024) throw failure('终端输入过于频繁');
            this.send(nodeId, { action: 'terminal.input', id: terminal.id, data: value.data });
          } else if (value.action === 'resize' && requested) {
            if (![value.cols, value.rows].every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 2 && n <= 500)) throw failure('终端尺寸无效');
            this.send(nodeId, { action: 'terminal.resize', id: terminal.id, cols: value.cols as number, rows: value.rows as number });
          } else if (value.action === 'ack') {
            if (typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > terminal.pending) throw failure('终端确认无效');
            terminal.pending -= value.bytes; this.send(nodeId, { action: 'terminal.ack', id: terminal.id, bytes: value.bytes });
          } else if (value.action === 'close') this.closeTerminal(terminal, '终端已关闭');
        } catch (error) { this.closeTerminal(terminal, readableError(error)); }
      });
      socket.on('close', () => this.closeTerminal(terminal, '终端页面已关闭或连接中断'));
      socket.on('error', () => this.closeTerminal(terminal, '终端连接错误'));
      safeSend(socket, { action: 'terminal.connected' });
    });
    app.post<{ Params: { nodeId: string } }>('/api/node-tools/nodes/:nodeId/pages', async (request) => {
      const session = this.session(request); this.requireNode(request.params.nodeId, NODE_FILES_CAPABILITY);
      if (this.pages.size >= 128) throw failure('文件管理页面过多，请关闭不用的页面', 429);
      const page: Page = { id: randomUUID(), nodeId: request.params.nodeId, sessionId: session.id, request, expires: Date.now() + this.leaseMs,
        socket: null, pingOutstanding: false, plans: new Map() }; this.pages.set(page.id, page);
      return { pageId: page.id };
    });
    app.get<{ Params: { nodeId: string; pageId: string } }>('/api/node-tools/nodes/:nodeId/pages/:pageId/connect', {
      websocket: true, preValidation: async (request) => {
        this.socketAuth(request, NODE_FILES_CAPABILITY);
        const page = this.pages.get(request.params.pageId);
        if (!page || page.nodeId !== request.params.nodeId || page.sessionId !== this.session(request).id || page.expires <= Date.now()) throw failure('文件页面已失效', 410);
      },
    }, (socket: WebSocket, request) => {
      const page = this.pages.get(request.params.pageId)!;
      page.socket?.close(1000, 'Replaced'); page.socket = socket; page.request = request; page.expires = Date.now() + this.leaseMs; page.pingOutstanding = false;
      socket.on('pong', () => { if (page.socket === socket && page.pingOutstanding && this.options.session(request)) { page.pingOutstanding = false; page.expires = Date.now() + this.leaseMs; } });
      socket.on('message', (raw) => { if (raw.toString() === '{"action":"close"}' && page.socket === socket) void this.expirePage(page, 'page-close-message'); });
      // A transport interruption has a bounded grace period; a new page cannot adopt this ID.
      socket.on('close', () => { if (page.socket === socket) { page.socket = null; page.pingOutstanding = false; } });
      socket.on('error', () => { if (page.socket === socket) socket.close(); });
      safeSend(socket, { action: 'page.connected' });
    });
    app.delete<{ Params: { id: string } }>('/api/node-tools/pages/:id', async (request, reply) => {
      const page = this.pages.get(request.params.id);
      if (page && page.sessionId === this.session(request).id) await this.expirePage(page);
      return reply.code(204).send();
    });
    app.get<{ Querystring: { path?: string; cursor?: string } }>('/api/node-tools/files/list', async (request) => {
      const page = this.page(request);
      return { directory: await this.rpc(page.nodeId, (requestId) => ({ action: 'files.list', requestId, path: request.query.path || '', cursor: Number(request.query.cursor || 0) })) };
    });
    app.post<{ Body: { directory: string; files: Array<{ name: string; size: number }> } }>('/api/node-tools/files/preflight', async (request) => {
      const page = this.page(request); const body = request.body;
      if (!body || !Array.isArray(body.files) || body.files.length > 100 || body.files.length === 0) throw failure('每批请选择 1 至 100 个文件');
      body.files.forEach((file) => fileSize(file.size));
      const result = await this.rpc(page.nodeId, (requestId) => ({ action: 'files.preflight', requestId, directory: body.directory, files: body.files }));
      if (!this.pages.has(page.id)) throw failure('文件页面已失效', 410);
      if (!Array.isArray(result)) throw failure('节点预检结果无效');
      if (page.plans.size >= 16) page.plans.delete(page.plans.keys().next().value!);
      const planId = randomUUID(); page.plans.set(planId, result);
      return { planId, targets: result };
    });
    app.post<{ Body: { planId: string; index: number; overwrite: boolean } }>('/api/node-tools/files/uploads', async (request) => {
      const page = this.page(request); const body = request.body;
      const target = body && Number.isInteger(body.index) ? page.plans.get(body.planId)?.[body.index] : null;
      if (!target) throw failure('上传预检已失效，请重新选择文件', 410);
      if (target.existing && body.overwrite !== true) throw failure('同名文件尚未确认覆盖', 409);
      const task = await this.allocate(page, { id: randomUUID(), direction: 'upload', name: target.name, path: target.path, size: fileSize(target.size), offset: 0, agentOffset: 0,
        status: 'transferring', phase: 'browser-upload', error: null, sha256: null }, { target }, `upload:${body.planId}:${body.index}`);
      return { task: task.view };
    });
    app.post<{ Body: { path: string; requestId: string } }>('/api/node-tools/files/downloads', async (request) => {
      const page = this.page(request); const body = request.body;
      if (!body || typeof body.requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(body.requestId)) throw failure('下载请求无效');
      const old = [...this.tasks.values()].find((task) => task.pageId === page.id && task.identityKey === `download:${body.requestId}`);
      if (old) return { task: old.view };
      const source = await this.rpc(page.nodeId, (requestId) => ({ action: 'files.stat', requestId, path: body.path })) as NodeDownloadSource;
      if (!source || !source.identity) throw failure('节点文件结果无效');
      const task = await this.allocate(page, { id: randomUUID(), direction: 'download', name: source.name, path: source.path, size: fileSize(source.size), offset: 0, agentOffset: 0,
        status: 'transferring', phase: 'node-download', error: null, sha256: null }, { source }, `download:${body.requestId}`);
      if (!task.started && !ended.has(task.view.status)) {
        task.started = true;
        if (!this.send(page.nodeId, { action: 'files.download', id: task.view.id, source, url: `${this.options.publicOrigin}/agent/node-files/${task.view.id}`, token: task.token })) this.failTask(task, '节点已离线');
      }
      return { task: task.view };
    });
    app.get<{ Params: { id: string } }>('/api/node-tools/tasks/:id', async (request) => ({ task: this.browserTask(request, request.params.id).view }));
    app.put<{ Params: { id: string; offset: string } }>('/api/node-tools/tasks/:id/chunks/:offset', { onRequest: async (request) => this.reserveChunk(request, false), onResponse: async (request) => this.releaseChunk(request) }, async (request) => {
      const task = this.browserTask(request, request.params.id);
      if (task.view.direction !== 'upload') throw failure('文件传输方向无效');
      return this.receiveChunk(task, Number(request.params.offset), request.body, request.headers['x-chunk-sha256']);
    });
    app.post<{ Params: { id: string }; Body: { sha256: string } }>('/api/node-tools/tasks/:id/finalize', async (request) => {
      const task = this.browserTask(request, request.params.id);
      if (task.view.direction !== 'upload') throw failure('文件传输方向无效');
      await this.finalize(task, request.body?.sha256); return { task: task.view };
    });
    app.delete<{ Params: { id: string } }>('/api/node-tools/tasks/:id', async (request) => {
      const task = this.browserTask(request, request.params.id); this.cancelTask(task); return { task: task.view };
    });
    app.get<{ Params: { id: string } }>('/api/node-tools/tasks/:id/content', async (request, reply) => {
      const task = this.browserTask(request, request.params.id, true);
      if (task.view.direction !== 'download' || task.view.status !== 'ready') throw failure('下载尚未准备完成', 409);
      return this.serve(task, request, reply, true);
    });
    app.get<{ Params: { id: string } }>('/agent/node-files/:id', async (request) => {
      const task = this.agentTask(request, request.params.id);
      if (task.view.direction !== 'download') throw failure('文件传输方向无效');
      return { offset: task.view.offset };
    });
    app.put<{ Params: { id: string; offset: string } }>('/agent/node-files/:id/chunks/:offset', { onRequest: async (request) => this.reserveChunk(request, true), onResponse: async (request) => this.releaseChunk(request) }, async (request) => {
      const task = this.agentTask(request, request.params.id);
      if (task.view.direction !== 'download') throw failure('文件传输方向无效');
      return this.receiveChunk(task, Number(request.params.offset), request.body, request.headers['x-chunk-sha256']);
    });
    app.post<{ Params: { id: string }; Body: { sha256: string } }>('/agent/node-files/:id/finalize', async (request) => {
      const task = this.agentTask(request, request.params.id);
      if (task.view.direction !== 'download') throw failure('文件传输方向无效');
      await this.finalize(task, request.body?.sha256); return { offset: task.view.offset };
    });
    app.get<{ Params: { id: string } }>('/agent/node-files/:id/content', async (request, reply) => {
      const task = this.agentTask(request, request.params.id);
      if (task.view.direction !== 'upload') throw failure('文件传输方向无效');
      return this.serve(task, request, reply, false);
    });
  }
}
