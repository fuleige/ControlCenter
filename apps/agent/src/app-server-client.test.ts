import { describe, expect, it } from "vitest";
import { appServerArguments, threadStartSecurity, turnSandboxPolicy } from "./app-server-client.js";

describe("Codex App Server launch arguments", () => {
  it("uses the normal sandboxed mode by default", () => {
    expect(appServerArguments(false)).toEqual(["app-server", "--stdio"]);
  });

  it("places the global yolo flag before the app-server subcommand", () => {
    expect(appServerArguments(true)).toEqual(["--yolo", "app-server", "--stdio"]);
  });
});

describe("Codex App Server sandbox protocol", () => {
  it("uses kebab-case legacy sandbox modes for thread/start", () => {
    expect(threadStartSecurity(true)).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" });
    expect(threadStartSecurity(false)).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" });
  });

  it("uses tagged camel-case policies for turn/start", () => {
    expect(turnSandboxPolicy(true, "/workspace", false)).toEqual({ type: "dangerFullAccess" });
    expect(turnSandboxPolicy(false, "/workspace", true)).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/workspace"],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });
});
