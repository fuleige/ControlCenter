import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ControlDatabase, type RunRecord } from "./database.js";

const directories: string[] = [];
const databases: ControlDatabase[] = [];
const at = "2026-09-30T01:00:00.000Z";
const later = "2026-09-30T02:00:00.000Z";

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "conversation-attention-"));
  directories.push(directory);
  const filename = path.join(directory, "test.db");
  const database = new ControlDatabase(filename);
  databases.push(database);
  database.upsertNode({
    id: "node", name: "Host", platform: "linux", arch: "x64", agentVersion: "0.1.0",
    codexVersion: "test", permissionMode: "workspace-write", maxConcurrentRuns: 5,
    workspaces: [{ id: "repo", name: "Repo", path: "/repo", source: "default", isDefault: true }], models: [],
  }, "boot", at);
  return { database, filename };
}

function conversation(database: ControlDatabase, id: string, updatedAt = at) {
  database.createConversation({
    id, nodeId: "node", workspaceId: "repo", title: id, model: null, effort: null,
    clientRequestId: null, remoteThreadId: id, status: "ready", error: null, pinnedAt: null,
    latestRunStatus: null, tokenUsage: null, compaction: null, createdAt: updatedAt, updatedAt,
  });
}

function run(database: ControlDatabase, id: string, conversationId: string, status: RunRecord["status"], createdAt = at) {
  database.createRun({
    id, conversationId, status, prompt: id, model: null, effort: null, clientRequestId: null,
    remoteTurnId: id, progressPhase: null, progressLabel: null, progressUpdatedAt: null,
    recoveryDeadlineAt: null, error: null, errorCode: null, errorDismissedAt: null,
    createdAt, startedAt: createdAt, finishedAt: status === "completed" || status === "failed" ? createdAt : null,
  });
}

