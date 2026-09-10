import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentDurableMessage,
  ControlCommand,
  DurableAgentPayload,
} from "@controller-center/protocol";

type Row = Record<string, unknown>;

export type StoredCommandStatus = "processing" | "completed" | "failed" | "uncertain";

export interface StoredCommand {
  id: string;
  command: ControlCommand;
  status: StoredCommandStatus;
  error: string | null;
}

export class AgentStateStore {
  private readonly sqlite: DatabaseSync;

  constructor(dataDirectory: string) {
    this.sqlite = new DatabaseSync(path.join(dataDirectory, "agent-state.db"));
    this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        boot_id TEXT NOT NULL,
        message_json TEXT,
        created_at TEXT NOT NULL
      );
    `);
    this.sqlite.prepare(`
      UPDATE commands
      SET status = 'uncertain', error = 'Agent restarted while the command was running', updated_at = ?
      WHERE status = 'processing'
    `).run(new Date().toISOString());
  }

  close(): void {
    this.sqlite.close();
  }

  getCommand(id: string): StoredCommand | null {
    const row = this.sqlite.prepare("SELECT * FROM commands WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      command: JSON.parse(String(row.payload_json)) as ControlCommand,
      status: String(row.status) as StoredCommandStatus,
      error: row.error === null ? null : String(row.error),
    };
  }

  beginCommand(id: string, command: ControlCommand): StoredCommand | null {
    const existing = this.getCommand(id);
    if (existing) return existing;
    this.sqlite.prepare(`
      INSERT INTO commands (id, payload_json, status, error, updated_at)
      VALUES (?, ?, 'processing', NULL, ?)
    `).run(id, JSON.stringify(command), new Date().toISOString());
    return null;
  }

  finishCommand(id: string, error?: string): void {
    this.sqlite.prepare("UPDATE commands SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(
      error ? "failed" : "completed",
      error ?? null,
      new Date().toISOString(),
      id,
    );
  }

  enqueue(bootId: string, payload: DurableAgentPayload): AgentDurableMessage {
    const createdAt = new Date().toISOString();
    const result = this.sqlite.prepare(
      "INSERT INTO outbox (boot_id, message_json, created_at) VALUES (?, NULL, ?)",
    ).run(bootId, createdAt);
    const sequence = Number(result.lastInsertRowid);
    const message: AgentDurableMessage = { type: "agent.message", bootId, sequence, payload };
    this.sqlite.prepare("UPDATE outbox SET message_json = ? WHERE sequence = ?").run(JSON.stringify(message), sequence);
    return message;
  }

  pendingMessages(): AgentDurableMessage[] {
    const rows = this.sqlite.prepare(
      "SELECT message_json FROM outbox WHERE message_json IS NOT NULL ORDER BY sequence",
    ).all() as Row[];
    return rows.map((row) => JSON.parse(String(row.message_json)) as AgentDurableMessage);
  }

  acknowledge(bootId: string, sequence: number): void {
    this.sqlite.prepare("DELETE FROM outbox WHERE boot_id = ? AND sequence = ?").run(bootId, sequence);
  }
}
