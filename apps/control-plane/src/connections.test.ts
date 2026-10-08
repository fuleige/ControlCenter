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
