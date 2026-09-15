import { describe, expect, it } from "vitest";
import { appServerArguments, parseThreadTokenUsage, threadStartSecurity, turnSandboxPolicy } from "./app-server-client.js";

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

describe("Codex App Server token usage", () => {
  it("extracts cumulative usage and the latest context footprint", () => {
    expect(parseThreadTokenUsage({
      threadId: "thread-1",
      tokenUsage: {
        total: { totalTokens: 456_789, inputTokens: 400_000, outputTokens: 56_789 },
        last: { totalTokens: 123_456, inputTokens: 120_000, outputTokens: 3_456 },
        modelContextWindow: 400_000,
      },
    })).toEqual({ totalTokens: 456_789, contextTokens: 123_456, modelContextWindow: 400_000 });
  });

  it("rejects malformed token usage notifications without crashing the Agent", () => {
    expect(parseThreadTokenUsage({ tokenUsage: { total: {}, last: {}, modelContextWindow: 400_000 } })).toBeNull();
    expect(parseThreadTokenUsage({ tokenUsage: { total: { totalTokens: 1 }, last: { totalTokens: -1 }, modelContextWindow: 400_000 } })).toBeNull();
  });
});
