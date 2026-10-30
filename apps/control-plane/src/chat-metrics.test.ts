import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ControlDatabase } from "./database.js";

const directories: string[] = [];
const databases: ControlDatabase[] = [];
const at = "2026-10-20T00:00:00.000Z";
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "chat-metrics-"));
  directories.push(directory);
  const filename = path.join(directory, "test.db");
  const database = new ControlDatabase(filename, { recoverRuntimeState: false });
  databases.push(database);
  database.upsertNode({ id: "node", name: "Host", platform: "linux", arch: "x64", agentVersion: "test", runtime: "codex", codexVersion: "test",
    maxConcurrentRuns: 2, workspaces: [], capabilities: ["fast_mode_v1"] }, "boot", at);
  database.createConversation({ id: "chat", nodeId: "node", workspaceId: "repo", title: "Chat", model: "test", effort: null, fastMode: true,
    clientRequestId: null, remoteThreadId: "thread", status: "ready", error: null, pinnedAt: null, latestRunStatus: null,
    tokenUsage: null, compaction: null, createdAt: at, updatedAt: at });
  database.createRun({ id: "run", conversationId: "chat", prompt: "Hi", model: "test", effort: null, fastMode: true,
    clientRequestId: null, remoteTurnId: "turn", status: "completed", progressPhase: null, progressLabel: null,
    progressUpdatedAt: null, recoveryDeadlineAt: null, error: null, errorCode: null, errorDismissedAt: null, createdAt: at, startedAt: at, finishedAt: at });
  return { database, filename };
}

describe("chat options and output statistics", () => {
  it("persists reply speeds and Fast choices without changing the original run when the preference changes", () => {
    const { database, filename } = fixture();
    const outputStats = { estimatedTokens: 240, elapsedMs: 3_000, averageTokensPerSecond: 60, recentTokensPerSecond: 80 };
    const snapshot = { type: "message.snapshot" as const, messageId: "reply", conversationId: "chat", runId: "run", role: "assistant" as const,
      content: "Answer", revision: 2, complete: true, outputStats, occurredAt: at };
    expect(database.upsertMessageSnapshot(snapshot)).toBe(true);
    expect(database.upsertMessageSnapshot({ ...snapshot, revision: 1, outputStats: { ...outputStats, averageTokensPerSecond: 999 } })).toBe(false);
    database.updateConversationPreferences("chat", "test", null, at, false);
    expect(database.getConversation("chat")?.fastMode).toBe(false);
    expect(database.getRun("run")?.fastMode).toBe(true);
    database.updateConversationTokenUsage("node", { type: "conversation.tokenUsage", conversationId: "chat", threadId: "thread",
      totalTokens: 12_000, contextTokens: 8_000, modelContextWindow: 100_000, outputTokens: 2_000, reasoningOutputTokens: 500, updatedAt: at });
    const reopened = new ControlDatabase(filename, { recoverRuntimeState: false });
    databases.push(reopened);
    expect(reopened.listNodes()[0]?.capabilities).toEqual(["fast_mode_v1"]);
    expect(reopened.getConversation("chat")?.fastMode).toBe(false);
    expect(reopened.listMessagePage("chat", 10).data[0]?.outputStats).toEqual(outputStats);
    expect(reopened.getConversation("chat")?.tokenUsage).toMatchObject({ outputTokens: 2_000, reasoningOutputTokens: 500 });
  });

  it("migrates an older database without fabricating statistics or enabling Fast", () => {
    const { database, filename } = fixture();
    databases.splice(databases.indexOf(database), 1);
    database.close();
    const raw = new DatabaseSync(filename);
    for (const [table, column] of [["nodes", "capabilities_json"], ["conversations", "fast_mode"], ["runs", "fast_mode"], ["messages", "output_stats_json"]]) {
      raw.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
    raw.close();
    const migrated = new ControlDatabase(filename, { recoverRuntimeState: false });
    databases.push(migrated);
    expect(migrated.listNodes()[0]?.capabilities).toEqual([]);
    expect(migrated.getConversation("chat")?.fastMode).toBe(false);
    expect(migrated.getRun("run")?.fastMode).toBe(false);
  });
});
