import { describe, expect, it } from "vitest";
import { AttentionStateVersions } from "./attention-state";
import type { Conversation, ConversationAttentionUpdate, TaskCenterEntry } from "./types";

function update(id: string | null, revision: number, unread = false): ConversationAttentionUpdate {
  return {
    conversationId: id, revision, changed: true, unread, unreadAt: unread ? "now" : null,
    manualUnreadAt: unread ? "now" : null, unreadCount: unread ? 1 : 0, nodeUnreadCounts: unread ? { node: 1 } : {},
  };
}

const conversations = ["a", "b"].map((id) => ({ id, unread: true, unreadAt: "before" } as Conversation));
const tasks = ["a", "b"].map((conversationId) => ({ conversationId, unread: true, manualUnread: true, manualUnreadAt: "before" } as TaskCenterEntry));

describe("attention response ordering", () => {
  it("clears both lists immediately and rejects queries captured before the read", () => {
    const versions = new AttentionStateVersions();
    versions.acceptSnapshot("tasks", 10);
    versions.acceptSnapshot("conversations", 10);
    versions.record(update("a", 12));
    expect(versions.patchConversations(conversations).map((entry) => entry.unread)).toEqual([false, true]);
    expect(versions.patchTasks(tasks)[0]).toMatchObject({ unread: false, manualUnread: false, manualUnreadAt: null });
    expect(versions.acceptSnapshot("tasks", 11)).toBe(false);
    expect(versions.acceptSnapshot("conversations", 11)).toBe(false);
    expect(versions.acceptSnapshot("tasks", 12)).toBe(true);
  });

  it("applies reordered reads for different conversations without regressing aggregate counts", () => {
    const versions = new AttentionStateVersions();
    versions.record(update("b", 12));
    expect(versions.acceptCounts(12)).toBe(true);
    versions.record(update("a", 11));
    expect(versions.acceptCounts(11)).toBe(false);
    expect(versions.patchConversations(conversations).every((entry) => !entry.unread)).toBe(true);
  });

  it("preserves a newer unread mark when an older read-all response arrives later", () => {
    const versions = new AttentionStateVersions();
    versions.record(update("a", 15, true));
    versions.record(update(null, 14));
    expect(versions.patchConversations(conversations).map((entry) => entry.unread)).toEqual([true, false]);
    versions.record(update("b", 13, true));
    expect(versions.patchTasks(tasks).map((entry) => entry.unread)).toEqual([true, false]);
    versions.record(update(null, 16));
    expect(versions.patchTasks(tasks).every((entry) => !entry.unread)).toBe(true);
  });

  it("does not overwrite newer authoritative snapshots with delayed mutation responses", () => {
    const versions = new AttentionStateVersions();
    expect(versions.acceptSnapshot("tasks", 20)).toBe(true);
    expect(versions.acceptSnapshot("conversations", 20)).toBe(true);
    versions.record(update("a", 19));
    expect(versions.patchTasks(tasks)).toEqual(tasks);
    expect(versions.patchConversations(conversations)).toEqual(conversations);
    versions.record(update("a", 21));
    versions.record(update("a", 20, true));
    expect(versions.patchTasks(tasks)[0].unread).toBe(false);
  });
});
