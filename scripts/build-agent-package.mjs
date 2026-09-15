import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentPackage = JSON.parse(readFileSync(path.join(repositoryRoot, "apps/agent/package.json"), "utf8"));
const protocolPackage = JSON.parse(readFileSync(path.join(repositoryRoot, "packages/protocol/package.json"), "utf8"));
const version = String(agentPackage.version);
const releaseName = `controller-center-agent-v${version}`;
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
  mkdirSync(path.join(releaseDirectory, "deploy"), { recursive: true });
  mkdirSync(artifactDirectory, { recursive: true });

  cpSync(requirePath("apps/agent/dist"), path.join(releaseDirectory, "dist"), { recursive: true });
  cpSync(requirePath("packages/protocol/dist"), path.join(releaseDirectory, "protocol/dist"), { recursive: true });
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
    workspaces: ["protocol"],
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
  }, null, 2)}\n`);
  writeFileSync(path.join(releaseDirectory, "BUILD-INFO.json"), `${JSON.stringify({
    name: "Controller Center Agent",
    version,
    builtAt: new Date().toISOString(),
    node: agentPackage.engines?.node ?? ">=24",
  }, null, 2)}\n`);

  run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], releaseDirectory);
  run("tar", ["-czf", temporaryArtifact, "-C", temporaryDirectory, releaseName], repositoryRoot);
  renameSync(temporaryArtifact, finalArtifact);
  chmodSync(finalArtifact, 0o644);

  const size = statSync(finalArtifact).size;
  const sha256 = createHash("sha256").update(readFileSync(finalArtifact)).digest("hex");
  process.stdout.write(`Agent package: ${finalArtifact}\nSize: ${size} bytes\nSHA-256: ${sha256}\n`);
} finally {
  if (existsSync(temporaryArtifact)) rmSync(temporaryArtifact, { force: true });
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
