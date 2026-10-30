import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, runtimeFromArgs } from "./config.js";

const directories: string[] = [];
const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Agent workspace configuration", () => {
  it("uses the invocation directory as an immutable stable default", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "controller-center-agent-config-"));
    directories.push(root);
    const dataDirectory = path.join(root, "data");
    const initialDirectory = path.join(root, "project-a");
    const nextDirectory = path.join(root, "project-b");
    mkdirSync(initialDirectory);
    mkdirSync(nextDirectory);

    process.env.AGENT_DATA_DIR = dataDirectory;
    process.env.INIT_CWD = initialDirectory;
    process.env.AGENT_WORKSPACES = JSON.stringify([{ id: "project-a", name: "Project A", path: initialDirectory }]);
    delete process.env.MAX_CONCURRENT_RUNS;
    const configured = loadConfig(["codex", "--yolo", "--codex-proxy-only"]);
    expect(configured.runtime).toBe("codex");
    expect(configured.yolo).toBe(true);
    expect(configured.codexProxyOnly).toBe(true);
    expect(configured.maxConcurrentRuns).toBe(5);
    expect(configured.workspaces[0]).toMatchObject({
      id: "project-a",
      path: initialDirectory,
      source: "default",
      isDefault: true,
    });

    delete process.env.AGENT_WORKSPACES;
    const withoutDuplicateConfiguration = loadConfig(["codex"]);
    expect(withoutDuplicateConfiguration.yolo).toBe(false);
    expect(withoutDuplicateConfiguration.codexProxyOnly).toBe(false);
    expect(withoutDuplicateConfiguration.workspaces[0]?.id).toBe("project-a");

    process.env.INIT_CWD = nextDirectory;
    const afterMovingAgent = loadConfig(["codex"]);
    expect(afterMovingAgent.workspaces[0]?.path).toBe(nextDirectory);
    expect(afterMovingAgent.workspaces[0]?.id).not.toBe("project-a");
  });

  it("uses the enrolled server and node credential when environment overrides are absent", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "controller-center-agent-enrolled-"));
    directories.push(root);
    const dataDirectory = path.join(root, "data");
    const workspace = path.join(root, "workspace");
    mkdirSync(dataDirectory);
    mkdirSync(workspace);
    writeFileSync(path.join(dataDirectory, "connection.json"), JSON.stringify({
      controlUrl: "https://control.example.com/agent/connect",
      credential: "ccn_credential.secret",
    }));
    process.env.AGENT_DATA_DIR = dataDirectory;
    process.env.INIT_CWD = workspace;
    process.env.AGENT_TOKEN = "legacy-shared-token";
    delete process.env.CONTROL_CENTER_URL;

    const config = loadConfig(["claude"]);
    expect(config.runtime).toBe("claude");
    expect(config.controlUrl).toBe("wss://control.example.com/agent/connect");
    expect(config.token).toBe("ccn_credential.secret");
  });

  it("shares the machine identity and credential across runtimes but keeps their state apart", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "controller-center-agent-runtimes-"));
    directories.push(root);
    const dataDirectory = path.join(root, "data");
    const workspace = path.join(root, "workspace");
    mkdirSync(dataDirectory);
    mkdirSync(workspace);
    writeFileSync(path.join(dataDirectory, "identity.json"), JSON.stringify({ nodeId: "2b0ebc97-1ac2-4d1f-a435-2b748ce76ecf" }));
    writeFileSync(path.join(dataDirectory, "connection.json"), JSON.stringify({
      controlUrl: "https://control.example.com/agent/connect",
      credential: "ccn_credential.secret",
    }));
    process.env.AGENT_DATA_DIR = dataDirectory;
    process.env.INIT_CWD = workspace;
    delete process.env.AGENT_ID;

    const codex = loadConfig(["codex"]);
    const claude = loadConfig(["claude"]);
    // Codex keeps the pre-existing node id and files, so current nodes are untouched.
    expect(codex).toMatchObject({ machineId: "2b0ebc97-1ac2-4d1f-a435-2b748ce76ecf", nodeId: "2b0ebc97-1ac2-4d1f-a435-2b748ce76ecf", stateDirectory: dataDirectory });
    expect(claude.machineId).toBe(codex.machineId);
    expect(claude.nodeId).not.toBe(codex.nodeId);
    expect(claude.token).toBe(codex.token);
    expect(claude.stateDirectory).toBe(path.join(dataDirectory, "runtimes", "claude"));
    expect(existsSync(claude.stateDirectory)).toBe(true);
    expect(claude.workspaces[0]?.id).toBe(codex.workspaces[0]?.id);
  });

  it("requires exactly one runtime argument before creating state", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "controller-center-agent-runtime-"));
    directories.push(root);
    const dataDirectory = path.join(root, "must-not-exist");
    process.env.AGENT_DATA_DIR = dataDirectory;

    expect(() => loadConfig(["--yolo"])).toThrow("未选择节点运行时");
    expect(existsSync(dataDirectory)).toBe(false);
    expect(runtimeFromArgs(["--yolo", "claude", "--codex-proxy-only"])).toBe("claude");
    expect(runtimeFromArgs(["codex"])).toBe("codex");
    expect(() => runtimeFromArgs(["Claude"])).toThrow("无效的节点运行时");
    expect(() => runtimeFromArgs(["codex", "claude"])).toThrow("只能选择一个");
  });
});
