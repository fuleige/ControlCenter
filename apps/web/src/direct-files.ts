import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DirectWire, DirectConnectionError, DIRECT_CHUNK_BYTES, type NodeFileSignal, type NodeFileTaskView, type DirectFields } from '@controller-center/protocol';
import { FilePageApi, delay } from './node-tools-api';
import { API_URL, formatErrorMessage } from './api';
import { DirectDiagnostics, type DirectDiagnosticReport, type DirectStage } from './direct-diagnostics';

export interface LocalFileHandle {
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<LocalWritable>;
}
export interface LocalWritable { write(bytes: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
export interface LocalDirectoryHandle {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<LocalFileHandle>;
}
type Pickers = Window & {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<LocalFileHandle>;
  showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<LocalDirectoryHandle>;
};
export const filePickers = () => window as Pickers;
export function canSaveDirect(batch: boolean): boolean {
  return window.isSecureContext && typeof (batch ? filePickers().showDirectoryPicker : filePickers().showSaveFilePicker) === 'function';
}
export function localIdentity(file: File): string { return `${file.size}:${file.lastModified}`; }
class StreamConnectionError extends Error {}
/** Resume only the same immutable relay snapshot and already-written prefix. */
export async function saveRelayFile(api: FilePageApi, task: NodeFileTaskView, stream: LocalWritable, signal: AbortSignal, progress: (offset: number) => void): Promise<string> {
  const hash = sha256.create(); let offset = 0; let attempts = 0;
  for (;;) {
    signal.throwIfAborted();
    try {
      let response: Response;
      try { response = await fetch(`${API_URL}/api/node-tools/tasks/${task.id}/content`, { credentials: 'include', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: { 'X-Node-Page': api.id, ...(offset ? { Range: `bytes=${offset}-`, 'If-Range': `"${task.sha256}"` } : {}) } }); }
      catch (error) { signal.throwIfAborted(); throw new StreamConnectionError(error instanceof Error ? error.message : '中转连接中断'); }
      if (!response.body || response.status !== (offset ? 206 : 200) || response.headers.get('etag') !== `"${task.sha256}"` || response.headers.get('content-length') !== String(task.size - offset) || (offset && response.headers.get('content-range') !== `bytes ${offset}-${task.size - 1}/${task.size}`)) { await response.body?.cancel(); throw new Error('中转下载响应或快照身份不一致'); }
      const reader = response.body.getReader();
      try {
        for (;;) {
          let received: ReadableStreamReadResult<Uint8Array>;
          try { received = await reader.read(); } catch { signal.throwIfAborted(); if (offset === task.size) break; throw new StreamConnectionError('中转下载连接中断'); }
          if (received.done) break;
          if (offset + received.value.length > task.size) throw new Error('下载文件超过声明大小');
          for (let start = 0; start < received.value.length; start += DIRECT_CHUNK_BYTES) {
            const bytes = received.value.subarray(start, start + DIRECT_CHUNK_BYTES);
            await stream.write(bytes); signal.throwIfAborted(); hash.update(bytes); offset += bytes.length; progress(offset);
          }
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (offset !== task.size) throw new StreamConnectionError('中转下载响应提前结束');
      const checksum = bytesToHex(hash.digest()); if (checksum !== task.sha256) throw new Error('中转保存整体校验失败'); return checksum;
    } catch (error) {
      if (!(error instanceof StreamConnectionError) || ++attempts > 5 || signal.aborted) throw error;
      await delay(Math.min(5000, 500 * 2 ** attempts), signal);
    }
  }
}

export class BrowserDirectFiles {
  private connection: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private wire: DirectWire | null = null;
  private connectionId = '';
  private incoming = Promise.resolve();
  private candidates: RTCIceCandidateInit[] = [];
  private download: { id: string; handler: (value: DirectFields, bytes?: Uint8Array) => Promise<DirectFields>; reject: (error: Error) => void; disconnected: () => void } | null = null;
  private ready = false;
  private diagnostics: DirectDiagnostics | null = null;
  private probeController: AbortController | null = null;
  private rejectConnection: ((error: Error) => void) | null = null;
  constructor(private readonly api: FilePageApi, private readonly stunUrls: string[], private readonly status: (ready: boolean, message: string, report?: DirectDiagnosticReport) => void) {}
  get available(): boolean { return this.ready && this.channel?.readyState === 'open'; }
  private publish(): void {
    if (!this.diagnostics) return;
    if (this.connection) this.diagnostics.states(this.connection, this.channel);
    const report = this.diagnostics.report(); this.status(this.available, report.summary, report);
  }
  private failConnection(error: unknown, stage?: DirectStage, preserveDownload = false): void {
    if (!this.diagnostics || this.diagnostics.outcome === 'failed') return;
    if (stage) this.diagnostics.stage = stage;
    if (this.connection) this.diagnostics.states(this.connection, this.channel);
    this.diagnostics.finish('failed', error instanceof Error ? formatErrorMessage(error, '直连').replace(/^直连失败：/, '') : '直连连接失败');
    const report = this.diagnostics.report();
    this.close(false, preserveDownload || Boolean(this.download));
    console.warn('[node-files] 直连失败', report);
    this.status(false, report.summary, report);
  }
  private async observeStunStats(pc: RTCPeerConnection, diagnostics: DirectDiagnostics): Promise<void> {
    try {
      const stats = await pc.getStats();
      if (this.connection !== pc) return;
      stats.forEach((value: { type: string; candidateType?: string; url?: string }) => {
        if (value.type === 'local-candidate' && value.candidateType === 'srflx' && value.url) diagnostics.stunObserved(value.url);
      });
      this.publish();
    } catch { /* Some browsers omit ICE candidate statistics; no availability is inferred. */ }
  }
  receive(event: { action: string; connectionId?: string; signal?: NodeFileSignal }): void {
    if (event.action === 'files.direct.closed') { this.failConnection(new DirectConnectionError('控制中心报告节点连接已断开，直连通道已关闭'), this.ready ? 'transfer' : 'signaling'); return; }
    if (event.connectionId !== this.connectionId || event.action !== 'files.direct.signal' || !event.signal) return;
    const signal = event.signal;
    this.incoming = this.incoming.then(async () => {
      const pc = this.connection; if (!pc || event.connectionId !== this.connectionId) return;
      if (signal.type === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        if (this.connection !== pc) return;
        if (this.diagnostics) {
          this.diagnostics.receivedAnswer = true; this.diagnostics.event('已收到节点协商响应');
          for (const line of signal.sdp.split(/\r?\n/)) if (line.startsWith('a=candidate:')) this.diagnostics.candidate('remote', line.slice(2));
        }
        for (const candidate of this.candidates.splice(0)) await pc.addIceCandidate(candidate);
      } else if (signal.type === 'candidate') {
        this.diagnostics?.candidate('remote', signal.candidate);
        const candidate = { candidate: signal.candidate, sdpMid: signal.mid };
        if (pc.remoteDescription) await pc.addIceCandidate(candidate); else this.candidates.push(candidate);
      }
      if (this.connection === pc) this.publish();
    }).catch((error) => { if (event.connectionId === this.connectionId && this.connection) this.failConnection(error, 'signaling'); });
  }
  async probe(preserveDownload = false): Promise<void> {
    this.close(false, preserveDownload);
    const diagnostics = new DirectDiagnostics(this.stunUrls); this.diagnostics = diagnostics;
    if (!window.isSecureContext || typeof RTCPeerConnection === 'undefined') { this.failConnection(new Error(!window.isSecureContext ? '当前页面不是安全上下文，请使用 HTTPS 或本机地址' : '当前浏览器不支持 WebRTC 直连')); return; }
    this.publish();
    const connectionId = crypto.randomUUID(); this.connectionId = connectionId; this.candidates = []; this.incoming = Promise.resolve();
    const controller = new AbortController(); this.probeController = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
    let openingTimer: number | undefined;
    let abortOpening: (() => void) | undefined;
    let offered!: () => void; let rejectOffer!: (error: unknown) => void;
    const offerSent = new Promise<void>((resolve, reject) => { offered = resolve; rejectOffer = reject; });
    void offerSent.catch(() => undefined);
    try {
      const pc = new RTCPeerConnection({ iceServers: this.stunUrls.map((url) => ({ urls: url })) }); this.connection = pc;
      const channel = pc.createDataChannel('node-files-v1', { ordered: true }); channel.binaryType = 'arraybuffer'; this.channel = channel;
      let signaling = offerSent;
      pc.onicecandidate = (event) => {
        if (this.connection !== pc) return;
        const candidate = event.candidate;
        if (!candidate) { this.publish(); void this.observeStunStats(pc, diagnostics); return; }
        diagnostics.candidate('local', candidate.candidate, (candidate as RTCIceCandidate & { url?: string | null }).url || (event as RTCPeerConnectionIceEvent & { url?: string | null }).url);
        this.publish();
        signaling = signaling.then(async () => { if (this.connection === pc) await this.api.directSignal(connectionId, { type: 'candidate', candidate: candidate.candidate, mid: candidate.sdpMid || '0' }, controller.signal); });
        void signaling.catch((error) => { if (this.connection === pc) this.failConnection(error, 'signaling', preserveDownload); });
      };
      pc.onicecandidateerror = (event) => {
        if (this.connection !== pc) return;
        if (diagnostics.stunError(event.url, event.errorCode, event.errorText)) {
          const server = diagnostics.report().stun.find((item) => item.url.toLowerCase().replace(/\?transport=udp$/, '') === event.url.toLowerCase().replace(/\?transport=udp$/, ''));
          console.warn('[node-files] STUN 探测异常', server);
        }
        this.publish();
      };
      const changed = () => {
        if (this.connection !== pc) return;
        this.publish();
        if (pc.iceGatheringState === 'complete') void this.observeStunStats(pc, diagnostics);
        if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') this.failConnection(new DirectConnectionError('WebRTC 网络连接失败'), this.ready ? 'transfer' : diagnostics.stage, preserveDownload);
      };
      pc.oniceconnectionstatechange = changed; pc.onconnectionstatechange = changed; pc.onicegatheringstatechange = changed;
      let rejectOpening!: (error: Error) => void;
      const opened = new Promise<void>((resolve, reject) => {
        rejectOpening = reject;
        this.rejectConnection = reject;
        abortOpening = () => reject(signal.reason);
        signal.addEventListener('abort', abortOpening, { once: true });
        channel.onopen = () => { if (this.connection === pc) { diagnostics.event('数据通道已建立'); this.publish(); resolve(); } };
        channel.onclose = () => { if (this.channel === channel) this.failConnection(new DirectConnectionError('数据通道已关闭'), this.ready ? 'transfer' : diagnostics.stage, preserveDownload); };
        channel.onerror = () => { if (this.channel === channel) this.failConnection(new DirectConnectionError('数据通道发生错误'), this.ready ? 'transfer' : diagnostics.stage, preserveDownload); };
      });
      void opened.catch(() => undefined);
      diagnostics.stage = 'signaling'; diagnostics.event('正在发送直连协商请求');
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      signal.throwIfAborted();
      const { token } = await this.api.directSignal(connectionId, { type: 'offer', sdp: offer.sdp! }, signal); offered();
      diagnostics.stage = 'connecting'; diagnostics.event('控制中心已接受协商，正在等待两端通道'); this.publish();
      openingTimer = window.setTimeout(() => rejectOpening(new DirectConnectionError('两端建连超时（8 秒）')), 8000);
      await opened; window.clearTimeout(openingTimer); this.rejectConnection = null;
      if (this.connection !== pc) throw new DirectConnectionError();
      diagnostics.stage = 'authorization'; diagnostics.event('正在验证节点通道授权');
      const wire = new DirectWire({
        send: (value) => { if (typeof value === 'string') channel.send(value); else channel.send(value as Uint8Array<ArrayBuffer>); },
        buffered: () => channel.bufferedAmount, maximum: () => Math.min(16 * 1024, pc.sctp?.maxMessageSize || 16 * 1024), open: () => channel.readyState === 'open',
        close: () => channel.close(),
      }, async (value, bytes) => {
        if (!this.download || value.id !== this.download.id) throw new Error('直连下载任务已结束或不属于此页面');
        return this.download.handler(value, bytes);
      });
      this.wire = wire;
      channel.onmessage = ({ data }) => wire.receive(typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer));
      const ping = crypto.randomUUID(); const result = await wire.request({ kind: 'probe', token, ping }, AbortSignal.any([signal, AbortSignal.timeout(5000)]));
      if (result.pong !== ping) throw new Error('直连探测校验失败');
      for (let attempt = 0; attempt < 50; attempt++) {
        const state = await this.api.directStatus(signal);
        if (state.ready && state.connectionId === connectionId) {
          if (this.connection !== pc || channel.readyState !== 'open') throw new DirectConnectionError();
          this.ready = true; diagnostics.finish('ready'); this.publish(); void this.observeStunStats(pc, diagnostics); return;
        }
        await delay(50, signal);
      }
      throw new DirectConnectionError('直连授权确认超时');
    } catch (error) {
      rejectOffer(error); if (this.diagnostics === diagnostics && !controller.signal.aborted) this.failConnection(error, undefined, preserveDownload);
    } finally {
      window.clearTimeout(openingTimer);
      if (abortOpening) signal.removeEventListener('abort', abortOpening);
    }
  }
  private requireWire(): DirectWire { if (!this.available || !this.wire) throw new DirectConnectionError(this.diagnostics?.outcome === 'failed' ? this.diagnostics.report().summary : '直连通道不可用，请重试直连或确认改用中转'); return this.wire; }
  private async reconnect(task: NodeFileTaskView, token: string, signal: AbortSignal, preserveDownload: boolean): Promise<number> {
    signal.throwIfAborted(); await this.probe(preserveDownload); signal.throwIfAborted();
    const wire = this.requireWire(); await this.api.resume(task.id, signal);
    const result = await wire.request({ kind: 'start', id: task.id, token }, signal);
    if (!Number.isSafeInteger(result.offset) || Number(result.offset) < 0 || Number(result.offset) > task.size) throw new Error('直连续传确认位置无效');
    return result.offset as number;
  }
  async upload(task: NodeFileTaskView, token: string, file: File, signal: AbortSignal, progress: (offset: number) => void): Promise<void> {
    let offset = 0; let attempts = 0;
    const recover = async () => { if (++attempts > 2) throw new DirectConnectionError('直连重试已用尽，请选择重试直连、改用中转或取消'); return await this.reconnect(task, token, signal, false); };
    try { await this.requireWire().request({ kind: 'start', id: task.id, token }, signal); } catch (error) { if (!(error instanceof DirectConnectionError)) throw error; offset = await recover(); }
    while (offset < file.size) {
      signal.throwIfAborted(); const bytes = new Uint8Array(await file.slice(offset, offset + DIRECT_CHUNK_BYTES).arrayBuffer());
      try {
        const result = await this.requireWire().request({ kind: 'chunk', id: task.id, token, offset, sha256: bytesToHex(sha256(bytes)) }, signal, bytes);
        if (result.offset !== offset + bytes.length) throw new Error('节点确认位置不一致'); offset += bytes.length;
      } catch (error) {
        if (!(error instanceof DirectConnectionError)) throw error;
        const resumed = await recover();
        if (resumed < offset || resumed > offset + bytes.length) throw new Error('节点续传位置与已发送内容不一致'); offset = resumed;
      }
      progress(offset);
    }
    const hash = sha256.create();
    for (let start = 0; start < file.size; start += DIRECT_CHUNK_BYTES) { signal.throwIfAborted(); hash.update(new Uint8Array(await file.slice(start, start + DIRECT_CHUNK_BYTES).arrayBuffer())); }
    const checksum = bytesToHex(hash.digest());
    for (;;) {
      try {
        const result = await this.requireWire().request({ kind: 'finish', id: task.id, token, sha256: checksum }, signal);
        if (result.sha256 !== checksum || result.committed !== true) throw new Error('节点文件提交确认无效'); return;
      } catch (error) {
        if (!(error instanceof DirectConnectionError)) throw error;
        const current = (await this.api.task(task.id, signal)).task;
        if (current.status === 'completed' && current.sha256 === checksum) return;
        if (current.status === 'committing') throw new Error('提交结果不确定，请检查节点目标文件');
        await recover();
      }
    }
  }
  async downloadTo(task: NodeFileTaskView, token: string, stream: LocalWritable, signal: AbortSignal, progress: (offset: number) => void): Promise<string> {
    const wire = this.requireWire(); const hash = sha256.create(); let offset = 0; let interrupted = false; let attempts = 0;
    let finalHash: string | null = null; let last: { offset: number; size: number; hash: string } | null = null;
    let resolve!: (hash: string) => void; let reject!: (error: Error) => void;
    const completed = new Promise<string>((yes, no) => { resolve = yes; reject = no; }); void completed.catch(() => undefined);
    const abort = () => reject(signal.reason as Error); signal.addEventListener('abort', abort, { once: true });
    this.download = { id: task.id, reject, disconnected: () => { interrupted = true; }, handler: async (value, bytes) => {
      try {
        signal.throwIfAborted();
        if (value.kind === 'chunk') {
          if (!bytes || !bytes.length || typeof value.offset !== 'number' || value.offset % DIRECT_CHUNK_BYTES !== 0 || bytes.length !== Math.min(DIRECT_CHUNK_BYTES, task.size - value.offset) || bytesToHex(sha256(bytes)) !== value.sha256) throw new Error('下载分片校验失败');
          if (last && value.offset === last.offset && bytes.length === last.size && value.sha256 === last.hash && offset === last.offset + last.size) return { offset };
          if (value.offset !== offset || offset + bytes.length > task.size) throw new Error('下载分片大小或位置不一致');
          await stream.write(bytes); signal.throwIfAborted(); hash.update(bytes); last = { offset, size: bytes.length, hash: value.sha256 as string }; offset += bytes.length; progress(offset); return { offset };
        }
        if (value.kind !== 'finish' || offset !== task.size || value.size !== task.size) throw new Error('下载文件大小不一致');
        const checksum = finalHash || bytesToHex(hash.digest()); if (checksum !== value.sha256) throw new Error('下载文件整体校验失败'); finalHash = checksum;
        resolve(checksum); return { sha256: checksum };
      } catch (error) { reject(error as Error); throw error; }
    } };
    try {
      try { await wire.request({ kind: 'start', id: task.id, token }, signal); } catch (error) { if (!(error instanceof DirectConnectionError)) throw error; interrupted = true; }
      for (;;) {
        signal.throwIfAborted();
        if (finalHash) { const current = (await this.api.task(task.id, signal)).task; if (current.status === 'ready' && current.sha256 === finalHash) return finalHash; if (['failed', 'cancelled'].includes(current.status)) throw current.errorKind === 'connection' ? new DirectConnectionError(current.error || '直连任务已结束') : new Error(current.error || '直连任务已结束'); }
        if (interrupted || !this.available) { if (++attempts > 2) throw new DirectConnectionError('直连重试已用尽'); await this.reconnect(task, token, signal, true); interrupted = false; }
        await Promise.race([delay(100, signal), ...(finalHash ? [] : [completed])]);
      }
    }
    finally { signal.removeEventListener('abort', abort); this.download = null; }
  }
  close(notify = true, preserveDownload = false): void {
    const pc = this.connection; const channel = this.channel;
    if (notify && this.diagnostics) { if (pc) this.diagnostics.states(pc, channel); this.diagnostics.finish('closed'); }
    this.connection = null; this.channel = null;
    if (pc) { pc.onicecandidate = null; pc.onicecandidateerror = null; pc.oniceconnectionstatechange = null; pc.onconnectionstatechange = null; pc.onicegatheringstatechange = null; }
    if (channel) { channel.onopen = null; channel.onclose = null; channel.onerror = null; channel.onmessage = null; }
    this.rejectConnection?.(new DirectConnectionError()); this.rejectConnection = null;
    this.probeController?.abort(); this.probeController = null;
    this.ready = false; this.wire?.close(); this.wire = null;
    if (!preserveDownload) { this.download?.reject(new DirectConnectionError()); this.download = null; }
    else this.download?.disconnected();
    pc?.close();
    if (notify) this.publish();
  }
}
