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
    expect(database.listConversationPage({ query: "searchable", limit: 10, includeTotal: false }).total).toBeUndefined();
    expect(database.listConversationPage({ nodeId: "node-1", runStatus: "active", limit: 10 }).data.map((conversation) => conversation.id)).toEqual(["conversation-1"]);

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
    });
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
    });
    database.close();
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
});
