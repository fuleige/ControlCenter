import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cleanupAgentPackages } from './cleanup-agent-packages.mjs';

function temporaryDirectory(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'controller-center-package-cleanup-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('retains every current target and removes old installation and source archives', t => {
  const directory = temporaryDirectory(t);
  const retained = [
    'controller-center-agent-v0.3.17-linux-x64-glibc.tar.gz',
    'controller-center-agent-v0.3.17-darwin-arm64.tar.gz',
    'controller-center-agent-source-v0.3.17.tar.gz',
  ];
  const old = [
    'controller-center-agent-v0.3.15-darwin-arm64.tar.gz',
    'controller-center-agent-v0.3.16-linux-x64-glibc.tar.gz',
    'controller-center-agent-source-v0.3.16.tar.gz',
    'controller-center-agent-v0.3.4.tar.gz',
    'controller-center-agent-v0.3.17-beta-linux-x64-glibc.tar.gz',
  ];
  for (const name of [...retained, ...old]) writeFileSync(path.join(directory, name), name);
  const result = cleanupAgentPackages(directory, '0.3.17');
  assert.deepEqual(result.removed.sort(), old.sort());
  assert.equal(result.removedBytes, old.reduce((size, name) => size + Buffer.byteLength(name), 0));
  assert.deepEqual(readdirSync(directory).sort(), retained.sort());
  for (const name of retained) assert.equal(readFileSync(path.join(directory, name), 'utf8'), name);
});

test('keeps existing packages when the replacement is missing or empty', t => {
  const directory = temporaryDirectory(t);
  const old = 'controller-center-agent-v0.3.16-linux-x64-glibc.tar.gz';
  writeFileSync(path.join(directory, old), 'previous-package');
  assert.throws(() => cleanupAgentPackages(directory, '0.3.17'), /must exist/);
  writeFileSync(path.join(directory, 'controller-center-agent-source-v0.3.17.tar.gz'), 'source-only');
  writeFileSync(path.join(directory, 'controller-center-agent-v0.3.17-linux-x64-glibc.tar.gz'), '');
  assert.throws(() => cleanupAgentPackages(directory, '0.3.17'), /must exist/);
  assert.equal(readFileSync(path.join(directory, old), 'utf8'), 'previous-package');
  assert.throws(() => cleanupAgentPackages(directory, '../0.3.17'), /Invalid/);
});

test('limits cleanup to regular package archives in the selected output directory', t => {
  const directory = temporaryDirectory(t);
  const otherDirectory = temporaryDirectory(t);
  const old = 'controller-center-agent-v0.3.16-linux-x64-glibc.tar.gz';
  writeFileSync(path.join(otherDirectory, old), 'outside-package');
  writeFileSync(path.join(directory, 'controller-center-agent-v0.3.17-linux-x64-glibc.tar.gz'), 'current');
  writeFileSync(path.join(directory, 'other-product-v0.3.16.tar.gz'), 'other');
  writeFileSync(path.join(directory, '.controller-center-agent-v0.3.16-linux-x64-glibc.tar.gz.123.tmp'), 'in-progress');
  mkdirSync(path.join(directory, 'nested'));
  writeFileSync(path.join(directory, 'nested', old), 'nested-package');
  symlinkSync(path.join(otherDirectory, old), path.join(directory, old));
  assert.deepEqual(cleanupAgentPackages(directory, '0.3.17').removed, []);
  assert.equal(readFileSync(path.join(otherDirectory, old), 'utf8'), 'outside-package');
  assert.equal(readFileSync(path.join(directory, 'nested', old), 'utf8'), 'nested-package');
  assert.equal(readFileSync(path.join(directory, 'other-product-v0.3.16.tar.gz'), 'utf8'), 'other');
});
