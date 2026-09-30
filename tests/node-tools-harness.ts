import { createReadStream, existsSync, statSync } from 'node:fs';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NODE_FILES_CAPABILITY, TERMINAL_PTY_CAPABILITY, type NodeToolEvent, type ControlNodeToolMessage } from '@controller-center/protocol';
import { AgentConnections } from '../apps/control-plane/src/connections.js';
import { NodeTools } from '../apps/control-plane/src/node-tools.js';
import { NodeFiles } from '../apps/agent/src/node-files.js';
import { NodeTerminals } from '../apps/agent/src/node-terminals.js';
import { OutboundNetwork } from '../apps/agent/src/outbound-network.js';

export async function nodeToolsHarness(options: { leaseMs?: number; quotaBytes?: number; fileLimit?: number; webDirectory?: string } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cc-node-tools-'));
  const app = Fastify();
  await app.register(websocket);
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 2 * 1024 ** 2 }, (_req, body, done) => done(null, body));
  const sqlite = new DatabaseSync(path.join(directory, 'tasks.db'));
  const connections = new AgentConnections();
  const sessions = new Set(['one', 'two']);
  const session = (request: { headers: { cookie?: string } }) => {
    const id = /test-session=(one|two)/.exec(request.headers.cookie || '')?.[1];
    return id && sessions.has(id) ? { id, expiresAt: new Date(Date.now() + 60_000).toISOString() } : null;
  };
  let tools: NodeTools;
  app.get('/test/agent', { websocket: true }, (socket) => {
    connections.set('node', 'boot', socket, [NODE_FILES_CAPABILITY, TERMINAL_PTY_CAPABILITY]);
    tools.nodeConnected('node');
    socket.on('message', (raw) => { if (connections.isCurrent('node', socket)) tools.handleAgent('node', JSON.parse(raw.toString())); });
    socket.on('close', () => connections.remove('node', socket));
  });
  app.get('/api/auth/session', (request) => ({ authenticated: Boolean(session(request)) }));
  app.get('/api/nodes', () => ({ data: [{ id: 'node', name: '测试节点', status: 'online' }] }));
  if (options.webDirectory) app.get('/*', async (request, reply) => {
    const root = path.resolve(options.webDirectory!);
    const pathname = decodeURIComponent(new URL(request.url, 'http://test').pathname);
    let file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile()) file = path.join(root, 'index.html');
    reply.header('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
    return reply.send(createReadStream(file));
  });
  // Register first; resolve publicOrigin to the actual ephemeral port before any transfer starts.
  const toolOptions = { directory: path.join(directory, 'stage'), sqlite, connections, publicOrigin: '',
    allowedOrigins: ['http://127.0.0.1:5175', 'http://localhost:5175'], session,
    reserveBytes: 1, ...options };
  tools = new NodeTools(app, toolOptions);
  connections.onDisconnect = (nodeId) => tools.nodeDisconnected(nodeId);
  const origin = await app.listen({ host: '127.0.0.1', port: 0 }); toolOptions.publicOrigin = origin; toolOptions.allowedOrigins.push(origin);
  const network = new OutboundNetwork(true);
  let generation = '';
  let agent: WebSocket;
  const events: NodeToolEvent[] = [];
  let holdCompletion = false;
  const held: Array<{ event: NodeToolEvent; generation: string }> = [];
  const emit = (event: NodeToolEvent, current: string) => {
    events.push(event);
    if (current !== generation || agent?.readyState !== WebSocket.OPEN) return false;
    if (holdCompletion && event.action === 'files.complete') { held.push({ event, generation: current }); return true; }
    agent.send(JSON.stringify({ type: 'agent.nodeTool', generation: current, event })); return true;
  };
  const files = new NodeFiles(path.join(directory, 'agent-data'), directory, network, `${origin.replace('http:', 'ws:')}/agent/connect`, emit);
  const terminals = new NodeTerminals(directory, emit);
  if (!await terminals.initialize()) throw new Error('Test PTY unavailable');
  const reset = new Promise<void>((resolve) => {
    agent = new WebSocket(`${origin.replace('http:', 'ws:')}/test/agent`);
    agent.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as ControlNodeToolMessage;
      if (message.command.action === 'reset') { files.reset(); terminals.reset(); generation = message.generation; resolve(); }
      else if (message.generation === generation) {
        if (message.command.action.startsWith('terminal.')) terminals.handle(message.command as Parameters<NodeTerminals['handle']>[0], generation);
        else void files.handle(message.command as Parameters<NodeFiles['handle']>[0], generation);
      }
    });
  });
  await reset;
  async function request(endpoint: string, init: RequestInit = {}, pageId?: string) {
    const response = await fetch(`${origin}${endpoint}`, { ...init, headers: { Cookie: 'test-session=one', ...(pageId ? { 'X-Node-Page': pageId } : {}), ...init.headers as Record<string, string> } });
    return response;
  }
  async function page() {
    const response = await request('/api/node-tools/nodes/node/pages', { method: 'POST' });
    const { pageId } = await response.json() as { pageId: string };
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/node-tools/nodes/node/pages/${pageId}/connect`, { headers: { Cookie: 'test-session=one', Origin: origin } });
    await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
    return { id: pageId, socket };
  }
  return { pauseCompletions() { holdCompletion = true; }, releaseCompletions() { holdCompletion = false; for (const item of held.splice(0)) if (agent.readyState === WebSocket.OPEN) agent.send(JSON.stringify({ type: 'agent.nodeTool', ...item })); },
    app, origin, tools, directory, sqlite, files, terminals, events, sessions, request, page,
    async close() { await tools.close(); files.dispose(); terminals.dispose(); connections.closeAll(); agent!.terminate(); await network.destroy(); await app.close(); sqlite.close(); await rm(directory, { recursive: true, force: true }); } };
}
