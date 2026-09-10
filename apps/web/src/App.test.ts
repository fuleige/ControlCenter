import { describe, expect, it } from "vitest";
import { buildTimeline, normalizeMathMarkdown } from "./App";
import type { ConversationDetail } from "./types";

describe("buildTimeline", () => {
  it("keeps user prompts and merges streamed agent deltas", () => {
    const detail: ConversationDetail = {
      conversation: {
        id: "conversation-1",
        nodeId: "node-1",
        workspaceId: "workspace-1",
        title: "Test",
        model: null,
        effort: null,
        clientRequestId: null,
        remoteThreadId: "thread-1",
        status: "ready",
        error: null,
        pinnedAt: null,
        latestRunStatus: "completed",
        createdAt: "2026-09-09T10:00:00.000Z",
        updatedAt: "2026-09-09T10:00:03.000Z",
      },
      runs: [{
        id: "run-1",
        conversationId: "conversation-1",
        prompt: "Say hello",
        model: null,
        effort: null,
        clientRequestId: "request-1",
        remoteTurnId: "turn-1",
        status: "completed",
        progressPhase: null,
        progressLabel: null,
        progressUpdatedAt: null,
        recoveryDeadlineAt: null,
        error: null,
        createdAt: "2026-09-09T10:00:01.000Z",
        startedAt: "2026-09-09T10:00:01.100Z",
        finishedAt: "2026-09-09T10:00:03.000Z",
      }],
      messages: [{
        id: "user-1",
        conversationId: "conversation-1",
        runId: "run-1",
        role: "user",
        content: "Say hello",
        revision: 1,
        complete: true,
        attachmentIds: [],
        createdAt: "2026-09-09T10:00:01.000Z",
        updatedAt: "2026-09-09T10:00:01.000Z",
      }, {
        id: "message-1",
        conversationId: "conversation-1",
        runId: "run-1",
        role: "assistant",
        content: "hello",
        revision: 2,
        complete: true,
        attachmentIds: [],
        createdAt: "2026-09-09T10:00:02.000Z",
        updatedAt: "2026-09-09T10:00:02.100Z",
      }],
      attachments: [],
      approvals: [],
    };

    const timeline = buildTimeline(detail);
    expect(timeline.map((entry) => [entry.kind, entry.content])).toEqual([
      ["user", "Say hello"],
      ["agent", "hello"],
    ]);
  });
});

describe("normalizeMathMarkdown", () => {
  it("supports Codex bracket math without changing code", () => {
    const source = String.raw`行内 \(E = mc^2\)

\[\int_0^1 x^2 dx\]

代码 不处理这里的 \`\(literal\)\`

~~~text
\[literal block\]
~~~`;
    const normalized = normalizeMathMarkdown(source);
    expect(normalized).toContain("$E = mc^2$");
    expect(normalized).toContain("$$\\int_0^1 x^2 dx$$");
    expect(normalized).toContain(String.raw`\`\(literal\)\``);
    expect(normalized).toContain(String.raw`\[literal block\]`);
  });
});
