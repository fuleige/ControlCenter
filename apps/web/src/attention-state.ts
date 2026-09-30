import type { Conversation, ConversationAttentionUpdate, TaskCenterEntry } from "./types";

type Resource = "tasks" | "conversations";

// HTTP completion order need not match database order. Counts describe the whole
// dataset, while each mutation changes only its own conversation (or read-all).
export class AttentionStateVersions {
  private minimumRevision = 0;
  private countsRevision = -1;
  private snapshotRevisions: Record<Resource, number> = { tasks: -1, conversations: -1 };
  private changes = new Map<string, ConversationAttentionUpdate>();
  private allRead: ConversationAttentionUpdate | null = null;

  acceptSnapshot(resource: Resource, revision: number): boolean {
    if (revision < this.minimumRevision || revision < this.snapshotRevisions[resource]) return false;
    this.snapshotRevisions[resource] = revision;
    return true;
  }

  acceptCounts(revision: number): boolean {
    if (revision < this.countsRevision) return false;
    this.countsRevision = revision;
    return true;
  }

  record(update: ConversationAttentionUpdate): void {
    this.minimumRevision = Math.max(this.minimumRevision, update.revision);
    if (update.conversationId === null) {
      if (update.revision < (this.allRead?.revision ?? -1)) return;
      this.allRead = update;
      for (const [id, change] of this.changes) {
        if (change.revision <= update.revision) this.changes.delete(id);
      }
    } else if (update.revision >= (this.allRead?.revision ?? -1)
      && update.revision >= (this.changes.get(update.conversationId)?.revision ?? -1)) {
      this.changes.set(update.conversationId, update);
    }
  }

  private changeFor(id: string, resource: Resource): ConversationAttentionUpdate | null {
    const change = this.changes.get(id) ?? this.allRead;
    return change && change.revision >= this.snapshotRevisions[resource] ? change : null;
  }

  patchConversations(entries: Conversation[]): Conversation[] {
    return entries.map((entry) => {
      const change = this.changeFor(entry.id, "conversations");
      return change ? { ...entry, unread: change.unread, unreadAt: change.unreadAt } : entry;
    });
  }

  patchTasks(entries: TaskCenterEntry[]): TaskCenterEntry[] {
    return entries.map((entry) => {
      const change = this.changeFor(entry.conversationId, "tasks");
      return change ? {
        ...entry,
        unread: change.unread,
        manualUnread: change.manualUnreadAt !== null,
        manualUnreadAt: change.manualUnreadAt,
        attentionAt: change.unreadAt ?? entry.attentionAt,
      } : entry;
    });
  }
}
