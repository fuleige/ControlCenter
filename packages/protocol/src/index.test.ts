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
