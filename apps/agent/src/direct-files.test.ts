import { describe, expect, it, vi } from 'vitest';
import { DirectConnectionError, DirectWire, DIRECT_CHUNK_BYTES } from '@controller-center/protocol';
import { nativeFileChannelAdapter } from './direct-files.js';

describe('native direct file send buffering', () => {
  it('delivers a queued 1 MiB chunk once and waits for the receiver acknowledgement', async () => {
    let buffered = 0; let open = true; let sender!: DirectWire; let receiver!: DirectWire;
    const frames: Array<string | Uint8Array> = []; const received: Uint8Array[] = [];
    const enqueue = (value: string | Uint8Array) => {
      frames.push(value); const size = typeof value === 'string' ? value.length : value.length;
      buffered += size;
      setTimeout(() => { buffered -= size; receiver.receive(value); }, 1);
      return false;
    };
    const close = vi.fn(() => { open = false; });
    const adapter = nativeFileChannelAdapter({ sendMessage: enqueue, sendMessageBinary: enqueue,
      bufferedAmount: () => buffered, maxMessageSize: () => 16 * 1024, isOpen: () => open, close });
    sender = new DirectWire(adapter, async () => ({}));
    receiver = new DirectWire({ send: value => queueMicrotask(() => sender.receive(value)), buffered: () => 0,
      maximum: () => 16 * 1024, open: () => open }, async (value, bytes) => {
      if (value.kind === 'probe') return { pong: value.ping };
      received.push(bytes!); return { offset: bytes!.length };
    });
    try {
      expect(await sender.request({ kind: 'probe', ping: 'small-probe' }, AbortSignal.timeout(5000))).toMatchObject({ pong: 'small-probe' });
      const bytes = new Uint8Array(DIRECT_CHUNK_BYTES).fill(0x5a);
      expect(await sender.request({ kind: 'chunk', offset: 0 }, AbortSignal.timeout(5000), bytes)).toMatchObject({ offset: bytes.length });
      expect(received).toHaveLength(1); expect(received[0]).toEqual(bytes);
      expect(frames.filter(value => typeof value !== 'string')).toHaveLength(DIRECT_CHUNK_BYTES / (16 * 1024));
      expect(buffered).toBe(0); expect(close).not.toHaveBeenCalled(); expect(adapter.open()).toBe(true);
    } finally { sender.close(); receiver.close(); }
  });

  it('rejects an actual native send exception and closes the channel', async () => {
    const close = vi.fn();
    const fail = () => { throw new Error('native send failed'); };
    const wire = new DirectWire(nativeFileChannelAdapter({ sendMessage: fail, sendMessageBinary: fail,
      bufferedAmount: () => 0, maxMessageSize: () => 16 * 1024, isOpen: () => true, close }), async () => ({}));
    await expect(wire.request({ kind: 'probe' }, AbortSignal.timeout(5000))).rejects.toThrow(DirectConnectionError);
    expect(close).toHaveBeenCalledOnce();
  });
});
