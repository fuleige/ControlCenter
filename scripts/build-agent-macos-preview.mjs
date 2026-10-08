import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanupAgentPackages } from './cleanup-agent-packages.mjs';

// Reuse an existing release's JavaScript and locked production dependencies.
// The official node-pty Darwin prebuild replaces every host native build.
// This produces a test download; it does not claim a macOS runtime smoke test.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 3) throw new Error("Usage: node scripts/build-agent-macos-preview.mjs <Linux Agent archive.tar.gz>");
const archive = path.resolve(process.argv[2]);
const match = /^controller-center-agent-v([0-9A-Za-z.+-]+)-(linux-(?:x64|arm64)-(?:glibc|musl))\.tar\.gz$/.exec(path.basename(archive));
if (!match) throw new Error("Expected an existing platform-specific Linux Agent archive");
const [, version, sourceTarget] = match;
const currentVersion = JSON.parse(readFileSync(path.join(repositoryRoot, 'apps/agent/package.json'), 'utf8')).version;
if (version !== currentVersion) throw new Error(`Source Agent v${version} is outdated; current version is v${currentVersion}`);
const target = "darwin-arm64";
const sourceName = path.basename(archive).replace(/\.tar\.gz$/, "");
const releaseName = `controller-center-agent-v${version}-${target}`;
const artifactDirectory = path.resolve(process.env.AGENT_PACKAGE_OUTPUT_DIR || path.join(repositoryRoot, "artifacts"));
const finalArtifact = path.join(artifactDirectory, `${releaseName}.tar.gz`);
const temporaryArtifact = path.join(artifactDirectory, `.${releaseName}.${process.pid}.tmp`);
const temporary = mkdtempSync(path.join(os.tmpdir(), "controller-center-macos-preview-"));

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", timeout: 20_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

function checkArm64MachO(location) {
  const binary = readFileSync(location);
  if (binary.length < 32 || binary.subarray(0, 4).toString("hex") !== "cffaedfe" || binary.readUInt32LE(4) !== 0x0100000c) {
    throw new Error(`Expected a macOS ARM64 Mach-O binary: ${location}`);
  }
}

try {
  run("tar", ["-xzf", archive, "-C", temporary]);
  const directory = path.join(temporary, sourceName);
  const infoPath = path.join(directory, "BUILD-INFO.json");
  const info = JSON.parse(readFileSync(infoPath, "utf8"));
  const packageInfo = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
  if (info.version !== version || packageInfo.version !== version || info.target !== sourceTarget) {
    throw new Error("Source archive name, version and build target do not agree");
  }
  const sourcePty = path.join(repositoryRoot, "node_modules/node-pty");
  const ptyInfo = JSON.parse(readFileSync(path.join(sourcePty, "package.json"), "utf8"));
  const sourceLock = JSON.parse(readFileSync(path.join(directory, "package-lock.json"), "utf8"));
  const repositoryLock = JSON.parse(readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8"));
  const sourceDependency = sourceLock.packages["node_modules/node-pty"];
  const repositoryDependency = repositoryLock.packages["node_modules/node-pty"];
  if (packageInfo.dependencies["node-pty"] !== ptyInfo.version || sourceDependency.version !== ptyInfo.version || !sourceDependency.integrity || sourceDependency.integrity !== repositoryDependency.integrity) {
    throw new Error("The native dependency must match the original release's pinned node-pty package and integrity");
  }
  for (const file of ["pty.node", "spawn-helper"]) checkArm64MachO(path.join(sourcePty, "prebuilds", target, file));

  const packagedPty = path.join(directory, "node_modules/node-pty");
  rmSync(packagedPty, { recursive: true, force: true });
  cpSync(sourcePty, packagedPty, { recursive: true });
  // node-pty searches build/Release before prebuilds; a Linux build must not remain.
  rmSync(path.join(packagedPty, "build"), { recursive: true, force: true });
  for (const entry of readdirSync(path.join(packagedPty, "prebuilds"))) {
    if (entry !== target) rmSync(path.join(packagedPty, "prebuilds", entry), { recursive: true, force: true });
  }
  const helper = path.join(packagedPty, "prebuilds", target, "spawn-helper");
  chmodSync(helper, 0o755);
  accessSync(helper, constants.X_OK);
  chmodSync(path.join(directory, "agent.sh"), 0o755);
  const buildInfo = {
    ...info, builtAt: new Date().toISOString(), target, platform: "darwin", arch: "arm64", libc: null, glibcVersion: null,
    builtOn: { platform: process.platform, arch: process.arch, nodeVersion: process.version },
    sourceTarget, nativeModule: `node-pty@${ptyInfo.version} official npm prebuild`, nativeVerification: "pending-macos-test",
  };
  writeFileSync(infoPath, `${JSON.stringify(buildInfo, null, 2)}\n`);
  const readmePath = path.join(directory, "README.md");
  const previewNote = `> macOS ARM64 测试安装包：沿用 Agent v${version} 的运行代码和锁定依赖，使用 node-pty@${ptyInfo.version} 官方 macOS ARM64 预编译模块。已检查架构、完整性及 spawn-helper 执行权限，尚待 Mac 实机验证。需要 ARM64 Node.js 24.x，可用 node -p 'process.platform + "-" + process.arch' 确认输出为 darwin-arm64。升级现有节点时保留原工作目录及 AGENT_DATA_DIR，无需重新注册。\n\n`;
  writeFileSync(readmePath, previewNote + readFileSync(readmePath, "utf8"));
  const releaseDirectory = path.join(temporary, releaseName);
  renameSync(directory, releaseDirectory);
  if (!existsSync(artifactDirectory)) throw new Error("Artifact output directory must already exist");
  run("tar", ["-czf", temporaryArtifact, "-C", temporary, releaseName]);
  renameSync(temporaryArtifact, finalArtifact);
  chmodSync(finalArtifact, 0o644);
  const sha256 = createHash("sha256").update(readFileSync(finalArtifact)).digest("hex");
  const cleanup = cleanupAgentPackages(artifactDirectory, version);
  process.stdout.write(`macOS ARM64 test package: ${finalArtifact}\nSize: ${statSync(finalArtifact).size} bytes\nSHA-256: ${sha256}\nRemoved previous Agent packages: ${cleanup.removed.length}\nNative runtime verification: pending macOS test\n`);
} finally {
  rmSync(temporaryArtifact, { force: true });
  rmSync(temporary, { recursive: true, force: true });
}
