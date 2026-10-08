import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentPackageDownloadLinks, agentPackageLogUrl, registerAgentPackageDownloadLinks } from './agent-package-download.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cc-agent-download-')); directories.push(directory);
  const linux = 'controller-center-agent-v0.3.18-linux-x64-glibc.tar.gz';
  const mac = 'controller-center-agent-v0.3.18-darwin-arm64.tar.gz';
  writeFileSync(path.join(directory, linux), 'linux-package'); writeFileSync(path.join(directory, mac), 'mac-package');
  let clock = Date.now(); const links = new AgentPackageDownloadLinks(() => clock);
  const app = Fastify();
  registerAgentPackageDownloadLinks(app, { directory, version: '0.3.18', publicOrigin: 'https://center.example', links,
    authorized: request => request.headers.authorization === 'Bearer private-admin-token' });
  const issue = (target: string) => app.inject({ method: 'POST', url: '/api/agent-package/download-link',
    headers: { authorization: 'Bearer private-admin-token' }, payload: { target } });
  return { app, directory, linux, mac, links, issue, expire: () => { clock += 60 * 60 * 1000; } };
}

describe('temporary Agent package downloads', () => {
  it('requires administrator authorization to issue links and preserves the selected platform', async () => {
    const { app, issue, mac } = fixture();
    try {
      expect((await app.inject({ method: 'POST', url: '/api/agent-package/download-link', payload: { target: 'darwin-arm64' } })).statusCode).toBe(401);
      expect((await issue('darwin-x64')).statusCode).toBe(404);
      expect((await issue('../secret')).statusCode).toBe(400);
      const response = await issue('darwin-arm64'); expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('private-admin-token');
      const link = response.json<{ url: string; expiresAt: string; fileName: string }>();
      expect(link.fileName).toBe(mac); expect(new URL(link.url).origin).toBe('https://center.example');
      expect(Date.parse(link.expiresAt)).toBeGreaterThan(Date.now());
      const download = await app.inject(new URL(link.url).pathname);
      expect(download.statusCode).toBe(200); expect(download.body).toBe('mac-package');
      expect(download.headers['content-disposition']).toBe(`attachment; filename="${mac}"`);
      expect(download.headers['cache-control']).toContain('no-store');
      expect((await app.inject({ method: 'HEAD', url: new URL(link.url).pathname })).body).toBe('');
      expect((await app.inject(new URL(link.url).pathname)).body).toBe('mac-package');
    } finally { await app.close(); }
  });
  it('rejects tampering, another filename, expired links and links issued by an earlier process', async () => {
    const { app, issue, linux, links, expire } = fixture();
    try {
      const { url } = (await issue('darwin-arm64')).json<{ url: string }>();
      const pathname = new URL(url).pathname; const parts = pathname.split('/');
      const ticket = parts[4]!;
      expect(links.read(ticket)?.target).toBe('darwin-arm64');
      expect(new AgentPackageDownloadLinks().read(ticket)).toBeNull();
      expect((await app.inject(pathname.replace(parts.at(-1)!, linux))).statusCode).toBe(410);
      const forged = `${ticket[0] === 'a' ? 'b' : 'a'}${ticket.slice(1)}`;
      expect((await app.inject(pathname.replace(ticket, forged))).statusCode).toBe(410);
      expect((await app.inject(pathname.replace(ticket, 'invalid'))).statusCode).toBe(410);
      expect(agentPackageLogUrl(pathname)).not.toContain(ticket);
      expect(agentPackageLogUrl('/api/agent-package')).toBe('/api/agent-package');
      expire(); expect((await app.inject(pathname)).statusCode).toBe(410);
    } finally { await app.close(); }
  });
  it('invalidates a link when its artifact is replaced or removed', async () => {
    const { app, issue, directory, linux } = fixture();
    try {
      const { url } = (await issue('linux-x64-glibc')).json<{ url: string }>();
      const pathname = new URL(url).pathname;
      writeFileSync(path.join(directory, linux), 'changed-package');
      expect((await app.inject(pathname)).statusCode).toBe(410);
      const renewed = (await issue('linux-x64-glibc')).json<{ url: string }>();
      expect((await app.inject(new URL(renewed.url).pathname)).body).toBe('changed-package');
      rmSync(path.join(directory, linux));
      expect((await app.inject(new URL(renewed.url).pathname)).statusCode).toBe(410);
    } finally { await app.close(); }
  });
});
