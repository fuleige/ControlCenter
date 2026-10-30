import { once } from 'node:events';
import { test, expect } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { AgentConnections } from './connections.js';

test('reports only an open registered node connection as available', async () => {
  const connections = new AgentConnections();
  expect(connections.has('missing-node')).toBe(false);

  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let client: WebSocket | undefined;
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    const accepted = once(server, 'connection');
    client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(client, 'open');
    const [peer] = await accepted as [WebSocket];
    connections.set('test-node', 'test-boot', peer);
    expect(connections.has('test-node')).toBe(true);
    expect(connections.has('missing-node')).toBe(false);

    const closed = once(peer, 'close');
    peer.close();
    expect(connections.has('test-node')).toBe(false);
    await closed;
    expect(connections.has('test-node')).toBe(false);
    connections.remove('test-node', peer);
    expect(connections.has('test-node')).toBe(false);
  } finally {
    client?.terminate();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('answers quota reads from the requested node and fails them when it disconnects', async () => {
  const connections = new AgentConnections();
  await expect(connections.readQuota('test-node', 1_000)).rejects.toThrow('节点当前离线');

  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let client: WebSocket | undefined;
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    const accepted = once(server, 'connection');
    client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(client, 'open');
    const [peer] = await accepted as [WebSocket];
    connections.set('test-node', 'test-boot', peer);

    const firstRequest = once(client, 'message');
    const answered = connections.readQuota('test-node', 1_000);
    const [first] = await firstRequest as [Buffer];
    const { requestId } = JSON.parse(first.toString()) as { type: string; requestId: string };
    expect(connections.resolveAgentReply('other-node', { type: 'agent.quota', requestId, ok: true })).toBe(false);
    expect(connections.resolveAgentReply('test-node', { type: 'agent.quotaReset', requestId, ok: true })).toBe(false);
    expect(connections.resolveAgentReply('test-node', { type: 'agent.quota', requestId, ok: false, error: 'boom' })).toBe(true);
    await expect(answered).resolves.toMatchObject({ ok: false, error: 'boom' });

    const resetRequest = once(client, 'message');
    const reset = connections.resetQuota('test-node', 'attempt-1', 'credit-1', 1_000);
    const [resetMessage] = await resetRequest as [Buffer];
    const sent = JSON.parse(resetMessage.toString()) as { type: string; requestId: string; idempotencyKey: string; creditId: string };
    expect(sent).toMatchObject({ type: 'control.quotaReset', idempotencyKey: 'attempt-1', creditId: 'credit-1' });
    expect(connections.resolveAgentReply('test-node', { type: 'agent.quotaReset', requestId: sent.requestId, ok: true, outcome: 'reset' })).toBe(true);
    await expect(reset).resolves.toMatchObject({ outcome: 'reset' });

    const pending = connections.readQuota('test-node', 1_000);
    connections.remove('test-node', peer);
    await expect(pending).rejects.toThrow('节点已离线');
  } finally {
    client?.terminate();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
