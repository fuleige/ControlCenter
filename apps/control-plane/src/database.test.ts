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
      runtime: "codex",
      codexVersion: "codex-cli 0.153.0",
      permissionMode: "danger-full-access",
      maxConcurrentRuns: 2,
      workspaces: [
        { id: "repo", name: "Repository", path: "/repo", source: "default", isDefault: true },
        { id: "repo-2", name: "Other Repository", path: "/repo-2", source: "config", isDefault: false },
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
    expect(database.listNodes()[0]?.permissionMode).toBe("danger-full-access");
    expect(database.listNodes()[0]?.models[0]?.id).toBe("gpt-test");
    expect(database.listNodes()[0]?.runtime).toBe("codex");
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
      tokenUsage: null,
      compaction: null,
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
      tokenUsage: null,
      compaction: null,
      createdAt: "2026-09-09T10:00:01.000Z",
      updatedAt: "2026-09-09T10:00:01.000Z",
    });
    expect(database.getConversationByClientRequestId("request-1")?.id).toBe("conversation-1");
    database.bindConversation("conversation-1", "thread-1", at);
    expect(database.listTokenUsageBackfill("node-1")).toEqual(expect.arrayContaining([
      { conversationId: "conversation-1", threadId: "thread-1" },
      { conversationId: "conversation-2", threadId: "thread-2" },
    ]));
    expect(database.updateConversationTokenUsage("node-1", {
      type: "conversation.tokenUsage",
      conversationId: "conversation-1",
      threadId: "another-thread",
      turnId: "turn-1",
      totalTokens: 200_000,
      contextTokens: 80_000,
      modelContextWindow: 400_000,
      updatedAt: at,
    })).toBe(false);
    expect(database.updateConversationTokenUsage("node-1", {
      type: "conversation.tokenUsage",
      conversationId: "conversation-1",
      threadId: "thread-1",
      turnId: "turn-1",
      totalTokens: 200_000,
      contextTokens: 80_000,
      modelContextWindow: 400_000,
      updatedAt: at,
    })).toBe(true);
    expect(database.getConversation("conversation-1")?.tokenUsage).toEqual({
      totalTokens: 200_000,
      contextTokens: 80_000,
      modelContextWindow: 400_000,
      updatedAt: at,
    });
    expect(database.listTokenUsageBackfill("node-1")).not.toContainEqual({
      conversationId: "conversation-1",
      threadId: "thread-1",
    });
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
      errorCode: null,
      errorDismissedAt: null,
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
    expect(database.listTaskCenter()[0]).toMatchObject({ id: "conversation:conversation-1", notificationId: null, unread: false });
    expect(database.syncNodeActiveRuns("node-1")).toBe(true);
    expect(database.listNodes()[0]?.activeRuns).toBe(1);
    expect(database.syncNodeActiveRuns("node-1")).toBe(false);
    expect(database.updateHeartbeat("node-1", 1, at)).toBe(false);
    expect(database.hasActiveRunInWorkspace("node-1", "repo")).toBe(true);
    expect(database.hasActiveRunInWorkspace("node-1", "repo-2")).toBe(false);
    expect(database.canDispatchQueuedRun("node-1", "conversation-1")).toBe(false);
    expect(database.canDispatchQueuedRun("node-1", "conversation-2")).toBe(true);
    database.updateConversation("conversation-1", { pinned: true }, at);
    const firstConversationPage = database.listConversationPage({ nodeId: "node-1", limit: 1 });
    expect(firstConversationPage.total).toBe(2);
    expect(firstConversationPage.data[0]?.id).toBe("conversation-1");
    expect(firstConversationPage.nextCursor).not.toBeNull();
    expect(database.listConversationPage({ nodeId: "node-1", limit: 1, cursor: firstConversationPage.nextCursor! }).data[0]?.id).toBe("conversation-2");
    expect(database.listConversationPage({ query: "searchable", limit: 10 }).data.map((conversation) => conversation.id)).toEqual(["conversation-2"]);
    expect(database.listConversationPage({ query: "我的构建机", limit: 10 }).total).toBe(2);
    expect(database.listConversationPage({ nodeId: "node-1", query: "我的构建机", limit: 10 }).total).toBe(0);
    expect(database.listConversationPage({ query: "searchable", limit: 10, includeTotal: false }).total).toBeUndefined();
    expect(database.listConversationPage({ nodeId: "node-1", runStatus: "active", limit: 10 }).data.map((conversation) => conversation.id)).toEqual(["conversation-1"]);

    const firstOpenedFile = database.upsertConversationOpenedFile({
      id: "opened-file-1",
      conversationId: "conversation-1",
      path: "/repo/report.md",
      name: "report.md",
      mediaType: "text/markdown; charset=utf-8",
      size: 12,
      openedAt: "2026-09-09T10:02:00.000Z",
    });
    database.upsertConversationOpenedFile({
      id: "opened-file-2",
      conversationId: "conversation-1",
      path: "/repo/results.tsv",
      name: "results.tsv",
      mediaType: "text/tab-separated-values; charset=utf-8",
      size: 24,
      openedAt: "2026-09-09T10:03:00.000Z",
    });
    const reopenedFile = database.upsertConversationOpenedFile({
      id: "ignored-on-conflict",
      conversationId: "conversation-1",
      path: "/repo/report.md",
      name: "report.md",
      mediaType: "text/markdown; charset=utf-8",
      size: 18,
      openedAt: "2026-09-09T10:04:00.000Z",
    });
    expect(reopenedFile).toMatchObject({ id: firstOpenedFile.id, openCount: 2, size: 18 });
    expect(database.listConversationOpenedFiles("conversation-1").map((file) => file.name)).toEqual(["report.md", "results.tsv"]);
    expect(database.deleteConversationOpenedFile("conversation-1", "opened-file-2")).toBe(true);
    expect(database.deleteConversationOpenedFile("conversation-1", "opened-file-2")).toBe(false);

    database.createCommand("command-1", "node-1", {
      type: "run.interrupt",
      conversationId: "conversation-1",
      runId: "run-1",
      threadId: "thread-1",
      turnId: "turn-1",
    }, at);
    expect(database.listPendingCommands("node-1").map((command) => command.id)).toEqual(["command-1"]);
    database.updateCommand("command-1", "accepted", null, at);
    expect(database.listPendingCommands("node-1")).toEqual([]);
    expect(database.listPendingCommands("node-1", true).map((command) => command.id)).toEqual(["command-1"]);

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
    const latestMessagePage = database.listMessagePage("conversation-1", 1);
    expect(latestMessagePage.data.map((message) => message.content)).toEqual(["done"]);
    expect(latestMessagePage.nextCursor).not.toBeNull();
    expect(database.listMessagePage("conversation-1", 1, latestMessagePage.nextCursor!).data.map((message) => message.content)).toEqual(["Run tests"]);

    database.markNodeOffline("node-1", at);
    expect(database.getRun("run-1")?.status).toBe("recovering");
    expect(database.reconcileNodeRuns("node-1", ["run-1"], at)).toEqual([]);
    expect(database.getRun("run-1")?.status).toBe("running");
    expect(database.updateHeartbeat("node-1", 1, at)).toBe(true);

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

    expect(database.createUiEvent("message.updated", "message-agent-1", at, "conversation-1").revision).toBe(1);
    expect(database.listUiEventsAfter(0)[0]).toMatchObject({ type: "message.updated", conversationId: "conversation-1" });

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
    expect(database.listTaskCenter()[0]).toMatchObject({ id: "conversation:conversation-1", notificationId: "conversation:conversation-1", unread: true });
    database.resolveApproval("approval-1", { decision: "accept" }, at);
    expect(database.getApproval("approval-1")?.status).toBe("resolved");
    expect(database.listNotifications().some((notification) => notification.kind === "waiting_user")).toBe(false);
    expect(database.updateGlobalSettings({ ...database.getGlobalSettings(), defaultModel: "gpt-test", defaultEffort: "medium" }, at).defaultModel).toBe("gpt-test");
    database.createNotification({ nodeId: "node-1", conversationId: "conversation-1", runId: "run-1", kind: "completed", title: "任务已完成", createdAt: at });
    expect(database.listTaskCenter().some((entry) => entry.unread)).toBe(true);
    expect(database.listTaskCenter()[0]?.replyPreview).toBe("done");
    expect(database.listTaskCenter(1)).toHaveLength(1);
    expect(database.markAllNotificationsRead("2026-09-09T10:01:00.000Z")).toBe(1);
    expect(database.listNotifications(true)).toHaveLength(0);
    expect(database.listTaskCenter()[0]?.notificationId).toBe("conversation:conversation-1");
    expect(database.notificationConversationId("conversation:conversation-1")).toBe("conversation-1");
    expect(database.notificationConversationId("missing")).toBeNull();
    expect(database.markConversationUnread("missing", at)).toBeNull();
    expect(database.markConversationUnread("conversation-1", at)).toBe(true);
    expect(database.markConversationUnread("conversation-1", at)).toBe(false);
    expect(database.listNotifications(true)).toHaveLength(1);
    expect(database.markConversationNotificationsRead("conversation-1", at)).toBe(1);
    expect(database.listNotifications(true)).toHaveLength(0);
    database.finishRun({
      type: "run.finished",
      conversationId: "conversation-1",
      runId: "run-1",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      finishedAt: at,
    });
    expect(database.syncNodeActiveRuns("node-1")).toBe(true);
    expect(database.listNodes()[0]?.activeRuns).toBe(0);
    expect(database.updateHeartbeat("node-1", 1, at)).toBe(true);
    expect(database.updateHeartbeat("node-1", 1, at)).toBe(false);
    expect(database.hasActiveRunInWorkspace("node-1", "repo")).toBe(false);
    expect(database.canDispatchQueuedRun("node-1", "conversation-1")).toBe(true);

    database.createRun({
      id: "run-error",
      conversationId: "conversation-1",
      prompt: "Task interrupted by restart",
      model: null,
      effort: null,
      clientRequestId: "run-error-request",
      remoteTurnId: null,
      status: "queued",
      progressPhase: null,
      progressLabel: null,
      progressUpdatedAt: null,
      recoveryDeadlineAt: null,
      error: null,
      errorCode: null,
      errorDismissedAt: null,
      createdAt: at,
      startedAt: null,
      finishedAt: null,
    });
    database.failRun("run-error", "节点重启后无法确认原任务状态", at);
    expect(database.getRun("run-error")?.errorDismissedAt).toBeNull();
    const dismissedAt = "2026-09-09T10:05:00.000Z";
    expect(database.dismissRunError("run-error", dismissedAt)).toBe(true);
    expect(database.getRun("run-error")).toMatchObject({
      status: "failed",
      error: "节点重启后无法确认原任务状态",
      errorDismissedAt: dismissedAt,
    });

    expect(database.deleteConversation("conversation-1")).toBe(true);
    expect(database.getConversation("conversation-1")).toBeNull();
    expect(database.listConversationOpenedFiles("conversation-1")).toEqual([]);
    database.close();
  });

  it("persists Web workspaces and retains a previous default for bound conversations", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "control-plane-workspace-test-"));
    directories.push(directory);
    const database = new ControlDatabase(path.join(directory, "test.db"));
    const firstAt = "2026-09-09T10:00:00.000Z";
    const secondAt = "2026-09-09T11:00:00.000Z";
    const descriptor = {
      id: "node-workspaces",
      name: "Workspace host",
      platform: "linux",
      arch: "x64",
      agentVersion: "0.2.0",
      runtime: "codex",
      codexVersion: "codex-cli 0.154.0",
      maxConcurrentRuns: 2,
      models: [],
    };
    database.upsertNode({
      ...descriptor,
      workspaces: [{ id: "default-a", name: "Project A", path: "/projects/a", source: "default", isDefault: true }],
    }, "boot-a", firstAt);
    expect(database.listNodes()[0]?.permissionMode).toBe("workspace-write");
    expect(database.getWorkspace(descriptor.id, "default-a")?.isDefault).toBe(true);
    database.upsertNode({
      ...descriptor,
      runtime: "claude",
      codexVersion: "2.1.310 (Claude Code)",
      workspaces: [{ id: "default-a", name: "Project A", path: "/projects/a", source: "default", isDefault: true }],
    }, "boot-a", firstAt);
    expect(database.listNodes()[0]).toMatchObject({ runtime: "claude", codexVersion: "2.1.310 (Claude Code)" });
    // Codex Agents released before runtime selection do not report it.
    const { runtime: _runtime, ...codexAgentBeforeRuntime } = descriptor;
    database.upsertNode({
      ...codexAgentBeforeRuntime,
      workspaces: [{ id: "default-a", name: "Project A", path: "/projects/a", source: "default", isDefault: true }],
    }, "boot-a", firstAt);
    expect(database.listNodes()[0]?.runtime).toBe("codex");

    const managed = database.createWebWorkspace({
      id: "managed-b",
      nodeId: descriptor.id,
      name: "Project B",
      path: "/projects/b",
      now: firstAt,
    });
    expect(managed.source).toBe("web");
    expect(database.listManagedWorkspacesForAgent(descriptor.id)).toEqual([{
      id: "managed-b",
      name: "Project B",
      path: "/projects/b",
      source: "web",
    }]);
    expect(database.findWorkspaceByPath(descriptor.id, "/projects/b")?.id).toBe("managed-b");
    expect(database.updateWorkspaceValidation(descriptor.id, "managed-b", false, "missing", secondAt)?.status).toBe("invalid");
    expect(database.updateWorkspace({ nodeId: descriptor.id, id: "managed-b", path: "/projects/b-new", now: secondAt })?.status).toBe("valid");
    database.createWebWorkspace({
      id: "managed-current",
      nodeId: descriptor.id,
      name: "Future default alias",
      path: "/projects/c",
      now: firstAt,
    });

    database.createConversation({
      id: "old-default-conversation",
      nodeId: descriptor.id,
      workspaceId: "default-a",
      title: "Old default",
      model: null,
      effort: null,
      clientRequestId: "old-default-request",
      remoteThreadId: "old-default-thread",
      status: "ready",
      error: null,
      pinnedAt: null,
      latestRunStatus: null,
      tokenUsage: null,
      compaction: null,
      createdAt: firstAt,
      updatedAt: firstAt,
    });
    database.createConversation({
      id: "managed-current-conversation",
      nodeId: descriptor.id,
      workspaceId: "managed-current",
      title: "Future default via Web",
      model: null,
      effort: null,
      clientRequestId: "managed-current-request",
      remoteThreadId: "managed-current-thread",
      status: "ready",
      error: null,
      pinnedAt: null,
      latestRunStatus: null,
      tokenUsage: null,
      compaction: null,
      createdAt: firstAt,
      updatedAt: firstAt,
    });
    database.upsertNode({
      ...descriptor,
      workspaces: [{ id: "default-c", name: "Project C", path: "/projects/c", source: "default", isDefault: true }],
    }, "boot-b", secondAt);
    expect(database.getWorkspace(descriptor.id, "default-c")?.isDefault).toBe(true);
    expect(database.getWorkspace(descriptor.id, "default-a")?.source).toBe("history");
    expect(database.getWorkspace(descriptor.id, "managed-current")?.source).toBe("history");
    expect(database.listManagedWorkspacesForAgent(descriptor.id).map((workspace) => workspace.id).sort()).toEqual(["default-a", "managed-b", "managed-current"]);
    expect(database.deleteUnusedWorkspace(descriptor.id, "managed-b")).toBe(true);
    expect(database.getWorkspace(descriptor.id, "managed-b")).toBeNull();
    expect(database.deleteUnusedWorkspace(descriptor.id, "default-a")).toBe(false);
    database.close();
  });

  it("persists context compaction progress, recovery, completion, and categorized failures", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "control-plane-compaction-test-"));
    directories.push(directory);
    const database = new ControlDatabase(path.join(directory, "test.db"), { recoverRuntimeState: false });
    const requestedAt = "2026-09-15T08:00:00.000Z";
    database.upsertNode({
      id: "node-compact",
      name: "Compact host",
      platform: "linux",
      arch: "x64",
      agentVersion: "0.3.7",
      runtime: "codex",
      codexVersion: "codex-cli 0.154.0",
      permissionMode: "workspace-write",
      maxConcurrentRuns: 1,
      workspaces: [{ id: "default", name: "Default", path: "/repo", source: "default", isDefault: true }],
      models: [],
    }, "boot-1", requestedAt);
    database.createConversation({
      id: "conversation-compact",
      nodeId: "node-compact",
      workspaceId: "default",
      title: "Long conversation",
      model: null,
      effort: null,
      clientRequestId: null,
      remoteThreadId: "thread-compact",
      status: "ready",
      error: null,
      pinnedAt: null,
      latestRunStatus: null,
      tokenUsage: null,
      compaction: null,
      createdAt: requestedAt,
      updatedAt: requestedAt,
    });
    database.updateConversationTokenUsage("node-compact", {
      type: "conversation.tokenUsage",
      conversationId: "conversation-compact",
      threadId: "thread-compact",
      totalTokens: 180_000,
      contextTokens: 80_000,
      modelContextWindow: 100_000,
      updatedAt: requestedAt,
    });

    expect(database.createConversationCompaction("conversation-compact", "compact-1", requestedAt)).toMatchObject({
      status: "queued",
      beforeContextTokens: 80_000,
      errorDismissedAt: null,
    });
    expect(database.dismissConversationCompactionError("conversation-compact", "compact-1", requestedAt)).toBe(false);
    database.markConversationCompactionDispatching("conversation-compact", "compact-1");
    expect(database.getConversation("conversation-compact")?.compaction?.status).toBe("dispatching");
    expect(database.updateConversationCompaction("node-compact", {
      type: "conversation.compaction",
      compactionId: "compact-1",
      conversationId: "conversation-compact",
      threadId: "thread-compact",
      status: "running",
      beforeContextTokens: 80_000,
      occurredAt: "2026-09-15T08:00:01.000Z",
    })).toBe(true);
    database.markNodeOffline("node-compact", "2026-09-15T08:00:02.000Z");
    expect(database.getConversation("conversation-compact")?.compaction?.status).toBe("recovering");
    expect(database.reconcileNodeCompactions("node-compact", ["compact-1"], "2026-09-15T08:00:03.000Z")).toEqual(["conversation-compact"]);
    expect(database.updateConversationCompaction("node-compact", {
      type: "conversation.compaction",
      compactionId: "compact-1",
      conversationId: "conversation-compact",
      threadId: "thread-compact",
      status: "completed",
      beforeContextTokens: 80_000,
      afterContextTokens: 24_000,
      occurredAt: "2026-09-15T08:00:04.000Z",
    })).toBe(true);
    expect(database.getConversation("conversation-compact")?.compaction).toMatchObject({
      status: "completed",
      beforeContextTokens: 80_000,
      afterContextTokens: 24_000,
      error: null,
    });
    expect(database.dismissConversationCompactionError("conversation-compact", "compact-1", requestedAt)).toBe(false);

    database.createConversationCompaction("conversation-compact", "compact-2", "2026-09-15T08:01:00.000Z");
    database.applyAgentError({
      type: "agent.error",
      conversationId: "conversation-compact",
      compactionId: "compact-2",
      errorCode: "authentication_failed",
      message: "节点上的 Codex 登录已失效，请在节点重新登录",
      occurredAt: "2026-09-15T08:01:01.000Z",
    }, "2026-09-15T08:01:01.000Z");
    expect(database.getConversation("conversation-compact")?.compaction).toMatchObject({
      status: "failed",
      errorCode: "authentication_failed",
      error: expect.stringContaining("登录已失效"),
      errorDismissedAt: null,
    });
    const legacyFailure = { ...database.getConversation("conversation-compact")!.compaction! };
    delete legacyFailure.errorDismissedAt;
    database.sqlite.prepare("UPDATE conversations SET compaction_json = ? WHERE id = ?")
      .run(JSON.stringify(legacyFailure), "conversation-compact");
    expect(database.getConversation("conversation-compact")?.compaction?.errorDismissedAt).toBeNull();

    const dismissedAt = "2026-09-15T08:02:00.000Z";
    expect(database.dismissConversationCompactionError("missing-conversation", "compact-2", dismissedAt)).toBe(false);
    expect(database.dismissConversationCompactionError("conversation-compact", "compact-1", dismissedAt)).toBe(false);
    expect(database.dismissConversationCompactionError("conversation-compact", "compact-2", dismissedAt)).toBe(true);
    expect(database.getConversation("conversation-compact")?.compaction).toMatchObject({
      ...legacyFailure,
      errorDismissedAt: dismissedAt,
    });
    expect(database.updateConversationCompaction("node-compact", {
      type: "conversation.compaction", compactionId: "compact-2", conversationId: "conversation-compact",
      threadId: "thread-compact", status: "failed", error: "重复的失败通知", occurredAt: dismissedAt,
    })).toBe(false);
    database.close();

    const reopened = new ControlDatabase(path.join(directory, "test.db"), { recoverRuntimeState: false });
    expect(reopened.getConversation("conversation-compact")?.compaction?.errorDismissedAt).toBe(dismissedAt);
    expect(reopened.createConversationCompaction("conversation-compact", "compact-3", dismissedAt).errorDismissedAt).toBeNull();
    reopened.failConversationCompaction("conversation-compact", "compact-3", "新的压缩失败", dismissedAt);
    expect(reopened.dismissConversationCompactionError("conversation-compact", "compact-2", dismissedAt)).toBe(false);
    expect(reopened.getConversation("conversation-compact")?.compaction).toMatchObject({
      id: "compact-3", status: "failed", error: "新的压缩失败", errorDismissedAt: null,
    });
    reopened.close();
  });

  it("stores revocable admin sessions and consumes enrollment tokens exactly once", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "control-plane-auth-test-"));
    directories.push(directory);
    const database = new ControlDatabase(path.join(directory, "test.db"), { recoverRuntimeState: false });
    const createdAt = "2026-09-10T08:00:00.000Z";
    const expiresAt = "2026-09-10T08:10:00.000Z";

    database.setAdminTokenHash("admin-hash", createdAt);
    expect(database.getAdminTokenHash()).toBe("admin-hash");
    database.createAdminSession({
      id: "session-1",
      tokenHash: "session-hash",
      createdAt,
      lastSeenAt: createdAt,
      expiresAt,
      revokedAt: null,
    });
    expect(database.getAdminSession("session-1")?.tokenHash).toBe("session-hash");
    database.touchAdminSession("session-1", "2026-09-10T08:01:00.000Z");
    expect(database.getAdminSession("session-1")?.lastSeenAt).toBe("2026-09-10T08:01:00.000Z");
    expect(database.revokeAllAdminSessions("2026-09-10T08:02:00.000Z")).toBe(1);
    expect(database.getAdminSession("session-1")?.revokedAt).toBe("2026-09-10T08:02:00.000Z");

    database.createEnrollmentToken({
      id: "enrollment-1",
      tokenHash: "enrollment-hash",
      tokenCiphertext: "encrypted-enrollment-token",
      createdAt,
      expiresAt,
      usedAt: null,
      revokedAt: null,
      nodeId: null,
      credentialId: null,
    });
    const enrollment = {
      id: "enrollment-1",
      nodeId: "node-1",
      credentialId: "credential-1",
      credentialHash: "credential-hash",
      usedAt: "2026-09-10T08:03:00.000Z",
    };
    expect(database.consumeEnrollmentToken(enrollment)).toBe(true);
    expect(database.consumeEnrollmentToken(enrollment)).toBe(true);
    expect(database.consumeEnrollmentToken({ ...enrollment, nodeId: "node-2" })).toBe(false);
    expect(database.getEnrollmentToken("enrollment-1")).toMatchObject({ nodeId: "node-1", credentialId: "credential-1" });
    expect(database.getNodeCredential("credential-1")).toMatchObject({ nodeId: "node-1", tokenHash: "credential-hash" });
    expect(database.nodeHasCredentials("node-1")).toBe(true);
    expect(database.revokeNodeCredentials("node-1", "2026-09-10T08:04:00.000Z")).toBe(1);
    expect(database.getNodeCredential("credential-1")?.revokedAt).toBe("2026-09-10T08:04:00.000Z");
    expect(database.revokeEnrollmentToken("enrollment-1", "2026-09-10T08:04:00.000Z")).toBe(false);
    expect(database.cleanupEnrollmentTokens("2026-09-10T08:09:59.999Z")).toBe(0);
    expect(database.cleanupEnrollmentTokens(expiresAt)).toBe(1);
    expect(database.getEnrollmentToken("enrollment-1")).toBeNull();
    database.close();
  });

  it("deletes every runtime entry of a machine with its conversations, history and credentials", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "control-plane-node-delete-test-"));
    directories.push(directory);
    const database = new ControlDatabase(path.join(directory, "test.db"), { recoverRuntimeState: false });
    const at = "2026-10-30T08:00:00.000Z";
    for (const nodeId of ["node-1", "node-2"]) {
      database.upsertNode({
        id: nodeId,
        name: nodeId,
        platform: "linux",
        arch: "x64",
        agentVersion: "0.3.23",
        runtime: "codex",
        codexVersion: "codex-cli 0.164.0",
        maxConcurrentRuns: 1,
        workspaces: [{ id: "repo", name: "Repository", path: "/repo", source: "default", isDefault: true }],
      }, "boot-1", at);
      database.createConversation({
        id: `${nodeId}-conversation`,
        nodeId,
        workspaceId: "repo",
        title: "Task",
        model: null,
        effort: null,
        clientRequestId: `${nodeId}-request`,
        remoteThreadId: `${nodeId}-thread`,
        status: "ready",
        error: null,
        pinnedAt: null,
        latestRunStatus: null,
        tokenUsage: null,
        compaction: null,
        createdAt: at,
        updatedAt: at,
      });
      database.createRun({
        id: `${nodeId}-run`,
        conversationId: `${nodeId}-conversation`,
        prompt: "Run tests",
        model: null,
        effort: null,
        clientRequestId: `${nodeId}-run-request`,
        remoteTurnId: null,
        status: "queued",
        progressPhase: null,
        progressLabel: null,
        progressUpdatedAt: null,
        recoveryDeadlineAt: null,
        error: null,
        errorCode: null,
        errorDismissedAt: null,
        createdAt: at,
        startedAt: null,
        finishedAt: null,
      });
      database.insertUserMessage({ id: `${nodeId}-message`, conversationId: `${nodeId}-conversation`, runId: `${nodeId}-run`, content: "Run tests", createdAt: at });
      database.insertApproval(nodeId, {
        type: "interaction.requested",
        approvalId: `${nodeId}-approval`,
        conversationId: `${nodeId}-conversation`,
        runId: `${nodeId}-run`,
        threadId: `${nodeId}-thread`,
        turnId: "turn-1",
        method: "item/commandExecution/requestApproval",
        requestId: "1",
        summary: "执行测试命令",
        risk: "将在本地工作区执行",
        details: { kind: "command" },
        requestedAt: at,
      });
      database.createNotification({ nodeId, conversationId: `${nodeId}-conversation`, runId: `${nodeId}-run`, kind: "waiting_user", title: "等待你的操作", createdAt: at });
      database.createCommand(`${nodeId}-command`, nodeId, {
        type: "run.interrupt",
        conversationId: `${nodeId}-conversation`,
        runId: `${nodeId}-run`,
        threadId: `${nodeId}-thread`,
        turnId: "turn-1",
      }, at);
      database.recordDelivery(nodeId, "boot-1", 1, at);
      database.createAttachment({
        id: `${nodeId}-attachment`,
        conversationId: `${nodeId}-conversation`,
        messageClientId: `${nodeId}-run-request`,
        name: "design.png",
        mediaType: "image/png",
        size: 4,
        receivedSize: 4,
        sha256: "abcd",
        status: "ready",
        storageKey: `${nodeId}-attachment.bin`,
        downloadToken: "download-token",
        expiresAt: "2026-11-06T08:00:00.000Z",
        createdAt: at,
      });
      database.createEnrollmentToken({
        id: `${nodeId}-enrollment`,
        tokenHash: "enrollment-hash",
        tokenCiphertext: null,
        createdAt: at,
        expiresAt: "2026-10-30T08:10:00.000Z",
        usedAt: null,
        revokedAt: null,
        nodeId: null,
        credentialId: null,
      });
      database.consumeEnrollmentToken({
        id: `${nodeId}-enrollment`,
        nodeId,
        credentialId: `${nodeId}-credential`,
        credentialHash: "credential-hash",
        usedAt: at,
      });
    }
    // A Claude runtime started from node-1's data directory shares its machine and credential.
    database.upsertNode({
      id: "node-1-claude",
      machineId: "node-1",
      name: "node-1",
      platform: "linux",
      arch: "x64",
      agentVersion: "0.3.23",
      runtime: "claude",
      codexVersion: "2.1.310 (Claude Code)",
      maxConcurrentRuns: 1,
      workspaces: [{ id: "repo", name: "Repository", path: "/repo", source: "default", isDefault: true }],
    }, "boot-2", at);
    database.createConversation({
      id: "node-1-claude-conversation",
      nodeId: "node-1-claude",
      workspaceId: "repo",
      title: "Claude task",
      model: null,
      effort: null,
      clientRequestId: "node-1-claude-request",
      remoteThreadId: null,
      status: "ready",
      error: null,
      pinnedAt: null,
      latestRunStatus: null,
      tokenUsage: null,
      compaction: null,
      createdAt: at,
      updatedAt: at,
    });
    expect(database.listNodes().find((node) => node.id === "node-1-claude")).toMatchObject({ machineId: "node-1", accessMode: "enrolled" });
    database.updateNodeName("node-1", "构建机", at);
    expect(database.listNodes().find((node) => node.id === "node-1-claude")?.name).toBe("构建机");
    database.updateNodeName("node-1-claude", "构建机 Claude", at);
    expect(database.listNodes().find((node) => node.id === "node-1-claude")?.name).toBe("构建机 Claude");
    expect(database.machineIdOf("node-1-claude")).toBe("node-1");
    expect(database.machineNodeIds("node-1")).toEqual(["node-1", "node-1-claude"]);

    expect(database.countActiveMachineRuns("node-1")).toBe(1);
    expect(database.deleteMachine("node-1")).toEqual({ nodeIds: ["node-1", "node-1-claude"], attachmentStorageKeys: ["node-1-attachment.bin"] });
    expect(database.deleteMachine("node-1")).toEqual({ nodeIds: [], attachmentStorageKeys: [] });
    expect(database.countActiveMachineRuns("node-1")).toBe(0);
    expect(database.listNodes().map((node) => node.id)).toEqual(["node-2"]);
    expect(database.getConversation("node-1-claude-conversation")).toBeNull();
    expect(database.getConversation("node-1-conversation")).toBeNull();
    expect(database.getRun("node-1-run")).toBeNull();
    expect(database.getApproval("node-1-approval")).toBeNull();
    expect(database.getWorkspace("node-1", "repo")).toBeNull();
    expect(database.listPendingCommands("node-1", true)).toEqual([]);
    expect(database.getNodeCredential("node-1-credential")).toBeNull();
    expect(database.nodeHasCredentials("node-1")).toBe(false);
    expect(database.getEnrollmentToken("node-1-enrollment")).toBeNull();
    expect(database.listNotifications(true).map((notification) => notification.nodeId)).toEqual(["node-2"]);

    expect(database.getConversation("node-2-conversation")?.nodeId).toBe("node-2");
    expect(database.getRun("node-2-run")).not.toBeNull();
    expect(database.getApproval("node-2-approval")).not.toBeNull();
    expect(database.listPendingCommands("node-2").map((command) => command.id)).toEqual(["node-2-command"]);
    expect(database.getNodeCredential("node-2-credential")?.nodeId).toBe("node-2");
    expect(database.listConversationAttachments("node-2-conversation").map((attachment) => attachment.id)).toEqual(["node-2-attachment"]);
    expect(database.countActiveMachineRuns("node-2")).toBe(1);
    database.close();
  });

  it("warns about concurrent work in a directory across the runtimes of one machine only", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "control-plane-machine-workspace-test-"));
    directories.push(directory);
    const database = new ControlDatabase(path.join(directory, "test.db"), { recoverRuntimeState: false });
    const at = "2026-10-30T09:00:00.000Z";
    const entries = [
      { id: "machine-1", machineId: "machine-1", runtime: "codex" as const },
      { id: "machine-1-claude", machineId: "machine-1", runtime: "claude" as const },
      { id: "machine-2", machineId: "machine-2", runtime: "codex" as const },
    ];
    for (const entry of entries) {
      database.upsertNode({
        ...entry,
        name: entry.machineId,
        platform: "linux",
        arch: "x64",
        agentVersion: "0.3.23",
        codexVersion: "test",
        maxConcurrentRuns: 1,
        workspaces: [{ id: "repo", name: "Repository", path: "/repo", source: "default", isDefault: true }],
      }, `${entry.id}-boot`, at);
    }
    database.createConversation({
      id: "codex-conversation",
      nodeId: "machine-1",
      workspaceId: "repo",
      title: "Codex task",
      model: null,
      effort: null,
      clientRequestId: "codex-request",
      remoteThreadId: "thread",
      status: "ready",
      error: null,
      pinnedAt: null,
      latestRunStatus: null,
      tokenUsage: null,
      compaction: null,
      createdAt: at,
      updatedAt: at,
    });
    database.createRun({
      id: "codex-run",
      conversationId: "codex-conversation",
      prompt: "Refactor",
      model: null,
      effort: null,
      clientRequestId: "codex-run-request",
      remoteTurnId: null,
      status: "running",
      progressPhase: null,
      progressLabel: null,
      progressUpdatedAt: null,
      recoveryDeadlineAt: null,
      error: null,
      errorCode: null,
      errorDismissedAt: null,
      createdAt: at,
      startedAt: at,
      finishedAt: null,
    });

    expect(database.hasActiveRunInWorkspace("machine-1-claude", "repo")).toBe(true);
    expect(database.hasActiveRunInWorkspace("machine-2", "repo")).toBe(false);
    expect(database.countActiveMachineRuns("machine-1")).toBe(1);
    // Runs on a disconnected entry cannot be orphaned by deleting it.
    database.markNodeOffline("machine-1", at);
    expect(database.countActiveMachineRuns("machine-1")).toBe(0);
    database.close();
  });

  it("shares Web workspaces among the runtimes of a machine while startup directories stay per runtime", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "control-plane-shared-workspace-test-"));
    directories.push(directory);
    const database = new ControlDatabase(path.join(directory, "test.db"), { recoverRuntimeState: false });
    const at = "2026-10-30T10:00:00.000Z";
    const join = (id: string, machineId: string, runtime: "codex" | "claude", startup: string) => database.upsertNode({
      id, machineId, runtime, name: machineId, platform: "linux", arch: "x64", agentVersion: "0.3.24",
      codexVersion: "test", maxConcurrentRuns: 1,
      workspaces: [{ id: startup.slice(1), name: startup.slice(1), path: startup, source: "default", isDefault: true }],
    }, `${id}-boot`, at);
    const listed = (nodeId: string) => database.listWorkspaces(nodeId, true)
      .map((workspace) => [workspace.id, workspace.source, workspace.archivedAt ? "archived" : "active"]);
    join("machine-1", "machine-1", "codex", "/codex-dir");
    join("machine-2", "machine-2", "codex", "/other-machine");
    database.createWebWorkspace({ id: "web-shared", nodeId: "machine-1", name: "Shared", path: "/shared", now: at });
    database.createWebWorkspace({ id: "web-claude-dir", nodeId: "machine-1", name: "Claude dir", path: "/claude-dir", now: at });

    // A Claude entry joining later lists the machine's Web workspaces, except a
    // directory it already lists as its own startup directory.
    join("machine-1-claude", "machine-1", "claude", "/claude-dir");
    expect(listed("machine-1-claude")).toEqual([["claude-dir", "default", "active"], ["web-shared", "web", "active"]]);
    expect(listed("machine-2").map(([id]) => id)).toEqual(["other-machine"]);
    database.createWebWorkspace({ id: "web-later", nodeId: "machine-1-claude", name: "Later", path: "/later", now: at });
    expect(listed("machine-1").map(([id]) => id)).toEqual(["codex-dir", "web-claude-dir", "web-later", "web-shared"]);
    expect(database.listManagedWorkspacesForAgent("machine-1-claude").map((workspace) => workspace.id)).toEqual(["web-later", "web-shared"]);

    // Changes made through either runtime apply to every copy.
    database.updateWorkspace({ nodeId: "machine-1-claude", id: "web-shared", name: "Renamed", now: at });
    expect(database.getWorkspace("machine-1", "web-shared")?.name).toBe("Renamed");
    database.updateWorkspaceValidation("machine-1", "web-shared", false, "missing", at);
    expect(database.getWorkspace("machine-1-claude", "web-shared")).toMatchObject({ status: "invalid", validationError: "missing" });
    expect(database.workspaceCopyNodeIds("machine-1", "web-shared")).toEqual(["machine-1", "machine-1-claude"]);
    expect(database.workspaceCopyNodeIds("machine-1", "codex-dir")).toEqual(["machine-1"]);

    // A conversation of one runtime keeps the shared workspace for both.
    database.createConversation({
      id: "claude-conversation", nodeId: "machine-1-claude", workspaceId: "web-shared", title: "Claude task",
      model: null, effort: null, clientRequestId: "claude-request", remoteThreadId: null, status: "ready", error: null,
      pinnedAt: null, latestRunStatus: null, tokenUsage: null, compaction: null, createdAt: at, updatedAt: at,
    });
    expect(database.getWorkspace("machine-1", "web-shared")?.conversationCount).toBe(1);
    expect(database.deleteUnusedWorkspace("machine-1", "web-shared")).toBe(false);
    database.updateWorkspace({ nodeId: "machine-1", id: "web-shared", archived: true, now: at });
    expect(database.getWorkspace("machine-1-claude", "web-shared")?.archivedAt).toBe(at);
    expect(database.deleteUnusedWorkspace("machine-1-claude", "web-later")).toBe(true);
    expect(listed("machine-1").map(([id]) => id)).not.toContain("web-later");
    expect(listed("machine-1-claude").map(([id]) => id)).not.toContain("web-later");
    database.close();
  });

  it("keeps conversation defaults per runtime and starts Claude on Opus at extra-high effort", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "control-plane-runtime-defaults-test-"));
    directories.push(directory);
    const database = new ControlDatabase(path.join(directory, "test.db"), { recoverRuntimeState: false });
    const at = "2026-10-30T10:00:00.000Z";
    expect(database.getGlobalSettings()).toEqual({
      defaultModel: null, defaultEffort: null, claudeDefaultModel: "opus", claudeDefaultEffort: "xhigh",
    });
    // Clearing a Claude default is kept rather than replaced by the initial one.
    database.updateGlobalSettings({ defaultModel: "gpt-test", defaultEffort: "high", claudeDefaultModel: null, claudeDefaultEffort: "max" }, at);
    expect(database.getGlobalSettings()).toEqual({
      defaultModel: "gpt-test", defaultEffort: "high", claudeDefaultModel: null, claudeDefaultEffort: "max",
    });
    database.close();
  });
});
