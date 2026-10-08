import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const targets = ['linux-x64-glibc', 'linux-arm64-glibc', 'linux-x64-musl', 'linux-arm64-musl', 'darwin-arm64', 'darwin-x64'];
const packageName = /^controller-center-agent(?:-source)?-v\d+\.\d+\.\d+[0-9A-Za-z.+-]*\.tar\.gz$/;

export function cleanupAgentPackages(directory, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('Invalid Agent package version');
  }
  const prefix = `controller-center-agent-v${version}`;
  const installationNames = new Set([`${prefix}.tar.gz`, ...targets.map(target => `${prefix}-${target}.tar.gz`)]);
  const currentNames = new Set([...installationNames, `controller-center-agent-source-v${version}.tar.gz`]);
  const entries = readdirSync(directory, { withFileTypes: true });
  if (!entries.some(entry => entry.isFile() && installationNames.has(entry.name) && statSync(path.join(directory, entry.name)).size > 0)) {
    throw new Error(`Agent v${version} installation package must exist before removing older packages`);
  }

  const removed = [];
  let removedBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !packageName.test(entry.name) || currentNames.has(entry.name)) continue;
    const location = path.join(directory, entry.name);
    try {
      const size = statSync(location).size;
      rmSync(location);
      removed.push(entry.name);
      removedBytes += size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { removed, removedBytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { version } = JSON.parse(readFileSync(path.join(repositoryRoot, 'apps/agent/package.json'), 'utf8'));
  const directory = path.resolve(process.env.AGENT_PACKAGE_OUTPUT_DIR || path.join(repositoryRoot, 'artifacts'));
  const result = cleanupAgentPackages(directory, version);
  process.stdout.write(`${JSON.stringify({ directory, keptVersion: version, ...result }, null, 2)}\n`);
}
