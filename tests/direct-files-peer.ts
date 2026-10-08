import * as rtc from 'node-datachannel';
import { DirectWire, type DirectFields, type NodeFileSignal } from '@controller-center/protocol';
import type { nodeToolsHarness } from './node-tools-harness.js';
export async function directFilesPeer(harness: Awaited<ReturnType<typeof nodeToolsHarness>>, handler: (value: DirectFields, bytes?: Uint8Array) => Promise<DirectFields> = async () => ({}), existingPage?: Awaited<ReturnType<Awaited<ReturnType<typeof nodeToolsHarness>>['page']>>) {
  const page = existingPage || await harness.page(); const id = crypto.randomUUID();
  const pc = new rtc.PeerConnection(id, { iceServers: [], maxMessageSize: 16 * 1024 });
  let token = ''; let offered!: () => void; const offerSent = new Promise<void>((resolve) => { offered = resolve; });
  let signaling = offerSent;
  const post = async (signal: NodeFileSignal) => {
    const response = await harness.request('/api/node-tools/files/direct/signal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId: id, signal }) }, page.id);
    if (!response.ok) throw new Error(await response.text()); return await response.json() as { token: string };
  };
  pc.onLocalDescription((sdp, type) => { if (type === 'offer') void post({ type, sdp }).then((value) => { token = value.token; offered(); }); });
  pc.onLocalCandidate((candidate, mid) => { signaling = signaling.then(async () => { await post({ type: 'candidate', candidate, mid }); }); });
  page.socket.on('message', (raw) => {
    const event = JSON.parse(raw.toString()) as { action: string; connectionId: string; signal?: NodeFileSignal };
    if (event.connectionId !== id || event.action !== 'files.direct.signal' || !event.signal) return;
    if (event.signal.type === 'answer') pc.setRemoteDescription(event.signal.sdp, 'answer');
    else if (event.signal.type === 'candidate') pc.addRemoteCandidate(event.signal.candidate, event.signal.mid);
  });
  const channel = pc.createDataChannel('node-files-v1');
  const wire = new DirectWire({ send: (value) => { if (typeof value === 'string') channel.sendMessage(value); else channel.sendMessageBinary(value); }, buffered: () => channel.bufferedAmount(), maximum: () => channel.maxMessageSize(), open: () => channel.isOpen() }, handler);
  channel.onMessage((raw) => wire.receive(typeof raw === 'string' ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw));
  channel.onClosed(() => wire.close());
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native WebRTC handshake timed out')), 10_000);
    channel.onOpen(() => { clearTimeout(timer); resolve(); }); channel.onError((error) => { clearTimeout(timer); reject(new Error(error)); });
  });
  await offerSent; const ping = crypto.randomUUID();
  const response = await wire.request({ kind: 'probe', token, ping }, AbortSignal.timeout(5000));
  if (response.pong !== ping) throw new Error('Probe failed');
  for (let i = 0; i < 100; i++) {
    const state = await (await harness.request('/api/node-tools/files/direct', {}, page.id)).json() as { ready: boolean };
    if (state.ready) break; await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { page, wire, pc, close() { wire.close(); pc.close(); page.socket.close(); } };
}
