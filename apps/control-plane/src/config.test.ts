import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("Control Plane data configuration", () => {
  it("anchors the default data directory to the invocation directory", () => {
    process.env.INIT_CWD = "/srv/controller-center";
    delete process.env.CONTROL_DATA_DIR;
    delete process.env.CONTROL_DATABASE_PATH;

    const config = loadConfig();

    expect(config.databasePath).toBe(path.join("/srv/controller-center", "data", "control-center.db"));
    expect(config.attachmentDirectory).toBe(path.join("/srv/controller-center", "data", "attachments"));
    expect(config.agentArtifactDirectory).toBe(path.join("/srv/controller-center", "artifacts"));
  });

  it("keeps an explicit data directory authoritative", () => {
    process.env.INIT_CWD = "/srv/controller-center";
    process.env.CONTROL_DATA_DIR = "/var/lib/controller-center";
    delete process.env.CONTROL_DATABASE_PATH;

    const config = loadConfig();

    expect(config.databasePath).toBe("/var/lib/controller-center/control-center.db");
    expect(config.attachmentDirectory).toBe("/var/lib/controller-center/attachments");
  });

  it("allows the packaged Agent artifact directory to be deployed separately", () => {
    process.env.INIT_CWD = "/srv/controller-center";
    process.env.AGENT_ARTIFACT_DIR = "/opt/controller-center-downloads";

    expect(loadConfig().agentArtifactDirectory).toBe("/opt/controller-center-downloads");
  });
});
