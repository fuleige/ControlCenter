import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

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
    const configured = loadConfig(["--yolo", "--codex-proxy-only"]);
    expect(configured.yolo).toBe(true);
    expect(configured.codexProxyOnly).toBe(true);
    expect(configured.workspaces[0]).toMatchObject({
      id: "project-a",
      path: initialDirectory,
      source: "default",
      isDefault: true,
    });

    delete process.env.AGENT_WORKSPACES;
    const withoutDuplicateConfiguration = loadConfig([]);
    expect(withoutDuplicateConfiguration.yolo).toBe(false);
    expect(withoutDuplicateConfiguration.codexProxyOnly).toBe(false);
    expect(withoutDuplicateConfiguration.workspaces[0]?.id).toBe("project-a");

    process.env.INIT_CWD = nextDirectory;
    const afterMovingAgent = loadConfig([]);
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

    const config = loadConfig([]);
    expect(config.controlUrl).toBe("wss://control.example.com/agent/connect");
    expect(config.token).toBe("ccn_credential.secret");
  });
});
