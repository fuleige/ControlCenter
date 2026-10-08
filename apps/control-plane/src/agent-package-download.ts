import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AGENT_PACKAGE_TARGETS, findAgentPackage, listAgentPackages, type AgentPackageDescriptor } from './agent-package.js';

export const AGENT_PACKAGE_SHARED_PATH = '/api/agent-package/shared';
const linkLifetimeMs = 60 * 60 * 1000;
interface DownloadClaims { version: string; target?: string; sha256: string; expiresAt: number }

export function agentPackageLogUrl(url: string): string {
  return url.startsWith(`${AGENT_PACKAGE_SHARED_PATH}/`) ? `${AGENT_PACKAGE_SHARED_PATH}/[redacted]` : url;
}

/** Opaque, package-scoped tickets expire after one hour or a service restart. */
export class AgentPackageDownloadLinks {
  private readonly tickets = new Map<string, DownloadClaims>();
  constructor(private readonly clock: () => number = Date.now) {}
  issue(descriptor: AgentPackageDescriptor): { ticket: string; expiresAt: string } {
    const timestamp = this.clock();
    for (const [ticket, claims] of this.tickets) if (claims.expiresAt <= timestamp) this.tickets.delete(ticket);
    if (this.tickets.size >= 1024) throw Object.assign(new Error('有效下载链接过多，请稍后重试'), { statusCode: 429 });
    const expiresAt = timestamp + linkLifetimeMs;
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, { version: descriptor.version, ...(descriptor.target ? { target: descriptor.target } : {}), sha256: descriptor.sha256, expiresAt });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }
  read(ticket: string): DownloadClaims | null {
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
    const claims = this.tickets.get(ticket);
    if (!claims) return null;
    if (claims.expiresAt <= this.clock()) { this.tickets.delete(ticket); return null; }
    return claims;
  }
}

export function registerAgentPackageDownloadLinks(app: FastifyInstance, options: {
  directory: string; version: string; publicOrigin: string;
  authorized: (request: FastifyRequest) => boolean;
  links?: AgentPackageDownloadLinks;
}): void {
  const links = options.links ?? new AgentPackageDownloadLinks();
  app.post<{ Body: { target?: string } }>('/api/agent-package/download-link', {
    schema: { body: { type: 'object', additionalProperties: false, properties: { target: { type: 'string', enum: [...AGENT_PACKAGE_TARGETS] } } } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!options.authorized(request)) return reply.code(401).send({ error: '登录状态已失效' });
    const descriptor = request.body?.target ? findAgentPackage(options.directory, options.version, request.body.target)
      : listAgentPackages(options.directory, options.version)[0] ?? findAgentPackage(options.directory, options.version);
    if (!descriptor) return reply.code(404).send({ error: '所选客户端安装包尚未生成' });
    const { ticket, expiresAt } = links.issue(descriptor);
    const url = new URL(`${AGENT_PACKAGE_SHARED_PATH}/${ticket}/${descriptor.fileName}`, `${options.publicOrigin}/`).href;
    return { url, expiresAt, fileName: descriptor.fileName };
  });
  app.get<{ Params: { ticket: string; fileName: string } }>(`${AGENT_PACKAGE_SHARED_PATH}/:ticket/:fileName`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const claims = links.read(request.params.ticket);
    if (!claims || claims.version !== options.version) return reply.code(410).send({ error: '下载链接已失效，请在页面重新复制' });
    const descriptor = findAgentPackage(options.directory, claims.version, claims.target);
    if (!descriptor || descriptor.fileName !== request.params.fileName || descriptor.sha256 !== claims.sha256) {
      return reply.code(410).send({ error: '安装包已更新或移除，请在页面重新复制下载链接' });
    }
    reply.header('Content-Type', 'application/gzip');
    reply.header('Content-Length', String(descriptor.size));
    reply.header('Content-Disposition', `attachment; filename="${descriptor.fileName}"`);
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(createReadStream(descriptor.filePath));
  });
}
