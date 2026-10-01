import { accessSync, closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const archiveArgument = process.argv[2];
if (!archiveArgument || process.argv.length !== 3) throw new Error("Usage: node scripts/verify-agent-package.mjs <Agent archive.tar.gz>");
const archive = path.resolve(archiveArgument);
const releaseName = path.basename(archive).replace(/\.tar\.gz$/, "");
if (!/^controller-center-agent-v[0-9A-Za-z.+-]+-(linux-(x64|arm64)-(glibc|musl)|darwin-(x64|arm64))\.tar\.gz$/.test(path.basename(archive))) {
  throw new Error("Expected a platform-specific Agent archive");
}
const temporary = mkdtempSync(path.join(os.tmpdir(), "controller-center-agent-verification-"));

function run(command, arguments_, cwd) {
  const result = spawnSync(command, arguments_, { cwd, stdio: "inherit", timeout: 20_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

try {
  run("tar", ["-xzf", archive, "-C", temporary]);
  const directory = path.join(temporary, releaseName);
  const buildInfoPath = path.join(directory, "BUILD-INFO.json");
  const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8"));
  const packageInfo = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
  if (releaseName !== `controller-center-agent-v${packageInfo.version}-${buildInfo.target}` || packageInfo.version !== buildInfo.version) {
    throw new Error("Archive name, package version and build target do not agree");
  }
  accessSync(path.join(directory, "agent.sh"), constants.X_OK);
  run(process.execPath, ["--input-type=module", "-e", String.raw`
    import { randomUUID } from 'node:crypto';
    import { assertAgentPackageRuntime } from './dist/package-runtime.js';
    import { NodeTerminals } from './dist/node-terminals.js';
    assertAgentPackageRuntime();
    const events = [];
    const manager = new NodeTerminals(process.cwd(), event => { events.push(event); return true; });
    const output = id => events.filter(event => event.action === 'terminal.output' && event.id === id).map(event => event.data).join('');
    async function waitFor(predicate, label) {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(label);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try {
      if (!await manager.initialize()) throw new Error('The packaged Agent cannot initialize a real PTY');
      const one = randomUUID(), two = randomUUID();
      for (const id of [one, two]) manager.handle({action:'terminal.open', id, cols:80, rows:24}, 'package-check');
      if (events.filter(event => event.action === 'terminal.opened').length !== 2) throw new Error('Cannot open two terminals');
      manager.handle({action:'terminal.resize', id:one, cols:101, rows:31}, 'package-check');
      manager.handle({action:'terminal.input', id:one, data:"test -t 0 && printf '__PACKAGE_TTY__\\n'; stty size\r"}, 'package-check');
      await waitFor(() => /(?:^|[\r\n])__PACKAGE_TTY__\r?\n/.test(output(one)) && output(one).includes('31 101'), 'TTY or resize check failed');
      manager.handle({action:'terminal.close', id:one}, 'package-check');
      if (!events.some(event => event.action === 'terminal.exit' && event.id === one)) throw new Error('Closing the first terminal failed');
      manager.handle({action:'terminal.input', id:two, data:"printf '__PACKAGE_SECOND__\\n'\r"}, 'package-check');
      await waitFor(() => /(?:^|[\r\n])__PACKAGE_SECOND__\r?\n/.test(output(two)), 'The second terminal did not survive');
      console.log('Packaged Agent: real TTY, resize, two terminals and independent close passed');
    } finally { manager.dispose(); }
  `], directory);

  // Exercise both entry points with incompatible metadata before any registration,
  // Codex subprocess or node state can be created.
  const incompatibleTarget = process.platform === "darwin" ? "linux-x64-glibc" : "darwin-arm64";
  writeFileSync(buildInfoPath, `${JSON.stringify({ ...buildInfo, target: incompatibleTarget })}\n`);
  const stateDirectory = path.join(temporary, "must-not-create-agent-state");
  for (const entry of ["dist/index.js", "dist/enroll.js"]) {
    const errorPath = path.join(temporary, "startup-check-errors.txt");
    const errorFd = openSync(errorPath, "w", 0o600);
    let result;
    try {
      result = spawnSync(process.execPath, [entry], {
        cwd: directory,
        env: { ...process.env, AGENT_DATA_DIR: stateDirectory },
        stdio: ["ignore", "ignore", errorFd],
        timeout: 5_000,
      });
    } finally { closeSync(errorFd); }
    if (result.error) throw result.error;
    const stderr = readFileSync(errorPath, "utf8");
    if (result.status !== 1 || !stderr.includes(`安装包目标为 ${incompatibleTarget}`) || existsSync(stateDirectory)) {
      throw new Error(`${entry} did not reject the incompatible package before creating state`);
    }
  }
  process.stdout.write(`Verified Agent package: ${path.basename(archive)}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
