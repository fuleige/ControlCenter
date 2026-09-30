import { mkdtemp, writeFile, readFile, mkdir, lstat, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { NodeFiles } from './node-files.js';
import { OutboundNetwork } from './outbound-network.js';
it('startup cleanup removes only registered temporary files and preserves committed or unrelated files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-upload-cleanup-'));
  const data = path.join(root, 'state'); await mkdir(data);
  const pending = randomUUID(), committed = randomUUID(), unrelated = randomUUID();
  const temp = path.join(root, `.cc-upload-${pending}.part`); await writeFile(temp, 'partial', { mode: 0o600 }); const partial = await lstat(temp);
  const committedTemp = path.join(root, `.cc-upload-${committed}.part`); await writeFile(committedTemp, 'complete'); const committedInfo = await lstat(committedTemp);
  const final = path.join(root, 'user-final'); await rename(committedTemp, final);
  const userFile = path.join(root, 'user-important'); await writeFile(userFile, 'keep');
  await writeFile(path.join(data, 'node-upload-cleanup.json'), JSON.stringify({
    [pending]: { path: temp, dev: partial.dev, ino: partial.ino }, [committed]: { path: committedTemp, dev: committedInfo.dev, ino: committedInfo.ino }, [unrelated]: { path: userFile },
  }));
  const network = new OutboundNetwork(true); let manager: NodeFiles | null = null;
  try {
    manager = new NodeFiles(data, root, network, 'ws://127.0.0.1:1/agent/connect', () => true);
    await expect(lstat(temp)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(final, 'utf8')).toBe('complete'); expect(await readFile(userFile, 'utf8')).toBe('keep');
    const registry = JSON.parse(await readFile(path.join(data, 'node-upload-cleanup.json'), 'utf8'));
    expect(registry[pending]).toBeUndefined(); expect(registry[committed]).toBeUndefined(); expect(registry[unrelated]).toBeDefined();
  } finally { manager?.dispose(); await network.destroy(); await rm(root, { recursive: true, force: true }); }
});
it('keeps cleanup alive when the registry cannot be saved and retries after storage recovers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-upload-registry-retry-'));
  const data = path.join(root, 'state'); await mkdir(data);
  const pending = randomUUID(); const temp = path.join(root, `.cc-upload-${pending}.part`);
  await writeFile(temp, 'partial', { mode: 0o600 }); const info = await lstat(temp);
  const registryPath = path.join(data, 'node-upload-cleanup.json');
  await writeFile(registryPath, JSON.stringify({ [pending]: { path: temp, dev: info.dev, ino: info.ino } }));
  // A directory at the atomic-write path deterministically simulates a storage error.
  await mkdir(`${registryPath}.tmp`);
  const network = new OutboundNetwork(true); let manager: NodeFiles | null = null;
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers();
  try {
    manager = new NodeFiles(data, root, network, 'ws://127.0.0.1:1/agent/connect', () => true);
    await expect(lstat(temp)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(warning).toHaveBeenCalled();
    expect(JSON.parse(await readFile(registryPath, 'utf8'))[pending]).toBeDefined();
    await rm(`${registryPath}.tmp`, { recursive: true });
    vi.advanceTimersByTime(5_000);
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).toEqual({});
  } finally { manager?.dispose(); vi.useRealTimers(); warning.mockRestore(); await network.destroy(); await rm(root, { recursive: true, force: true }); }
});
