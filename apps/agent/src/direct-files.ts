import { timingSafeEqual } from 'node:crypto';
import type * as RTC from 'node-datachannel';
import { DirectWire, DirectConnectionError, NODE_TOOL_LEASE_MS, type DirectFields, type DirectWireAdapter, type NodeToolCommand, type NodeToolEvent } from '@controller-center/protocol';

type SignalCommand = Extract<NodeToolCommand, { action: 'files.direct.signal' }>;
export type DirectTaskCommand = Extract<NodeToolCommand, { action: 'files.direct.upload' | 'files.direct.download' }>;
interface Incoming { value: DirectFields; bytes?: Uint8Array; resolve: (value: DirectFields) => void; reject: (error: Error) => void }
interface Peer { id: string; pageId: string; generation: string; token: string; connection: RTC.PeerConnection; wire: DirectWire | null; authenticated: boolean; expires: number; candidates: number }
export function nativeFileChannelAdapter(channel: Pick<RTC.DataChannel, 'sendMessage' | 'sendMessageBinary' | 'bufferedAmount' | 'maxMessageSize' | 'isOpen' | 'close'>): DirectWireAdapter {
  return {
    // false means accepted into libdatachannel's send buffer, not a failed send.
    send: value => { if (typeof value === 'string') channel.sendMessage(value); else channel.sendMessageBinary(value); },
    buffered: () => channel.bufferedAmount(), maximum: () => Math.min(16 * 1024, channel.maxMessageSize()), open: () => channel.isOpen(),
    close: () => channel.close(),
  };
}
function matches(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export class DirectAgentTask {
  private waiting: ((value: Incoming) => void) | null = null;
  private queued: Incoming | null = null;
  private active: Incoming | null = null;
  private started = false;
  private stopped: Error | null = null;
  offset = 0;
  constructor(readonly command: DirectTaskCommand, readonly generation: string, private peer: Peer) {}
  accept(value: DirectFields, bytes?: Uint8Array): Promise<DirectFields> {
    if (this.stopped) return Promise.reject(this.stopped);
    if (value.kind === 'start') { this.started = true; return Promise.resolve({ offset: this.offset }); }
    if (!this.started || this.command.action !== 'files.direct.upload' || !['chunk', 'finish'].includes(String(value.kind))) return Promise.reject(new Error('直连任务方向或阶段无效'));
    return new Promise((resolve, reject) => {
      const incoming: Incoming = { value, ...(bytes ? { bytes } : {}), resolve, reject };
      if (this.waiting) { const waiting = this.waiting; this.waiting = null; waiting(incoming); }
      else if (!this.queued) this.queued = incoming;
      else reject(new Error('直连写入队列已满'));
    });
  }
  async ready(signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (!this.started) {
      signal.throwIfAborted(); if (this.stopped) throw this.stopped;
      if (Date.now() > deadline) throw new DirectConnectionError('直连任务启动超时');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  receive(signal: AbortSignal): Promise<Incoming> {
    signal.throwIfAborted(); if (this.stopped) return Promise.reject(this.stopped);
    if (this.queued) { const queued = this.queued; this.queued = null; this.active = queued; return Promise.resolve(queued); }
    return new Promise((resolve, reject) => {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
      const abort = () => { this.waiting = null; reject(signal.aborted ? signal.reason : new DirectConnectionError('直连分片等待超时')); };
      bounded.addEventListener('abort', abort, { once: true });
      this.waiting = (value) => { bounded.removeEventListener('abort', abort); this.active = value; resolve(value); };
      if (bounded.aborted) abort();
    });
  }
  async send(value: DirectFields, signal: AbortSignal, bytes?: Uint8Array): Promise<DirectFields> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted(); if (this.stopped) throw this.stopped;
      const peer = this.peer;
      try {
        if (!peer.wire || !peer.authenticated) throw new DirectConnectionError();
        return await peer.wire.request({ ...value, id: this.command.id }, signal, bytes);
      } catch (error) {
        if (!(error instanceof DirectConnectionError) || attempt >= 2) throw error;
        const deadline = Date.now() + 30_000;
        while (this.peer === peer || !this.started) {
          signal.throwIfAborted(); if (this.stopped) throw this.stopped;
          if (Date.now() >= deadline) throw new DirectConnectionError('直连重连续传超时');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    }
  }
  rebind(peer: Peer): void { this.peer = peer; this.command.connectionId = peer.id; this.started = false; }
  stop(error = new Error('文件任务已结束')): void { this.stopped = error; this.active?.reject(error); this.queued?.reject(error); this.queued = null; }
}

export class AgentDirectFiles {
  private library: typeof RTC | null = null;
  private readonly peers = new Map<string, Peer>();
  private readonly tasks = new Map<string, DirectAgentTask>();
  private readonly timer: NodeJS.Timeout;
  constructor(private readonly emit: (event: NodeToolEvent, generation: string) => boolean) {
    this.timer = setInterval(() => { for (const peer of this.peers.values()) if (peer.expires <= Date.now()) this.close(peer.pageId); }, 5000); this.timer.unref();
  }
  async initialize(): Promise<void> {
    try { const library = await import('node-datachannel'); library.preload(); this.library = library; }
    catch { console.warn('[agent] direct file transport unavailable; relay remains available'); }
  }
  get available(): boolean { return this.library !== null; }
  lease(pageId: string): void { const peer = this.peers.get(pageId); if (peer) peer.expires = Date.now() + NODE_TOOL_LEASE_MS; }
  signal(command: SignalCommand, generation: string): void {
    if (!this.library) return;
    if (!/^[a-f0-9-]{36}$/i.test(command.pageId) || !/^[a-f0-9-]{36}$/i.test(command.connectionId) || command.token.length > 128) return;
    let peer = this.peers.get(command.pageId);
    try {
      if (command.signal.type === 'offer') {
        if (command.signal.sdp.length > 64 * 1024 || (this.peers.size >= 128 && !this.peers.has(command.pageId))) throw new Error('直连协商超过限制');
        this.close(command.pageId);
        const connection = new this.library.PeerConnection(command.connectionId, { iceServers: command.stunUrls, maxMessageSize: 16 * 1024 });
        peer = { id: command.connectionId, pageId: command.pageId, generation, token: command.token, connection, wire: null, authenticated: false, expires: Date.now() + NODE_TOOL_LEASE_MS, candidates: 0 };
        this.peers.set(command.pageId, peer);
        const current = peer;
        connection.onLocalDescription((sdp, type) => { if (type === 'answer') this.emit({ action: 'files.direct.signal', pageId: current.pageId, connectionId: current.id, signal: { type, sdp } }, generation); });
        connection.onLocalCandidate((candidate, mid) => this.emit({ action: 'files.direct.signal', pageId: current.pageId, connectionId: current.id, signal: { type: 'candidate', candidate, mid } }, generation));
        connection.onDataChannel((channel) => {
          if (current.wire || channel.getLabel() !== 'node-files-v1') { channel.close(); return; }
          current.wire = new DirectWire(nativeFileChannelAdapter(channel), async (value, bytes) => {
            if (this.peers.get(current.pageId) !== current || current.generation !== generation || current.expires <= Date.now()) throw new Error('直连页面授权已失效');
            if (value.kind === 'probe' && matches(value.token, current.token)) {
              current.authenticated = true;
              this.emit({ action: 'files.direct.ready', pageId: current.pageId, connectionId: current.id }, generation);
              return { pong: value.ping };
            }
            if (!current.authenticated || typeof value.id !== 'string') throw new Error('直连通道尚未授权');
            let task = this.tasks.get(value.id);
            // Control commands precede the REST response, but RTC and WSS have independent delivery order.
            if (value.kind === 'start') for (let attempt = 0; (!task || task.command.connectionId !== current.id) && attempt < 100; attempt++) { await new Promise((resolve) => setTimeout(resolve, 20)); task = this.tasks.get(value.id); }
            if (!task || task.generation !== generation || task.command.connectionId !== current.id || task.command.pageId !== current.pageId || !matches(value.token, task.command.token)) throw new Error('直连任务令牌无效或已结束');
            return task.accept(value, bytes);
          });
          channel.onMessage((raw) => current.wire?.receive(typeof raw === 'string' ? raw : new Uint8Array(raw instanceof ArrayBuffer ? raw : raw.buffer, raw instanceof ArrayBuffer ? 0 : raw.byteOffset, raw instanceof ArrayBuffer ? raw.byteLength : raw.byteLength)));
          channel.onClosed(() => current.wire?.close()); channel.onError(() => current.wire?.close());
        });
        connection.setRemoteDescription(command.signal.sdp, 'offer');
      } else if (peer?.id === command.connectionId && peer.generation === generation && command.signal.type === 'candidate' && ++peer.candidates <= 128 && command.signal.candidate.length <= 2048) peer.connection.addRemoteCandidate(command.signal.candidate, command.signal.mid);
    } catch { this.close(command.pageId); }
  }
  register(command: DirectTaskCommand, generation: string): DirectAgentTask {
    const peer = this.peers.get(command.pageId);
    if (!peer || !peer.authenticated || peer.id !== command.connectionId || peer.generation !== generation) throw new DirectConnectionError('直连通道尚未就绪');
    const task = new DirectAgentTask(command, generation, peer); this.tasks.set(command.id, task); return task;
  }
  finish(id: string, error?: Error): void { this.tasks.get(id)?.stop(error); this.tasks.delete(id); }
  resume(command: Extract<NodeToolCommand, { action: 'files.direct.resume' }>, generation: string): void {
    const peer = this.peers.get(command.pageId); const task = this.tasks.get(command.id);
    if (!peer?.authenticated || peer.id !== command.connectionId || peer.generation !== generation || !task || task.generation !== generation || task.command.pageId !== command.pageId || !matches(command.token, task.command.token)) return;
    task.rebind(peer);
  }
  close(pageId: string): void { const peer = this.peers.get(pageId); if (!peer) return; this.peers.delete(pageId); peer.wire?.close(); peer.connection.close(); }
  reset(): void { for (const pageId of this.peers.keys()) this.close(pageId); for (const id of this.tasks.keys()) this.finish(id); }
  dispose(): void { clearInterval(this.timer); this.reset(); }
}
