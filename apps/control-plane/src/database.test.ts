import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlDatabase } from "./database.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ControlDatabase", () => {
  it("rolls back an incomplete durable state change", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "control-plane-transaction-test-"));
    directories.push(directory);
    const database = new ControlDatabase(path.join(directory, "test.db"));
    const at = "2026-09-09T10:00:00.000Z";

    expect(() => database.transaction(() => {
      database.createUiEvent("partial.change", "partial-resource", at);
      throw new Error("simulated failure");
    })).toThrow("simulated failure");
    expect(database.currentUiRevision()).toBe(0);
    database.close();
  });

  it("projects node, conversation, run, message, notification, setting, and approval state", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "control-plane-test-"));
    directories.push(directory);
    const database = new ControlDatabase(path.join(directory, "test.db"));
    const at = "2026-09-09T10:00:00.000Z";

    expect(database.upsertNode({
      id: "node-1",
      name: "Build host",
      platform: "linux",
      arch: "x64",
      agentVersion: "0.1.0",
      codexVersion: "codex-cli 0.153.0",
      maxConcurrentRuns: 2,
      workspaces: [
        { id: "repo", name: "Repository", path: "/repo" },
        { id: "repo-2", name: "Other Repository", path: "/repo-2" },
      ],
      models: [{
        id: "gpt-test",
        displayName: "GPT Test",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      }],
    }, "boot-1", at)).toBe(false);
    expect(database.listNodes()[0]?.status).toBe("online");
    expect(database.listNodes()[0]?.models[0]?.id).toBe("gpt-test");
    expect(database.getWorkspace("node-1", "repo")?.path).toBe("/repo");
    expect(database.updateNodeName("node-1", "我的构建机", at)).toBe(true);
    expect(database.listNodes()[0]?.name).toBe("我的构建机");

    database.createConversation({
      id: "conversation-1",
      nodeId: "node-1",
      workspaceId: "repo",
      title: "First task",
      model: null,
      effort: "medium",
      clientRequestId: "request-1",
      remoteThreadId: null,
      status: "creating",
      error: null,
      pinnedAt: null,
      latestRunStatus: null,
      createdAt: at,
      updatedAt: at,
    });
    database.createConversation({
      id: "conversation-2",
      nodeId: "node-1",
      workspaceId: "repo-2",
      title: "Other searchable task",
      model: null,
      effort: null,
      clientRequestId: "request-2",
      remoteThreadId: "thread-2",
      status: "ready",
      error: null,
      pinnedAt: null,
      latestRunStatus: null,
      createdAt: "2026-09-09T10:00:01.000Z",
      updatedAt: "2026-09-09T10:00:01.000Z",
    });
    expect(database.getConversationByClientRequestId("request-1")?.id).toBe("conversation-1");
    database.bindConversation("conversation-1", "thread-1", at);
    database.createRun({
      id: "run-1",
      conversationId: "conversation-1",
      prompt: "Run tests",
      model: null,
      effort: null,
      clientRequestId: "run-request-1",
      remoteTurnId: null,
      status: "queued",
      progressPhase: null,
      progressLabel: null,
      progressUpdatedAt: null,
      recoveryDeadlineAt: null,
      error: null,
      createdAt: at,
      startedAt: null,
      finishedAt: null,
    });
    database.startRun({
      type: "run.started",
      commandId: "command-1",
      conversationId: "conversation-1",
      runId: "run-1",
      threadId: "thread-1",
      turnId: "turn-1",
      startedAt: at,
    });
    expect(database.getRun("run-1")?.status).toBe("running");
    expect(database.canDispatchQueuedRun("node-1", "repo")).toBe(false);
    expect(database.canDispatchQueuedRun("node-1", "repo-2")).toBe(true);
    database.updateConversation("conversation-1", { pinned: true }, at);
    const firstConversationPage = database.listConversationPage({ nodeId: "node-1", limit: 1 });
    expect(firstConversationPage.total).toBe(2);
    expect(firstConversationPage.data[0]?.id).toBe("conversation-1");
    expect(firstConversationPage.nextCursor).not.toBeNull();
    expect(database.listConversationPage({ nodeId: "node-1", limit: 1, cursor: firstConversationPage.nextCursor! }).data[0]?.id).toBe("conversation-2");
    expect(database.listConversationPage({ query: "searchable", limit: 10 }).data.map((conversation) => conversation.id)).toEqual(["conversation-2"]);
    expect(database.listConversationPage({ query: "我的构建机", limit: 10 }).total).toBe(2);
    expect(database.listConversationPage({ nodeId: "node-1", query: "我的构建机", limit: 10 }).total).toBe(0);
    expect(database.listConversationPage({ nodeId: "node-1", runStatus: "active", limit: 10 }).data.map((conversation) => conversation.id)).toEqual(["conversation-1"]);

    database.insertUserMessage({
      id: "message-user-1",
      conversationId: "conversation-1",
      runId: "run-1",
      content: "Run tests",
      createdAt: at,
    });
    expect(database.upsertMessageSnapshot({
      type: "message.snapshot",
      messageId: "message-agent-1",
      conversationId: "conversation-1",
      runId: "run-1",
      role: "assistant",
      revision: 1,
      content: "done",
      complete: false,
      occurredAt: at,
    })).toBe(true);
    expect(database.upsertMessageSnapshot({
      type: "message.snapshot",
      messageId: "message-agent-1",
      conversationId: "conversation-1",
      runId: "run-1",
      role: "assistant",
      revision: 1,
      content: "stale",
      complete: false,
      occurredAt: at,
    })).toBe(false);
    expect(database.listMessages("conversation-1").map((message) => message.content)).toEqual(["Run tests", "done"]);

    database.markNodeOffline("node-1", at);
    expect(database.getRun("run-1")?.status).toBe("recovering");
    expect(database.reconcileNodeRuns("node-1", ["run-1"], at)).toEqual([]);
    expect(database.getRun("run-1")?.status).toBe("running");

    database.createAttachment({
      id: "attachment-1",
      conversationId: null,
      messageClientId: "run-request-1",
      name: "design.png",
      mediaType: "image/png",
      size: 4,
      receivedSize: 0,
      sha256: null,
      status: "uploading",
      storageKey: "attachment-1.upload",
      downloadToken: "download-token",
      expiresAt: "2026-09-16T10:00:00.000Z",
      createdAt: at,
    });
    expect(database.updateAttachmentOffset("attachment-1", 0, 4)?.receivedSize).toBe(4);
    expect(database.finalizeAttachment("attachment-1", "abcd", "attachment-1.bin")?.status).toBe("ready");
    database.bindAttachments(["attachment-1"], "conversation-1");
    expect(database.listConversationAttachments("conversation-1")[0]?.status).toBe("consumed");

    expect(database.createUiEvent("message.updated", "conversation-1", at).revision).toBe(1);
    expect(database.listUiEventsAfter(0)[0]?.type).toBe("message.updated");

    database.insertApproval("node-1", {
      type: "interaction.requested",
      approvalId: "approval-1",
      conversationId: "conversation-1",
      runId: "run-1",
      threadId: "thread-1",
      turnId: "turn-1",
      method: "item/commandExecution/requestApproval",
      requestId: "7",
      summary: "执行测试命令",
      risk: "将在本地工作区执行",
      details: { kind: "command" },
      requestedAt: at,
    });
    expect(database.getRun("run-1")?.status).toBe("waiting_approval");
    database.createNotification({ nodeId: "node-1", conversationId: "conversation-1", runId: "run-1", kind: "waiting_user", title: "等待你的操作", createdAt: at });
    expect(database.listNotifications(true).some((notification) => notification.kind === "waiting_user")).toBe(true);
    database.resolveApproval("approval-1", { decision: "accept" }, at);
    expect(database.getApproval("approval-1")?.status).toBe("resolved");
    expect(database.listNotifications().some((notification) => notification.kind === "waiting_user")).toBe(false);
    expect(database.updateGlobalSettings({ defaultModel: "gpt-test", defaultEffort: "medium" }, at).defaultModel).toBe("gpt-test");
    database.createNotification({ nodeId: "node-1", conversationId: "conversation-1", runId: "run-1", kind: "completed", title: "任务已完成", createdAt: at });
    expect(database.listTaskCenter().some((entry) => entry.unread)).toBe(true);
    expect(database.listTaskCenter()[0]?.replyPreview).toBe("done");
    expect(database.listTaskCenter(1)).toHaveLength(1);
    expect(database.markAllNotificationsRead("2026-09-09T10:01:00.000Z")).toBe(1);
    expect(database.listNotifications(true)).toHaveLength(0);
    database.createNotification({ id: "expired-read", nodeId: "node-1", conversationId: "conversation-1", runId: null, kind: "failed", title: "旧已读", createdAt: "2026-01-01T00:00:00.000Z" });
    database.markNotificationRead("expired-read", "2026-01-02T00:00:00.000Z");
    database.createNotification({ id: "expired-unread", nodeId: "node-1", conversationId: "conversation-1", runId: null, kind: "failed", title: "旧未读", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(database.cleanupNotifications("2026-08-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z")).toBe(2);
    expect(database.listNotifications().some((notification) => notification.id.startsWith("expired-"))).toBe(false);
    database.finishRun({
      type: "run.finished",
      conversationId: "conversation-1",
      runId: "run-1",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      finishedAt: at,
    });
    expect(database.canDispatchQueuedRun("node-1", "repo")).toBe(true);
    expect(database.deleteConversation("conversation-1")).toBe(true);
    expect(database.getConversation("conversation-1")).toBeNull();
    database.close();
  });
});
