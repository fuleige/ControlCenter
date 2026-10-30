import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const targets = ['linux-x64-glibc', 'linux-arm64-glibc', 'linux-x64-musl', 'linux-arm64-musl', 'darwin-arm64', 'darwin-x64'];
const packageName = /^controller-center-agent(-source)?-v(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)\.tar\.gz$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function parsePackageName(name) {
  const match = packageName.exec(name);
  if (!match) return null;
  const installation = !match[1];
  let version = match[2];
  const target = installation ? targets.find(candidate => version.endsWith(`-${candidate}`)) : undefined;
  if (target) version = version.slice(0, -target.length - 1);
  return { version, installation };
}

function versionParts(version) {
  const [core, prerelease = ''] = version.replace(/\+.*$/, '').split(/-(.*)/s);
  return { core: core.split('.').map(Number), prerelease: prerelease ? prerelease.split('.') : [] };
}

// Semantic version precedence, so 0.3.10 sorts after 0.3.9 and 1.0.0 after 1.0.0-rc.1.
export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (!a.prerelease.length || !b.prerelease.length) return b.prerelease.length - a.prerelease.length;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Keeps the current version and the closest older version that still has an
 * installation package, so one release can always be rolled back without
 * letting old archives accumulate.
 */
export function cleanupAgentPackages(directory, version) {
  if (!versionPattern.test(version)) {
    throw new Error('Invalid Agent package version');
  }
  const prefix = `controller-center-agent-v${version}`;
  const installationNames = new Set([`${prefix}.tar.gz`, ...targets.map(target => `${prefix}-${target}.tar.gz`)]);
  const entries = readdirSync(directory, { withFileTypes: true });
  if (!entries.some(entry => entry.isFile() && installationNames.has(entry.name) && statSync(path.join(directory, entry.name)).size > 0)) {
    throw new Error(`Agent v${version} installation package must exist before removing older packages`);
  }
  const packages = entries
    .filter(entry => entry.isFile())
    .map(entry => ({ entry, parsed: parsePackageName(entry.name) }))
    .filter(({ parsed }) => parsed !== null);
  const previousVersion = packages
    .map(({ parsed }) => parsed)
    .filter(parsed => parsed.installation && versionPattern.test(parsed.version) && compareVersions(parsed.version, version) < 0)
    .map(parsed => parsed.version)
    .sort(compareVersions)
    .at(-1) ?? null;
  const keptVersions = new Set([version, previousVersion].filter(Boolean));

  const removed = [];
  let removedBytes = 0;
  for (const { entry, parsed } of packages) {
    if (keptVersions.has(parsed.version)) continue;
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
  return { previousVersion, removed, removedBytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { version } = JSON.parse(readFileSync(path.join(repositoryRoot, 'apps/agent/package.json'), 'utf8'));
  const directory = path.resolve(process.env.AGENT_PACKAGE_OUTPUT_DIR || path.join(repositoryRoot, 'artifacts'));
  const result = cleanupAgentPackages(directory, version);
  process.stdout.write(`${JSON.stringify({ directory, keptVersion: version, ...result }, null, 2)}\n`);
}