describe("conversation attention", () => {
  it("returns authoritative mutation state and keeps revisions monotonic after retention and restart", () => {
    const { database, filename } = fixture();
    conversation(database, "chat");
    database.markConversationUnread("chat", at);
    const event = database.createUiEvent("notification.unread", "chat", at, "chat");
    expect(database.conversationAttentionState("chat")).toEqual({
      conversationId: "chat", unread: true, unreadAt: at, manualUnreadAt: at,
      unreadCount: 1, nodeUnreadCounts: { node: 1 }, revision: event.revision,
    });
    expect(database.markConversationNotificationsRead("chat", later)).toBe(1);
    const read = database.createUiEvent("notification.updated", "chat", later, "chat");
    expect(database.conversationAttentionState("chat")).toEqual({
      conversationId: "chat", unread: false, unreadAt: null, manualUnreadAt: null,
      unreadCount: 0, nodeUnreadCounts: {}, revision: read.revision,
    });
    expect(database.conversationAttentionState(null).unread).toBe(false);
    expect(database.cleanupUiEvents("2027-01-01T00:00:00.000Z")).toBe(2);
    expect(database.currentUiRevision()).toBe(read.revision);
    const reopened = new ControlDatabase(filename);
    databases.push(reopened);
    expect(reopened.currentUiRevision()).toBe(read.revision);
    expect(reopened.createUiEvent("node.updated", "node", later).revision).toBeGreaterThan(read.revision);
  });

  it("keeps one reminder per conversation and uses the latest run, independently of unread", () => {
    const { database } = fixture();
    conversation(database, "chat");
    run(database, "old-run", "chat", "failed");
    const old = database.createNotification({ nodeId: "node", conversationId: "chat", runId: "old-run", kind: "failed", title: "failed", createdAt: at });
    database.markConversationNotificationsRead("chat", at);
    expect(database.markConversationUnread("chat", later)).toBe(true);
    run(database, "new-run", "chat", "running", later);
    expect(database.listTaskCenter()).toMatchObject([{ conversationId: "chat", runId: "new-run", status: "running", unread: true, manualUnread: true }]);
    database.finishRun({ type: "run.finished", conversationId: "chat", runId: "new-run", threadId: "chat", turnId: "new-run", status: "completed", finishedAt: later });
    database.createNotification({ nodeId: "node", conversationId: "chat", runId: "new-run", kind: "completed", title: "done", createdAt: later });
    expect(database.listNotifications()).toMatchObject([{ id: old.id, runId: "new-run", manualUnreadAt: later }]);
    expect(database.listTaskCenter()).toMatchObject([{ status: "completed", unread: true, occurredAt: later }]);
    expect(database.unreadConversationCounts()).toEqual({ unreadCount: 1, nodeUnreadCounts: { node: 1 } });
    expect(database.markConversationNotificationsRead("chat", later)).toBe(1);
    expect(database.markConversationNotificationsRead("chat", later)).toBe(0);
    expect(database.listTaskCenter()[0]).toMatchObject({ unread: false, manualUnread: false });
  });

  it("restores old or missing reminders and keeps manual unread through cleanup until read", () => {
    const { database } = fixture();
    const ancient = "2026-01-01T00:00:00.000Z";
    conversation(database, "old", ancient);
    conversation(database, "empty", ancient);
    run(database, "old-run", "old", "completed", ancient);
    database.createNotification({ nodeId: "node", conversationId: "old", runId: "old-run", kind: "completed", title: "done", createdAt: ancient });
    expect(database.cleanupNotifications(at, at)).toBe(1);
    expect(database.listTaskCenter()).toHaveLength(0);
    expect(database.markConversationUnread("old", later)).toBe(true);
    expect(database.markConversationUnread("empty", later)).toBe(true);
    expect(database.markConversationUnread("old", later)).toBe(false);
    expect(database.listTaskCenter()).toHaveLength(2);
    expect(database.listTaskCenter().find((entry) => entry.conversationId === "old")).toMatchObject({ occurredAt: ancient, attentionAt: later, status: "completed" });
    expect(database.getConversation("old")).toMatchObject({ unread: true, unreadAt: later, updatedAt: ancient });
    expect(database.cleanupNotifications("2027-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z", 1)).toBe(0);
    expect(database.markAllNotificationsRead(later)).toBe(2);
    expect(database.cleanupNotifications("2027-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z")).toBe(2);
    expect(database.getConversation("old")).toMatchObject({ unread: false });
    expect(database.markConversationUnread("missing", later)).toBeNull();
  });

  it("counts outside the 200-entry window and paginates in pinned, unread, time order", () => {
    const { database } = fixture();
    for (let index = 0; index < 205; index++) {
      const id = `chat-${String(index).padStart(3, "0")}`;
      conversation(database, id, new Date(Date.parse(at) + index * 1000).toISOString());
      database.markConversationUnread(id, new Date(Date.parse(at) + index * 1000).toISOString());
    }
    expect(database.listTaskCenter()).toHaveLength(200);
    expect(database.unreadConversationCounts()).toEqual({ unreadCount: 205, nodeUnreadCounts: { node: 205 } });
    expect(database.listTaskCenter().some((entry) => entry.conversationId === "chat-000")).toBe(false);
    database.markConversationNotificationsRead("chat-000", at);
    database.markConversationUnread("chat-000", later);
    expect(database.listTaskCenter()[0].conversationId).toBe("chat-000");
    database.markConversationNotificationsRead("chat-100", later);
    database.updateConversation("chat-100", { pinned: true }, later);
    const first = database.listConversationPage({ nodeId: "node", limit: 1 });
    expect(first.data[0]).toMatchObject({ id: "chat-100", unread: false });
    const second = database.listConversationPage({ nodeId: "node", limit: 1, cursor: first.nextCursor! });
    expect(second.data[0]).toMatchObject({ id: "chat-000", unread: true });
    const third = database.listConversationPage({ nodeId: "node", limit: 1, cursor: second.nextCursor! });
    expect(third.data[0].id).toBe("chat-204");
    database.markConversationNotificationsRead("chat-000", later);
    expect(database.listConversationPage({ nodeId: "node", limit: 2 }).data.map((entry) => entry.id)).toEqual(["chat-100", "chat-204"]);
  });

  it("migrates duplicate legacy notifications without losing older unread, and is repeatable", () => {
    const { database, filename } = fixture();
    conversation(database, "chat");
    databases.splice(databases.indexOf(database), 1);
    database.close();
    const legacy = new DatabaseSync(filename);
    legacy.exec("DROP INDEX notifications_conversation_idx");
    const insert = legacy.prepare("INSERT INTO notifications (id, node_id, conversation_id, kind, title, read_at, created_at) VALUES (?, 'node', 'chat', 'completed', ?, ?, ?)");
    insert.run("older", "older result", null, at);
    insert.run("latest", "latest result", later, later);
    legacy.close();
    const migrated = new ControlDatabase(filename);
    expect(migrated.listNotifications()).toMatchObject([{ id: "latest", title: "latest result", readAt: null, createdAt: later }]);
    expect(migrated.unreadConversationCounts().unreadCount).toBe(1);
    migrated.close();
    const reopened = new ControlDatabase(filename);
    databases.push(reopened);
    expect(reopened.listNotifications()).toHaveLength(1);
    reopened.createNotification({ nodeId: "node", conversationId: "chat", runId: null, kind: "completed", title: "updated", createdAt: later });
    expect(reopened.listNotifications()).toHaveLength(1);
  });

  it("retains a manual reminder when the waiting approval is resolved", () => {
    const { database } = fixture();
    conversation(database, "chat");
    run(database, "run", "chat", "running");
    database.insertApproval("node", {
      type: "interaction.requested", approvalId: "approval", conversationId: "chat", runId: "run",
      threadId: "chat", turnId: "run", method: "item/commandExecution/requestApproval", requestId: "7",
      summary: "执行测试", risk: null, details: {}, requestedAt: at,
    });
    database.createNotification({ nodeId: "node", conversationId: "chat", runId: "run", kind: "waiting_user", title: "等待操作", createdAt: at });
    database.markConversationNotificationsRead("chat", at);
    database.markConversationUnread("chat", later);
    database.resolveApproval("approval", { decision: "accept" }, later);
    expect(database.listTaskCenter()).toMatchObject([{ conversationId: "chat", status: "running", unread: true, manualUnread: true }]);
    expect(database.listNotifications()).toHaveLength(1);
  });
});
