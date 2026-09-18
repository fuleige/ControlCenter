import { describe, expect, it } from "vitest";
import {
  boundedConversationDetail,
  buildTimeline,
  conversationCacheLimit,
  limitConversationCache,
  mergedConversationDetail,
  messageHistoryCacheLimit,
  normalizeMathMarkdown,
  isLocalWorkspaceHref,
  parseDelimitedPreview,
  previewLineNumberText,
} from "./App";
import type { ConversationDetail, Message } from "./types";

function message(index: number): Message {
  const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    id: `message-${index}`,
    conversationId: "conversation-1",
    runId: null,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index}`,
    revision: 1,
    complete: true,
    attachmentIds: [],
    createdAt,
    updatedAt: createdAt,
  };
}

function detailWithMessages(messages: Message[]): ConversationDetail {
  return {
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
      tokenUsage: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    runs: [],
    messages,
    messagePage: { hasMore: false, before: null },
    attachments: [],
    approvals: [],
  };
}

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
        tokenUsage: null,
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
      messagePage: { hasMore: false, before: null },
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

describe("conversation file links", () => {
  it("only sends local and file paths to the Agent", () => {
    expect(isLocalWorkspaceHref("/home/ubuntu/documents/a.txt")).toBe(true);
    expect(isLocalWorkspaceHref("../reports/a.csv")).toBe(true);
    expect(isLocalWorkspaceHref("C:\\reports\\a.tsv")).toBe(true);
    expect(isLocalWorkspaceHref("file:///home/ubuntu/a.md")).toBe(true);
    for (const external of [
      "https://example.com/a.md",
      "http://example.com",
      "mailto:user@example.com",
      "tel:+8610010",
      "ftp://example.com/a.csv",
      "ws://example.com/socket",
      "wss://example.com/socket",
      "ssh://example.com",
      "//cdn.example.com/image.png",
      "#section",
      "custom-protocol:value",
    ]) expect(isLocalWorkspaceHref(external), external).toBe(false);
  });

  it("parses quoted CSV and tab-separated TSV previews", () => {
    expect(parseDelimitedPreview('name,note\nalpha,"one,two"\nbeta,"line 1\nline 2"', ",").rows).toEqual([
      ["name", "note"],
      ["alpha", "one,two"],
      ["beta", "line 1\nline 2"],
    ]);
    expect(parseDelimitedPreview("name\tvalue\nalpha\t1", "\t").rows).toEqual([
      ["name", "value"],
      ["alpha", "1"],
    ]);
  });

  it("builds preview line numbers without counting a trailing empty line", () => {
    expect(previewLineNumberText("alpha\nbeta\ngamma\n")).toBe("1\n2\n3");
    expect(previewLineNumberText("")).toBe("1");
  });
});

describe("long conversation memory limits", () => {
  it("caps the cached conversation list", () => {
    const template = detailWithMessages([]).conversation;
    const conversations = Array.from({ length: conversationCacheLimit + 25 }, (_, index) => ({
      ...template,
      id: `conversation-${index}`,
    }));

    const bounded = limitConversationCache(conversations);

    expect(bounded).toHaveLength(conversationCacheLimit);
    expect(bounded.at(-1)?.id).toBe(`conversation-${conversationCacheLimit - 1}`);
  });

  it("keeps only the newest messages when a detail response exceeds the hard limit", () => {
    const detail = detailWithMessages(Array.from({ length: messageHistoryCacheLimit + 20 }, (_, index) => message(index)));

    const bounded = boundedConversationDetail(detail);

    expect(bounded.messages).toHaveLength(messageHistoryCacheLimit);
    expect(bounded.messages[0]?.id).toBe("message-20");
    expect(bounded.messages.at(-1)?.id).toBe(`message-${messageHistoryCacheLimit + 19}`);
  });

  it("keeps the older side of the window while paging backwards", () => {
    const current = detailWithMessages(Array.from({ length: 300 }, (_, index) => message(index + 300)));
    const incoming = detailWithMessages(Array.from({ length: 300 }, (_, index) => message(index)));
    incoming.messagePage = { hasMore: true, before: "older-cursor" };

    const merged = mergedConversationDetail(current, incoming, "older");

    expect(merged.messages).toHaveLength(messageHistoryCacheLimit);
    expect(merged.messages[0]?.id).toBe("message-0");
    expect(merged.messages.at(-1)?.id).toBe(`message-${messageHistoryCacheLimit - 1}`);
    expect(merged.messagePage).toEqual({ hasMore: true, before: "older-cursor" });
  });
});
