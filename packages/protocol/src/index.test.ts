import { describe, expect, it } from "vitest";
import { CONTROL_PROTOCOL_VERSION, parseAgentMessage, parseControlMessage } from "./index.js";

describe("wire protocol", () => {
  it("parses an agent hello", () => {
    const message = parseAgentMessage(JSON.stringify({
      type: "agent.hello",
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      bootId: "boot-1",
      node: {
        id: "node-1",
        name: "worker",
        platform: "linux",
        arch: "x64",
        agentVersion: "0.1.0",
        codexVersion: "codex-cli 0.153.0",
        permissionMode: "danger-full-access",
        maxConcurrentRuns: 2,
        workspaces: [],
      },
    }));
    expect(message.type).toBe("agent.hello");
    if (message.type === "agent.hello") expect(message.node.permissionMode).toBe("danger-full-access");
  });

  it("rejects unknown control messages", () => {
    expect(() => parseControlMessage('{"type":"control.unknown"}')).toThrow(
      "Unsupported control message type",
    );
  });

  it("parses the one-time historical token usage backfill list", () => {
    const message = parseControlMessage(JSON.stringify({
      type: "control.welcome",
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      nodeId: "node-1",
      connectedAt: "2026-09-15T00:00:00.000Z",
      heartbeatIntervalMs: 15_000,
      tokenUsageBackfill: [{ conversationId: "conversation-1", threadId: "thread-1" }],
    }));
    expect(message.type).toBe("control.welcome");
    if (message.type === "control.welcome") {
      expect(message.tokenUsageBackfill).toEqual([{ conversationId: "conversation-1", threadId: "thread-1" }]);
    }
  });

  it("parses workspace validation messages", () => {
    expect(parseControlMessage(JSON.stringify({
      type: "control.workspaceValidate",
      requestId: "workspace-request-1",
      path: "/projects/example",
    })).type).toBe("control.workspaceValidate");
    expect(parseAgentMessage(JSON.stringify({
      type: "agent.workspaceValidation",
      requestId: "workspace-request-1",
      valid: true,
      canonicalPath: "/projects/example",
      suggestedName: "example",
    })).type).toBe("agent.workspaceValidation");
  });
});
