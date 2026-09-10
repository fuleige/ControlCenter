import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStateStore } from "./state-store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("AgentStateStore", () => {
  it("deduplicates commands and persists durable messages until acknowledged", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "controller-agent-test-"));
    directories.push(directory);
    const store = new AgentStateStore(directory);
    const command = {
      type: "conversation.create" as const,
      conversationId: "conversation-1",
      workspaceId: "workspace-1",
      title: "Test",
    };

    expect(store.beginCommand("command-1", command)).toBeNull();
    store.finishCommand("command-1");
    expect(store.beginCommand("command-1", command)?.status).toBe("completed");

    const message = store.enqueue("boot-1", {
      type: "conversation.bound",
      commandId: "command-1",
      conversationId: "conversation-1",
      threadId: "thread-1",
    });
    expect(store.pendingMessages()).toEqual([message]);
    store.acknowledge(message.bootId, message.sequence);
    expect(store.pendingMessages()).toEqual([]);
    store.close();
  });
});
