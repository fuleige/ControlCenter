import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanupAgentPackages } from './cleanup-agent-packages.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentPackage = JSON.parse(readFileSync(path.join(repositoryRoot, "apps/agent/package.json"), "utf8"));
const protocolPackage = JSON.parse(readFileSync(path.join(repositoryRoot, "packages/protocol/package.json"), "utf8"));
const version = String(agentPackage.version);
const baseReleaseName = `controller-center-agent-v${version}`;
if (!['linux', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch) || Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error('Agent packages must be built and tested on Linux/macOS x64/arm64 with Node.js 24');
}
const libc = process.platform === 'linux' ? (process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl') : null;
const target = [process.platform, process.arch, libc].filter(Boolean).join('-');
if (process.env.AGENT_PACKAGE_EXPECTED_TARGET && process.env.AGENT_PACKAGE_EXPECTED_TARGET !== target) {
  throw new Error(`Build target mismatch: expected ${process.env.AGENT_PACKAGE_EXPECTED_TARGET}, actual ${target}`);
}
const releaseName = `${baseReleaseName}-${target}`;
const artifactName = `${releaseName}.tar.gz`;
const artifactDirectory = path.resolve(process.env.AGENT_PACKAGE_OUTPUT_DIR || path.join(repositoryRoot, "artifacts"));
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "controller-center-agent-package-"));
const releaseDirectory = path.join(temporaryDirectory, releaseName);
const temporaryArtifact = path.join(artifactDirectory, `.${artifactName}.${process.pid}.tmp`);
const finalArtifact = path.join(artifactDirectory, artifactName);

