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
        maxConcurrentRuns: 2,
        workspaces: [],
      },
    }));
    expect(message.type).toBe("agent.hello");
  });

  it("rejects unknown control messages", () => {
    expect(() => parseControlMessage('{"type":"control.unknown"}')).toThrow(
      "Unsupported control message type",
    );
  });
});
