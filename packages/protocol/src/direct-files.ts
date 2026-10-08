/** Ordered, reliable DataChannel RPC. One acknowledged 1 MiB chunk is in flight.
 * Frames are bounded by the negotiated SCTP limit, including JSON metadata.
 * This module is shared by the browser and Agent and has no Node dependencies. */
export const DIRECT_CHUNK_BYTES = 1024 ** 2;
export const DIRECT_FRAME_BYTES = 16 * 1024;
export class DirectConnectionError extends Error {
  constructor(message = '直连通道已中断') { super(message); this.name = 'DirectConnectionError'; }
}
export interface DirectWireAdapter {
  send(value: string | Uint8Array): void;
  buffered(): number;
  maximum(): number;
  open(): boolean;
  close?(): void;
}
export type DirectFields = Record<string, unknown>;
type Handler = (value: DirectFields, bytes: Uint8Array | undefined) => Promise<DirectFields>;
export class DirectWire {
  private readonly pending = new Map<string, { resolve: (value: DirectFields) => void; reject: (error: Error) => void }>();
  private outgoing = Promise.resolve();
  private incoming: { value: DirectFields; bytes: Uint8Array; offset: number } | null = null;
  private processing = false;
  private closed = false;
  constructor(private readonly adapter: DirectWireAdapter, private readonly handler: Handler) {}
  private async send(value: string | Uint8Array, signal: AbortSignal): Promise<void> {
    while (this.adapter.buffered() > 256 * 1024) {
      signal.throwIfAborted();
      if (this.closed || !this.adapter.open()) throw new DirectConnectionError();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    signal.throwIfAborted();
    if (this.closed || !this.adapter.open()) throw new DirectConnectionError();
    if ((typeof value === 'string' ? new TextEncoder().encode(value).length : value.byteLength) > this.adapter.maximum()) throw new Error('直连帧超过协商大小');
    try { this.adapter.send(value); } catch { throw new DirectConnectionError('直连发送失败'); }
  }
  async request(value: DirectFields, signal: AbortSignal, bytes?: Uint8Array): Promise<DirectFields> {
    if (this.closed || !this.adapter.open()) throw new DirectConnectionError();
    if (this.pending.size >= 8 || (bytes && bytes.length > DIRECT_CHUNK_BYTES)) throw new Error('直连请求超过限制');
    const id = crypto.randomUUID();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    let abort!: () => void;
    const result = new Promise<DirectFields>((resolve, reject) => {
      abort = () => { this.pending.delete(id); reject(signal.aborted ? signal.reason : new DirectConnectionError('直连确认超时')); this.close(); };
      this.pending.set(id, { resolve, reject }); bounded.addEventListener('abort', abort, { once: true });
      if (bounded.aborted) abort();
    });
    const sending = this.outgoing.catch(() => undefined).then(async () => {
      await this.send(JSON.stringify({ ...value, rpc: id, length: bytes?.length || 0 }), bounded);
      if (bytes) for (let offset = 0; offset < bytes.length;) {
        const length = Math.min(DIRECT_FRAME_BYTES, this.adapter.maximum(), bytes.length - offset);
        if (length < 1) throw new Error('直连消息大小无效');
        await this.send(bytes.subarray(offset, offset + length), bounded); offset += length;
      }
    });
    this.outgoing = sending;
    void sending.catch((error: Error) => { this.pending.get(id)?.reject(error); this.pending.delete(id); this.close(); });
    try { return await result; } finally { bounded.removeEventListener('abort', abort); this.pending.delete(id); }
  }
  receive(raw: string | Uint8Array): void {
    if (this.closed) return;
    try {
      if (typeof raw !== 'string') {
        const current = this.incoming;
        if (!current || !raw.length || raw.length > DIRECT_FRAME_BYTES || current.offset + raw.length > current.bytes.length) throw new Error('直连分片帧无效');
        current.bytes.set(raw, current.offset); current.offset += raw.length;
        if (current.offset === current.bytes.length) { this.incoming = null; void this.dispatch(current.value, current.bytes); }
        return;
      }
      if (raw.length > 4096 || this.incoming) throw new Error('直连元数据无效');
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('直连消息无效');
      const message = value as DirectFields;
      if (typeof message.reply === 'string') {
        const pending = this.pending.get(message.reply);
        if (!pending) return;
        this.pending.delete(message.reply);
        if (typeof message.error === 'string') pending.reject(message.errorKind === 'connection' ? new DirectConnectionError(message.error) : new Error(message.error)); else pending.resolve(message);
        return;
      }
      if (typeof message.rpc !== 'string' || message.rpc.length > 64 || !Number.isSafeInteger(message.length) || (message.length as number) < 0 || (message.length as number) > DIRECT_CHUNK_BYTES || this.processing) throw new Error('直连请求格式或队列无效');
      this.processing = true;
      if (message.length) this.incoming = { value: message, bytes: new Uint8Array(message.length as number), offset: 0 };
      else void this.dispatch(message, undefined);
    } catch { this.close(new DirectConnectionError('直连协议校验失败')); }
  }
  private async dispatch(value: DirectFields, bytes: Uint8Array | undefined): Promise<void> {
    try {
      let response: DirectFields;
      try { response = await this.handler(value, bytes); }
      catch (error) { response = { error: error instanceof Error ? error.message : '直连文件处理失败', errorKind: error instanceof DirectConnectionError ? 'connection' : 'business' }; }
      // Release the receiver before the ACK lets the sender begin another chunk.
      this.processing = false;
      await this.send(JSON.stringify({ ...response, reply: value.rpc }), AbortSignal.timeout(5000));
    } catch { this.close(); }
  }
  close(error = new DirectConnectionError()): void {
    if (this.closed) return;
    this.closed = true; this.incoming = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    try { this.adapter.close?.(); } catch { /* the channel may already be closed */ }
  }
}