function run(command, arguments_, cwd) {
  const result = spawnSync(command, arguments_, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${arguments_.join(" ")} failed with exit code ${result.status}`);
}

function requirePath(relativePath) {
  const resolved = path.join(repositoryRoot, relativePath);
  if (!existsSync(resolved)) throw new Error(`Missing required build output: ${resolved}`);
  return resolved;
}

try {
  mkdirSync(releaseDirectory, { recursive: true });
  mkdirSync(path.join(releaseDirectory, "protocol"), { recursive: true });
  mkdirSync(path.join(releaseDirectory, "node-files"), { recursive: true });
  mkdirSync(path.join(releaseDirectory, "deploy"), { recursive: true });
  mkdirSync(artifactDirectory, { recursive: true });

  cpSync(requirePath("apps/agent/dist"), path.join(releaseDirectory, "dist"), { recursive: true });
  cpSync(requirePath("packages/protocol/dist"), path.join(releaseDirectory, "protocol/dist"), { recursive: true });
  cpSync(requirePath("packages/node-files/dist"), path.join(releaseDirectory, "node-files/dist"), { recursive: true });
  copyFileSync(requirePath("apps/agent/agent.sh"), path.join(releaseDirectory, "agent.sh"));
  chmodSync(path.join(releaseDirectory, "agent.sh"), 0o755);

  const readme = readFileSync(requirePath("docs/agent-cli.md"), "utf8")
    .replaceAll("/opt/controller-center/apps/agent", "/opt/controller-center-agent");
  writeFileSync(path.join(releaseDirectory, "README.md"), readme);
  copyFileSync(requirePath("deploy/agent.env.example"), path.join(releaseDirectory, "deploy/agent.env.example"));
  const service = readFileSync(requirePath("deploy/systemd/controller-center-agent.service"), "utf8")
    .replaceAll("/opt/controller-center/apps/agent", "/opt/controller-center-agent")
    .replace("WorkingDirectory=/opt/controller-center\n", "WorkingDirectory=/opt/controller-center-agent\n");
  writeFileSync(path.join(releaseDirectory, "deploy/controller-center-agent.service"), service);

  writeFileSync(path.join(releaseDirectory, "package.json"), `${JSON.stringify({
    name: "controller-center-node-client",
    version,
    private: true,
    type: "module",
    main: "./dist/index.js",
    workspaces: ["protocol", "node-files"],
    scripts: {
      start: "node dist/index.js",
      enroll: "node dist/enroll.js",
    },
    engines: agentPackage.engines,
    dependencies: agentPackage.dependencies,
  }, null, 2)}\n`);
  writeFileSync(path.join(releaseDirectory, "protocol/package.json"), `${JSON.stringify({
    name: protocolPackage.name,
    version: protocolPackage.version,
    private: true,
    type: "module",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    // Mirror the workspace subpath exports (e.g. ./node-identity), resolved to built files.
    exports: Object.fromEntries(Object.entries(protocolPackage.exports).map(([subpath, target]) =>
      [subpath, { types: target.import.replace(/\.js$/, ".d.ts"), import: target.import }])),
  }, null, 2)}\n`);
  writeFileSync(path.join(releaseDirectory, "node-files/package.json"), `${JSON.stringify({
    name: "@controller-center/node-files", version: "0.1.0", private: true, type: "module",
    main: "./dist/index.js", dependencies: { "@controller-center/protocol": "*" },
  }, null, 2)}\n`);
  writeFileSync(path.join(releaseDirectory, "BUILD-INFO.json"), `${JSON.stringify({
    name: "Controller Center Agent",
    version,
    builtAt: new Date().toISOString(),
    node: agentPackage.engines.node,
    target, platform: process.platform, arch: process.arch, libc, nodeVersion: process.version,
    glibcVersion: process.platform === "linux" ? process.report.getReport().header.glibcVersionRuntime ?? null : null,
  }, null, 2)}\n`);

  run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], releaseDirectory);
  // The Claude runtime drives the node's own installed `claude` CLI, so drop the
  // SDK's bundled per-platform Claude Code binary (~290 MB).
  const anthropicModules = path.join(releaseDirectory, "node_modules/@anthropic-ai");
  if (existsSync(anthropicModules)) for (const entry of readdirSync(anthropicModules)) {
    if (entry.startsWith("claude-agent-sdk-")) rmSync(path.join(anthropicModules, entry), { recursive: true, force: true });
  }
  run("node", ["--input-type=module", "-e", `const sdk = await import('@anthropic-ai/claude-agent-sdk');
    if (typeof sdk.query !== 'function') throw new Error('Claude Agent SDK did not load');
    console.log('Packaged Claude Agent SDK loads without its bundled CLI binary');`], releaseDirectory);
  // Installation stays script-free. Copy the native module already built on this
  // exact target, then prove the standalone installation can spawn a real PTY.
  cpSync(requirePath("node_modules/node-pty"), path.join(releaseDirectory, "node_modules/node-pty"), { recursive: true });
  const prebuildDirectory = path.join(releaseDirectory, "node_modules/node-pty/prebuilds");
  if (existsSync(prebuildDirectory)) for (const entry of readdirSync(prebuildDirectory)) {
    if (entry !== `${process.platform}-${process.arch}`) rmSync(path.join(prebuildDirectory, entry), { recursive: true, force: true });
  }
  for (const helper of ["build/Release/spawn-helper", `prebuilds/${process.platform}-${process.arch}/spawn-helper`]) {
    const location = path.join(releaseDirectory, "node_modules/node-pty", helper);
    if (existsSync(location)) chmodSync(location, 0o755);
  }
  run("node", ["--input-type=module", "-e", `import * as pty from 'node-pty';
    const child=pty.spawn('/bin/sh',['-c','test -t 0'],{cols:80,rows:24}); child.resize(100,30);
    const timer=setTimeout(()=>{child.kill('SIGKILL');process.exit(1)},3000);
    child.onExit(({exitCode})=>{clearTimeout(timer);process.exit(exitCode)});`], releaseDirectory);
  run("node", ["--input-type=module", "-e", `import * as rtc from 'node-datachannel';
    import { nativeFileChannelAdapter } from './dist/direct-files.js';
    const queued = nativeFileChannelAdapter({sendMessage:()=>false,sendMessageBinary:()=>false,
      bufferedAmount:()=>0,maxMessageSize:()=>16384,isOpen:()=>true,close:()=>{}});
    queued.send('package-check'); queued.send(new Uint8Array([1]));
    rtc.preload(); const peer = new rtc.PeerConnection('package-load-check', {iceServers:[]});
    peer.close(); rtc.cleanup(); console.log('Packaged WebRTC native module and queued-send handling checked');`], releaseDirectory);
  run("tar", ["-czf", temporaryArtifact, "-C", temporaryDirectory, releaseName], repositoryRoot);
  renameSync(temporaryArtifact, finalArtifact);
  chmodSync(finalArtifact, 0o644);

  const size = statSync(finalArtifact).size;
  const sha256 = createHash("sha256").update(readFileSync(finalArtifact)).digest("hex");
  const cleanup = cleanupAgentPackages(artifactDirectory, version);
  process.stdout.write(`Agent package: ${finalArtifact}\nSize: ${size} bytes\nSHA-256: ${sha256}\nKept rollback version: ${cleanup.previousVersion ? `v${cleanup.previousVersion}` : 'none'}\nRemoved older Agent packages: ${cleanup.removed.length}\n`);
} finally {
  if (existsSync(temporaryArtifact)) rmSync(temporaryArtifact, { force: true });
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
