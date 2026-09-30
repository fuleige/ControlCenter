import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const AGENT_PACKAGE_TARGETS = ['linux-x64-glibc', 'linux-arm64-glibc', 'linux-x64-musl', 'linux-arm64-musl', 'darwin-arm64', 'darwin-x64'] as const;
export interface AgentPackageDescriptor {
  version: string; fileName: string; filePath: string; size: number; sha256: string; builtAt: string; target?: string;
}
export function findAgentPackage(directory: string, version: string, target?: string): AgentPackageDescriptor | null {
  if (!/^[0-9A-Za-z.+-]+$/.test(version) || (target !== undefined && !(AGENT_PACKAGE_TARGETS as readonly string[]).includes(target))) return null;
  const fileName = `controller-center-agent-v${version}${target ? `-${target}` : ''}.tar.gz`;
  const filePath = path.join(directory, fileName);
  try {
    const status = statSync(filePath); if (!status.isFile()) return null;
    return { version, fileName, filePath, size: status.size,
      sha256: createHash('sha256').update(readFileSync(filePath)).digest('hex'), builtAt: status.mtime.toISOString(), ...(target ? { target } : {}) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export function listAgentPackages(directory: string, version: string): AgentPackageDescriptor[] {
  return AGENT_PACKAGE_TARGETS.flatMap((target) => { const found = findAgentPackage(directory, version, target); return found ? [found] : []; });
}
