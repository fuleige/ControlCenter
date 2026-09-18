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

  it("parses capability-gated workspace file requests and responses", () => {
    expect(parseControlMessage(JSON.stringify({
      type: "control.workspaceFileRead",
      requestId: "file-request-1",
      workspaceId: "workspace-1",
      path: "/home/ubuntu/report.tsv",
      maxBytes: 8 * 1024 * 1024,
    })).type).toBe("control.workspaceFileRead");
    expect(parseAgentMessage(JSON.stringify({
      type: "agent.workspaceFile",
      requestId: "file-request-1",
      ok: true,
      path: "/home/ubuntu/report.tsv",
      name: "report.tsv",
      mediaType: "text/tab-separated-values; charset=utf-8",
      size: 3,
      contentBase64: "YQli",
    })).type).toBe("agent.workspaceFile");
  });

  it("parses context compaction commands and durable state", () => {
    const control = parseControlMessage(JSON.stringify({
      type: "control.command",
      commandId: "command-compact",
      createdAt: "2026-09-15T00:00:00.000Z",
      command: {
        type: "conversation.compact",
        compactionId: "compact-1",
        conversationId: "conversation-1",
        threadId: "thread-1",
      },
    }));
    expect(control.type).toBe("control.command");
    if (control.type === "control.command") expect(control.command.type).toBe("conversation.compact");

    const durable = parseAgentMessage(JSON.stringify({
      type: "agent.message",
      bootId: "boot-1",
      sequence: 7,
      payload: {
        type: "conversation.compaction",
        compactionId: "compact-1",
        conversationId: "conversation-1",
        threadId: "thread-1",
        status: "completed",
        beforeContextTokens: 90_000,
        afterContextTokens: 24_000,
        occurredAt: "2026-09-15T00:00:05.000Z",
      },
    }));
    expect(durable.type).toBe("agent.message");
    if (durable.type === "agent.message") expect(durable.payload.type).toBe("conversation.compaction");
  });
});
