import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentErrorPayload,
  InteractionRequestedPayload,
  MessageSnapshotPayload,
  ControlCommand,
  ModelDescriptor,
  NodeDescriptor,
  RunProgressPayload,
  RunFinishedPayload,
  RunStartedPayload,
  WorkspaceSource,
  WorkspaceStatus,
} from "@controller-center/protocol";

type Row = Record<string, unknown>;

export interface NodeRecord {
  id: string;
  name: string;
  reportedName: string;
  platform: string;
  arch: string;
  agentVersion: string;
  codexVersion: string;
  permissionMode: "workspace-write" | "danger-full-access";
  maxConcurrentRuns: number;
  activeRuns: number;
  status: "online" | "offline";
  accessMode: "enrolled" | "revoked" | "legacy";
  bootId: string | null;
  lastSeenAt: string;
  connectedAt: string | null;
  workspaces: WorkspaceRecord[];
  models: ModelDescriptor[];
}

export interface WorkspaceRecord {
  id: string;
  nodeId: string;
  name: string;
  path: string;
  source: WorkspaceSource;
  isDefault: boolean;
  status: WorkspaceStatus;
  validationError: string | null;
  lastValidatedAt: string | null;
  archivedAt: string | null;
  conversationCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationRecord {
  id: string;
  nodeId: string;
  workspaceId: string;
  title: string;
  model: string | null;
  effort: string | null;
  clientRequestId: string | null;
  remoteThreadId: string | null;
  status: "creating" | "ready" | "error";
  error: string | null;
  pinnedAt: string | null;
  latestRunStatus: RunRecord["status"] | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationListCursor {
  pinned: 0 | 1;
  updatedAt: string;
  id: string;
}

export interface ConversationPage {
  data: ConversationRecord[];
  total?: number;
  nextCursor: ConversationListCursor | null;
}

export interface RunRecord {
  id: string;
  conversationId: string;
  prompt: string;
  model: string | null;
  effort: string | null;
  clientRequestId: string | null;
  remoteTurnId: string | null;
  status: "queued" | "dispatching" | "running" | "waiting_approval" | "recovering" | "completed" | "failed" | "interrupted";
  progressPhase: string | null;
  progressLabel: string | null;
  progressUpdatedAt: string | null;
  recoveryDeadlineAt: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  runId: string | null;
  role: "user" | "assistant";
  content: string;
  revision: number;
  complete: boolean;
  attachmentIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface NotificationRecord {
  id: string;
  nodeId: string;
  conversationId: string;
  runId: string | null;
  kind: "completed" | "failed" | "waiting_user";
  title: string;
  readAt: string | null;
  createdAt: string;
}

export interface GlobalSettingsRecord {
  defaultModel: string | null;
  defaultEffort: string | null;
}

export interface AdminSessionRecord {
  id: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface EnrollmentTokenRecord {
  id: string;
  tokenHash: string;
  tokenCiphertext: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  nodeId: string | null;
  credentialId: string | null;
}

export interface NodeCredentialRecord {
  id: string;
  nodeId: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AttachmentRecord {
  id: string;
  conversationId: string | null;
  messageClientId: string;
  name: string;
  mediaType: string;
  size: number;
  receivedSize: number;
  sha256: string | null;
  status: "uploading" | "ready" | "failed" | "consumed";
  storageKey: string;
  downloadToken: string;
  expiresAt: string;
  createdAt: string;
}

export interface UiEventRecord {
  revision: number;
  type: string;
  resourceId: string | null;
  occurredAt: string;
}

export interface TaskCenterRecord {
  id: string;
  nodeId: string;
  nodeName: string;
  conversationId: string;
  conversationTitle: string;
  runId: string | null;
  status: RunRecord["status"] | NotificationRecord["kind"];
  progressLabel: string | null;
  replyPreview: string | null;
  unread: boolean;
  occurredAt: string;
}

export interface ApprovalRecord {
  id: string;
  nodeId: string;
  conversationId: string;
  runId: string | null;
  method: string;
  requestId: string;
  summary: string;
  risk: string | null;
  details: unknown;
  response: unknown | null;
  status: "pending" | "resolved" | "expired";
  requestedAt: string;
  resolvedAt: string | null;
}

export interface CommandRecord {
  id: string;
  nodeId: string;
  kind: string;
  command: ControlCommand;
  status: "queued" | "accepted" | "completed" | "failed";
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

function text(row: Row, key: string): string {
  return String(row[key]);
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

function parseJson(value: unknown): unknown {
  return JSON.parse(String(value));
}

function notificationPreview(value: string | null): string | null {
  if (!value) return null;
  const compact = value
    .replace(/```[\s\S]*?```/g, " [代码] ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return null;
  const characters = Array.from(compact);
  return characters.length > 120 ? `${characters.slice(0, 120).join("")}…` : compact;
}

export class ControlDatabase {
  readonly sqlite: DatabaseSync;

  constructor(databasePath: string, options: { recoverRuntimeState?: boolean } = {}) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.sqlite = new DatabaseSync(databasePath);
    this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
    if (options.recoverRuntimeState !== false) {
      this.sqlite.prepare("UPDATE nodes SET status = 'offline', active_runs = 0, connected_at = NULL").run();
      const recoveryDeadline = new Date(Date.now() + 120_000).toISOString();
      this.sqlite.prepare(`
        UPDATE runs SET status = 'recovering', recovery_deadline_at = ?
        WHERE status IN ('dispatching', 'running', 'waiting_approval')
      `).run(recoveryDeadline);
    }
  }

  close(): void {
    this.sqlite.close();
  }

  transaction<T>(work: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        display_name TEXT,
        platform TEXT NOT NULL,
        arch TEXT NOT NULL,
        agent_version TEXT NOT NULL,
        codex_version TEXT NOT NULL,
        permission_mode TEXT NOT NULL DEFAULT 'workspace-write',
        max_concurrent_runs INTEGER NOT NULL DEFAULT 1,
        active_runs INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'offline',
        boot_id TEXT,
        last_seen_at TEXT NOT NULL,
        connected_at TEXT,
        model_catalog_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'config',
        is_default INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'valid',
        validation_error TEXT,
        last_validated_at TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (node_id, id)
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES nodes(id),
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        client_request_id TEXT,
        remote_thread_id TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversations_node_idx ON conversations(node_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        remote_turn_id TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_conversation_idx ON runs(conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        complete INTEGER NOT NULL DEFAULT 1,
        attachment_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES nodes(id),
        conversation_id TEXT,
        run_id TEXT,
        method TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_conversation_idx ON events(conversation_id, occurred_at);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES nodes(id),
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        run_id TEXT,
        method TEXT NOT NULL,
        request_id TEXT NOT NULL,
        details_json TEXT NOT NULL,
        response_json TEXT,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status, requested_at);
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES nodes(id),
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS commands_node_status_idx ON commands(node_id, status, created_at);
      CREATE TABLE IF NOT EXISTS deliveries (
        node_id TEXT NOT NULL,
        boot_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (node_id, boot_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        read_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS notifications_run_kind_idx ON notifications(run_id, kind) WHERE run_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(read_at, created_at DESC);
      CREATE TABLE IF NOT EXISTS settings (
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, scope_id, key)
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        message_client_id TEXT NOT NULL,
        name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        received_size INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT,
        status TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        download_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attachments_expiry_idx ON attachments(status, expires_at);
      CREATE TABLE IF NOT EXISTS ui_events (
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        resource_id TEXT,
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_credentials (
        id TEXT PRIMARY KEY CHECK (id = 'primary'),
        token_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions(expires_at, revoked_at);
      CREATE TABLE IF NOT EXISTS enrollment_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        token_ciphertext TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        revoked_at TEXT,
        node_id TEXT,
        credential_id TEXT
      );
      CREATE INDEX IF NOT EXISTS enrollment_tokens_expiry_idx ON enrollment_tokens(expires_at, used_at, revoked_at);
      CREATE TABLE IF NOT EXISTS node_credentials (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS node_credentials_node_idx ON node_credentials(node_id, revoked_at);
    `);
    this.ensureColumn("nodes", "display_name", "TEXT");
    this.ensureColumn("nodes", "model_catalog_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("nodes", "permission_mode", "TEXT NOT NULL DEFAULT 'workspace-write'");
    this.ensureColumn("workspaces", "source", "TEXT NOT NULL DEFAULT 'config'");
    this.ensureColumn("workspaces", "is_default", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("workspaces", "status", "TEXT NOT NULL DEFAULT 'valid'");
    this.ensureColumn("workspaces", "validation_error", "TEXT");
    this.ensureColumn("workspaces", "last_validated_at", "TEXT");
    this.ensureColumn("workspaces", "archived_at", "TEXT");
    this.ensureColumn("workspaces", "created_at", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("workspaces", "updated_at", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("conversations", "effort", "TEXT");
    this.ensureColumn("conversations", "client_request_id", "TEXT");
    this.ensureColumn("conversations", "pinned_at", "TEXT");
    this.ensureColumn("runs", "client_request_id", "TEXT");
    this.ensureColumn("runs", "progress_phase", "TEXT");
    this.ensureColumn("runs", "progress_label", "TEXT");
    this.ensureColumn("runs", "progress_updated_at", "TEXT");
    this.ensureColumn("runs", "recovery_deadline_at", "TEXT");
    this.ensureColumn("approvals", "summary", "TEXT NOT NULL DEFAULT '需要你的确认'");
    this.ensureColumn("approvals", "risk", "TEXT");
    this.ensureColumn("enrollment_tokens", "token_ciphertext", "TEXT");
    this.sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS conversations_client_request_idx ON conversations(client_request_id) WHERE client_request_id IS NOT NULL;");
    this.sqlite.exec("CREATE INDEX IF NOT EXISTS conversations_node_order_idx ON conversations(node_id, pinned_at DESC, updated_at DESC, id DESC);");
    this.sqlite.exec("CREATE INDEX IF NOT EXISTS conversations_order_idx ON conversations(pinned_at DESC, updated_at DESC, id DESC);");
    this.sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS runs_client_request_idx ON runs(client_request_id) WHERE client_request_id IS NOT NULL;");
    this.sqlite.exec("CREATE INDEX IF NOT EXISTS workspaces_node_status_idx ON workspaces(node_id, archived_at, is_default DESC, name);");
    this.sqlite.prepare("UPDATE workspaces SET created_at = CASE WHEN created_at = '' THEN ? ELSE created_at END, updated_at = CASE WHEN updated_at = '' THEN ? ELSE updated_at END").run(new Date().toISOString(), new Date().toISOString());
    this.migrateLegacyMessages();
  }

  private migrateLegacyMessages(): void {
    const existing = this.sqlite.prepare("SELECT COUNT(*) AS count FROM messages").get() as Row;
    if (Number(existing.count) > 0) return;
    const runs = this.sqlite.prepare("SELECT id, conversation_id, prompt, created_at FROM runs ORDER BY created_at").all() as Row[];
    const insert = this.sqlite.prepare(`
      INSERT OR IGNORE INTO messages (
        id, conversation_id, run_id, role, content, revision, complete, attachment_ids_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'user', ?, 1, 1, '[]', ?, ?)
    `);
    for (const run of runs) {
      insert.run(`legacy-user-${text(run, "id")}`, text(run, "conversation_id"), text(run, "id"), text(run, "prompt"), text(run, "created_at"), text(run, "created_at"));
    }

    const events = this.sqlite.prepare(`
      SELECT id, conversation_id, run_id, method, payload_json, occurred_at
      FROM events WHERE conversation_id IS NOT NULL ORDER BY occurred_at
    `).all() as Row[];
    const messages = new Map<string, { id: string; conversationId: string; runId: string | null; content: string; at: string }>();
    for (const event of events) {
      const payload = parseJson(event.payload_json) as Record<string, unknown>;
      const item = payload && typeof payload.item === "object" && payload.item !== null
        ? payload.item as Record<string, unknown>
        : null;
      const itemId = typeof payload.itemId === "string" ? payload.itemId : typeof item?.id === "string" ? item.id : text(event, "id");
      const key = `${text(event, "conversation_id")}:${itemId}`;
      if (text(event, "method") === "item/agentMessage/delta" && typeof payload.delta === "string") {
        const current = messages.get(key);
        if (current) current.content += payload.delta;
        else messages.set(key, { id: `legacy-agent-${itemId}`, conversationId: text(event, "conversation_id"), runId: nullableText(event, "run_id"), content: payload.delta, at: text(event, "occurred_at") });
      } else if (text(event, "method") === "item/completed" && item?.type === "agentMessage" && typeof item.text === "string") {
        const current = messages.get(key);
        if (current) current.content = item.text;
        else messages.set(key, { id: `legacy-agent-${itemId}`, conversationId: text(event, "conversation_id"), runId: nullableText(event, "run_id"), content: item.text, at: text(event, "occurred_at") });
      }
    }
    const insertAssistant = this.sqlite.prepare(`
      INSERT OR IGNORE INTO messages (
        id, conversation_id, run_id, role, content, revision, complete, attachment_ids_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'assistant', ?, 1, 1, '[]', ?, ?)
    `);
    for (const message of messages.values()) {
      if (message.content.trim()) insertAssistant.run(message.id, message.conversationId, message.runId, message.content, message.at, message.at);
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (!columns.some((entry) => String(entry.name) === column)) {
      this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private workspaceFromRow(row: Row, nodeOffline = false): WorkspaceRecord {
    const archivedAt = nullableText(row, "archived_at");
    const storedStatus = text(row, "status") as WorkspaceStatus;
    return {
      id: text(row, "id"),
      nodeId: text(row, "node_id"),
      name: text(row, "name"),
      path: text(row, "path"),
      source: text(row, "source") as WorkspaceSource,
      isDefault: Number(row.is_default) === 1,
      status: archivedAt ? "archived" : nodeOffline ? "offline" : storedStatus,
      validationError: nullableText(row, "validation_error"),
      lastValidatedAt: nullableText(row, "last_validated_at"),
      archivedAt,
      conversationCount: Number(row.conversation_count ?? 0),
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
    };
  }

  upsertNode(node: NodeDescriptor, bootId: string, now: string): boolean {
    const previous = this.sqlite.prepare("SELECT boot_id FROM nodes WHERE id = ?").get(node.id) as Row | undefined;
    const restarted = Boolean(previous?.boot_id && String(previous.boot_id) !== bootId);
    this.sqlite.exec("BEGIN");
    try {
      this.sqlite.prepare(`
        INSERT INTO nodes (
          id, name, platform, arch, agent_version, codex_version,
          permission_mode, max_concurrent_runs, active_runs, status, boot_id, last_seen_at, connected_at, model_catalog_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'online', ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          platform = excluded.platform,
          arch = excluded.arch,
          agent_version = excluded.agent_version,
          codex_version = excluded.codex_version,
          permission_mode = excluded.permission_mode,
          max_concurrent_runs = excluded.max_concurrent_runs,
          status = 'online',
          boot_id = excluded.boot_id,
          last_seen_at = excluded.last_seen_at,
          connected_at = excluded.connected_at,
          model_catalog_json = excluded.model_catalog_json,
          updated_at = excluded.updated_at
      `).run(
        node.id,
        node.name,
        node.platform,
        node.arch,
        node.agentVersion,
        node.codexVersion,
        node.permissionMode === "danger-full-access" ? "danger-full-access" : "workspace-write",
        node.maxConcurrentRuns,
        bootId,
        now,
        now,
        JSON.stringify(node.models ?? []),
        now,
      );
      this.sqlite.prepare("UPDATE workspaces SET is_default = 0 WHERE node_id = ?").run(node.id);
      const previousLocal = this.sqlite.prepare(
        "SELECT id FROM workspaces WHERE node_id = ? AND source IN ('default', 'config')",
      ).all(node.id) as Row[];
      const incomingIds = new Set(node.workspaces.map((workspace) => workspace.id));
      const upsert = this.sqlite.prepare(`
        INSERT INTO workspaces (
          node_id, id, name, path, source, is_default, status,
          validation_error, last_validated_at, archived_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'valid', NULL, ?, NULL, ?, ?)
        ON CONFLICT(node_id, id) DO UPDATE SET
          name = excluded.name,
          path = excluded.path,
          source = excluded.source,
          is_default = excluded.is_default,
          status = 'valid',
          validation_error = NULL,
          last_validated_at = excluded.last_validated_at,
          archived_at = NULL,
          updated_at = excluded.updated_at
      `);
      for (const workspace of node.workspaces) {
        const conflict = this.sqlite.prepare(
          `SELECT source, path,
            (SELECT COUNT(*) FROM conversations c WHERE c.node_id = workspaces.node_id AND c.workspace_id = workspaces.id) AS conversation_count
           FROM workspaces WHERE node_id = ? AND id = ?`,
        ).get(node.id, workspace.id) as Row | undefined;
        if (conflict && !["default", "config", "history"].includes(text(conflict, "source"))) {
          throw new Error(`Agent workspace id conflicts with a Web workspace: ${workspace.id}`);
        }
        if (conflict && text(conflict, "path") !== workspace.path && Number(conflict.conversation_count ?? 0) > 0) {
          throw new Error(`Agent workspace id ${workspace.id} cannot move because existing conversations use its previous path`);
        }
        upsert.run(
          node.id,
          workspace.id,
          workspace.name,
          workspace.path,
          workspace.source,
          workspace.isDefault ? 1 : 0,
          now,
          now,
          now,
        );
      }
      for (const previous of previousLocal) {
        const workspaceId = text(previous, "id");
        if (incomingIds.has(workspaceId)) continue;
        const usage = this.sqlite.prepare(
          "SELECT COUNT(*) AS count FROM conversations WHERE node_id = ? AND workspace_id = ?",
        ).get(node.id, workspaceId) as Row;
        if (Number(usage.count) > 0) {
          this.sqlite.prepare(`
            UPDATE workspaces
            SET source = 'history', is_default = 0, archived_at = NULL, updated_at = ?
            WHERE node_id = ? AND id = ?
          `).run(now, node.id, workspaceId);
        } else {
          this.sqlite.prepare("DELETE FROM workspaces WHERE node_id = ? AND id = ?").run(node.id, workspaceId);
        }
      }
      for (const workspace of node.workspaces) {
        const aliases = this.sqlite.prepare(`
          SELECT id FROM workspaces
          WHERE node_id = ? AND path = ? AND id <> ? AND source IN ('web', 'history') AND archived_at IS NULL
        `).all(node.id, workspace.path, workspace.id) as Row[];
        for (const alias of aliases) {
          const aliasId = text(alias, "id");
          const usage = this.sqlite.prepare(
            "SELECT COUNT(*) AS count FROM conversations WHERE node_id = ? AND workspace_id = ?",
          ).get(node.id, aliasId) as Row;
          if (Number(usage.count) > 0) {
            this.sqlite.prepare("UPDATE workspaces SET source = 'history', is_default = 0, updated_at = ? WHERE node_id = ? AND id = ?")
              .run(now, node.id, aliasId);
          } else {
            this.sqlite.prepare("DELETE FROM workspaces WHERE node_id = ? AND id = ?").run(node.id, aliasId);
          }
        }
      }
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    if (restarted) {
      const recoveryDeadline = new Date(new Date(now).getTime() + 120_000).toISOString();
      this.sqlite.prepare(`
        UPDATE runs
        SET status = 'recovering', error = NULL, recovery_deadline_at = ?
        WHERE conversation_id IN (SELECT id FROM conversations WHERE node_id = ?)
          AND status IN ('dispatching', 'running', 'waiting_approval')
      `).run(recoveryDeadline, node.id);
    }
    return restarted;
  }

  updateHeartbeat(nodeId: string, activeRuns: number, now: string): void {
    this.sqlite.prepare(
      "UPDATE nodes SET active_runs = ?, status = 'online', last_seen_at = ?, updated_at = ? WHERE id = ?",
    ).run(activeRuns, now, now, nodeId);
  }

  markNodeOffline(nodeId: string, now: string): void {
    const deadline = new Date(new Date(now).getTime() + 120_000).toISOString();
    this.sqlite.exec("BEGIN");
    try {
      this.sqlite.prepare(
        "UPDATE nodes SET status = 'offline', active_runs = 0, connected_at = NULL, updated_at = ? WHERE id = ?",
      ).run(now, nodeId);
      this.sqlite.prepare(`
        UPDATE runs SET status = 'recovering', recovery_deadline_at = ?
        WHERE conversation_id IN (SELECT id FROM conversations WHERE node_id = ?)
          AND status IN ('dispatching', 'running', 'waiting_approval')
      `).run(deadline, nodeId);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  markStaleNodesOffline(cutoff: string, now: string): string[] {
    const rows = this.sqlite.prepare(
      "SELECT id FROM nodes WHERE status = 'online' AND last_seen_at < ?",
    ).all(cutoff) as Row[];
    const ids = rows.map((row) => text(row, "id"));
    for (const id of ids) this.markNodeOffline(id, now);
    return ids;
  }

  listNodes(): NodeRecord[] {
    const rows = this.sqlite.prepare(`
      SELECT n.*,
        EXISTS(SELECT 1 FROM node_credentials nc WHERE nc.node_id = n.id) AS has_credentials,
        EXISTS(SELECT 1 FROM node_credentials nc WHERE nc.node_id = n.id AND nc.revoked_at IS NULL) AS has_active_credentials
      FROM nodes n ORDER BY n.status DESC, n.name
    `).all() as Row[];
    const workspaceStatement = this.sqlite.prepare(`
      SELECT w.*, (SELECT COUNT(*) FROM conversations c WHERE c.node_id = w.node_id AND c.workspace_id = w.id) AS conversation_count
      FROM workspaces w
      WHERE w.node_id = ?
      ORDER BY w.is_default DESC, w.archived_at IS NOT NULL, w.name
    `);
    return rows.map((row) => ({
      id: text(row, "id"),
      name: nullableText(row, "display_name") ?? text(row, "name"),
      reportedName: text(row, "name"),
      platform: text(row, "platform"),
      arch: text(row, "arch"),
      agentVersion: text(row, "agent_version"),
      codexVersion: text(row, "codex_version"),
      permissionMode: text(row, "permission_mode") === "danger-full-access" ? "danger-full-access" : "workspace-write",
      maxConcurrentRuns: Number(row.max_concurrent_runs),
      activeRuns: Number(row.active_runs),
      status: text(row, "status") as NodeRecord["status"],
      accessMode: Number(row.has_active_credentials) === 1 ? "enrolled" : Number(row.has_credentials) === 1 ? "revoked" : "legacy",
      bootId: nullableText(row, "boot_id"),
      lastSeenAt: text(row, "last_seen_at"),
      connectedAt: nullableText(row, "connected_at"),
      models: parseJson(row.model_catalog_json ?? "[]") as ModelDescriptor[],
      workspaces: (workspaceStatement.all(text(row, "id")) as Row[])
        .map((workspace) => this.workspaceFromRow(workspace, text(row, "status") !== "online")),
    }));
  }

  updateNodeName(nodeId: string, name: string | null, now: string): boolean {
    const result = this.sqlite.prepare(
      "UPDATE nodes SET display_name = ?, updated_at = ? WHERE id = ?",
    ).run(name, now, nodeId);
    return result.changes > 0;
  }

  getWorkspace(nodeId: string, workspaceId: string): WorkspaceRecord | null {
    const row = this.sqlite.prepare(`
      SELECT w.*, (SELECT COUNT(*) FROM conversations c WHERE c.node_id = w.node_id AND c.workspace_id = w.id) AS conversation_count
      FROM workspaces w WHERE w.node_id = ? AND w.id = ?
    `).get(nodeId, workspaceId) as Row | undefined;
    if (!row) return null;
    const node = this.sqlite.prepare("SELECT status FROM nodes WHERE id = ?").get(nodeId) as Row | undefined;
    return this.workspaceFromRow(row, node ? text(node, "status") !== "online" : true);
  }

  listWorkspaces(nodeId: string, includeArchived = false): WorkspaceRecord[] {
    const rows = this.sqlite.prepare(`
      SELECT w.*, (SELECT COUNT(*) FROM conversations c WHERE c.node_id = w.node_id AND c.workspace_id = w.id) AS conversation_count
      FROM workspaces w
      WHERE w.node_id = ? ${includeArchived ? "" : "AND w.archived_at IS NULL"}
      ORDER BY w.is_default DESC, w.archived_at IS NOT NULL, w.name
    `).all(nodeId) as Row[];
    const node = this.sqlite.prepare("SELECT status FROM nodes WHERE id = ?").get(nodeId) as Row | undefined;
    const offline = !node || text(node, "status") !== "online";
    return rows.map((row) => this.workspaceFromRow(row, offline));
  }

  listManagedWorkspacesForAgent(nodeId: string): Array<{ id: string; name: string; path: string; source: "web" | "history" }> {
    return (this.sqlite.prepare(`
      SELECT id, name, path, source FROM workspaces
      WHERE node_id = ? AND source IN ('web', 'history') AND archived_at IS NULL
      ORDER BY name
    `).all(nodeId) as Row[]).map((row) => ({
      id: text(row, "id"),
      name: text(row, "name"),
      path: text(row, "path"),
      source: text(row, "source") as "web" | "history",
    }));
  }

  findWorkspaceByPath(nodeId: string, workspacePath: string, exceptId?: string): WorkspaceRecord | null {
    const row = this.sqlite.prepare(`
      SELECT w.*, (SELECT COUNT(*) FROM conversations c WHERE c.node_id = w.node_id AND c.workspace_id = w.id) AS conversation_count
      FROM workspaces w
      WHERE w.node_id = ? AND w.path = ? ${exceptId ? "AND w.id <> ?" : ""}
      LIMIT 1
    `).get(...(exceptId ? [nodeId, workspacePath, exceptId] : [nodeId, workspacePath])) as Row | undefined;
    return row ? this.workspaceFromRow(row) : null;
  }

  createWebWorkspace(input: { id: string; nodeId: string; name: string; path: string; now: string }): WorkspaceRecord {
    this.sqlite.prepare(`
      INSERT INTO workspaces (
        node_id, id, name, path, source, is_default, status,
        validation_error, last_validated_at, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'web', 0, 'valid', NULL, ?, NULL, ?, ?)
    `).run(input.nodeId, input.id, input.name, input.path, input.now, input.now, input.now);
    return this.getWorkspace(input.nodeId, input.id)!;
  }

  updateWorkspace(input: { nodeId: string; id: string; name?: string; path?: string; archived?: boolean; now: string }): WorkspaceRecord | null {
    const current = this.getWorkspace(input.nodeId, input.id);
    if (!current) return null;
    const name = input.name ?? current.name;
    const workspacePath = input.path ?? current.path;
    const archivedAt = input.archived === undefined ? current.archivedAt : input.archived ? input.now : null;
    const status = archivedAt
      ? "archived"
      : input.archived === false || input.path
        ? "valid"
        : current.status === "offline" ? "valid" : current.status;
    this.sqlite.prepare(`
      UPDATE workspaces SET name = ?, path = ?, status = ?, validation_error = ?,
        last_validated_at = ?, archived_at = ?, updated_at = ?
      WHERE node_id = ? AND id = ?
    `).run(
      name,
      workspacePath,
      status,
      input.path ? null : current.validationError,
      input.path ? input.now : current.lastValidatedAt,
      archivedAt,
      input.now,
      input.nodeId,
      input.id,
    );
    return this.getWorkspace(input.nodeId, input.id);
  }

  updateWorkspaceValidation(nodeId: string, id: string, valid: boolean, error: string | null, now: string): WorkspaceRecord | null {
    this.sqlite.prepare(`
      UPDATE workspaces SET status = ?, validation_error = ?, last_validated_at = ?, updated_at = ?
      WHERE node_id = ? AND id = ? AND archived_at IS NULL
    `).run(valid ? "valid" : "invalid", valid ? null : error, now, now, nodeId, id);
    return this.getWorkspace(nodeId, id);
  }

  deleteUnusedWorkspace(nodeId: string, id: string): boolean {
    return this.sqlite.prepare(`
      DELETE FROM workspaces
      WHERE node_id = ? AND id = ? AND is_default = 0
        AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.node_id = workspaces.node_id AND c.workspace_id = workspaces.id)
    `).run(nodeId, id).changes > 0;
  }

  createConversation(record: ConversationRecord): void {
    this.sqlite.prepare(`
      INSERT INTO conversations (
        id, node_id, workspace_id, title, model, effort, client_request_id,
        remote_thread_id, status, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.nodeId,
      record.workspaceId,
      record.title,
      record.model,
      record.effort,
      record.clientRequestId,
      record.remoteThreadId,
      record.status,
      record.error,
      record.createdAt,
      record.updatedAt,
    );
  }

  private conversationFromRow(row: Row): ConversationRecord {
    const hasEmbeddedLatestRun = Object.hasOwn(row, "latest_run_status");
    const latestRun = hasEmbeddedLatestRun ? undefined : this.sqlite.prepare(
      "SELECT status FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(text(row, "id")) as Row | undefined;
    return {
      id: text(row, "id"),
      nodeId: text(row, "node_id"),
      workspaceId: text(row, "workspace_id"),
      title: text(row, "title"),
      model: nullableText(row, "model"),
      effort: nullableText(row, "effort"),
      clientRequestId: nullableText(row, "client_request_id"),
      remoteThreadId: nullableText(row, "remote_thread_id"),
      status: text(row, "status") as ConversationRecord["status"],
      error: nullableText(row, "error"),
      pinnedAt: nullableText(row, "pinned_at"),
      latestRunStatus: hasEmbeddedLatestRun
        ? nullableText(row, "latest_run_status") as RunRecord["status"] | null
        : latestRun ? text(latestRun, "status") as RunRecord["status"] : null,
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
    };
  }

  getConversation(id: string): ConversationRecord | null {
    const row = this.sqlite.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Row | undefined;
    return row ? this.conversationFromRow(row) : null;
  }

  getConversationByClientRequestId(clientRequestId: string): ConversationRecord | null {
    const row = this.sqlite.prepare(
      "SELECT * FROM conversations WHERE client_request_id = ?",
    ).get(clientRequestId) as Row | undefined;
    return row ? this.conversationFromRow(row) : null;
  }

  listConversations(nodeId?: string): ConversationRecord[] {
    const rows = (nodeId
      ? this.sqlite.prepare("SELECT * FROM conversations WHERE node_id = ? ORDER BY updated_at DESC").all(nodeId)
      : this.sqlite.prepare("SELECT * FROM conversations ORDER BY updated_at DESC").all()) as Row[];
    return rows.map((row) => this.conversationFromRow(row));
  }

  listConversationPage(options: {
    nodeId?: string;
    query?: string;
    runStatus?: "active" | "failed";
    limit: number;
    cursor?: ConversationListCursor;
    includeTotal?: boolean;
  }): ConversationPage {
    const predicates: string[] = [];
    const baseParameters: Array<string | number> = [];
    if (options.nodeId) {
      predicates.push("c.node_id = ?");
      baseParameters.push(options.nodeId);
    }
    const query = options.query?.trim();
    if (query) {
      if (options.nodeId) {
        predicates.push("instr(lower(c.title), lower(?)) > 0");
        baseParameters.push(query);
      } else {
        predicates.push(`(
          instr(lower(c.title), lower(?)) > 0
          OR instr(lower(COALESCE(NULLIF(n.display_name, ''), n.name)), lower(?)) > 0
        )`);
        baseParameters.push(query, query);
      }
    }
    if (options.runStatus) {
      const latestRunStatus = "(SELECT r.status FROM runs r WHERE r.conversation_id = c.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1)";
      if (options.runStatus === "active") {
        predicates.push(`${latestRunStatus} IN ('queued', 'dispatching', 'running', 'waiting_approval', 'recovering')`);
      } else {
        predicates.push(`${latestRunStatus} = 'failed'`);
      }
    }
    const baseWhere = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
    const total = options.includeTotal === false ? undefined : Number((this.sqlite.prepare(`
        SELECT COUNT(*) AS count
        FROM conversations c
        JOIN nodes n ON n.id = c.node_id
        ${baseWhere}
      `).get(...baseParameters) as Row).count);

    const pagePredicates = [...predicates];
    const pageParameters = [...baseParameters];
    if (options.cursor) {
      pagePredicates.push(`(
        (CASE WHEN c.pinned_at IS NULL THEN 0 ELSE 1 END) < ?
        OR ((CASE WHEN c.pinned_at IS NULL THEN 0 ELSE 1 END) = ? AND c.updated_at < ?)
        OR ((CASE WHEN c.pinned_at IS NULL THEN 0 ELSE 1 END) = ? AND c.updated_at = ? AND c.id < ?)
      )`);
      pageParameters.push(
        options.cursor.pinned,
        options.cursor.pinned,
        options.cursor.updatedAt,
        options.cursor.pinned,
        options.cursor.updatedAt,
        options.cursor.id,
      );
    }
    const pageWhere = pagePredicates.length ? `WHERE ${pagePredicates.join(" AND ")}` : "";
    const rows = this.sqlite.prepare(`
      SELECT c.*,
        (SELECT r.status FROM runs r WHERE r.conversation_id = c.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS latest_run_status
      FROM conversations c
      JOIN nodes n ON n.id = c.node_id
      ${pageWhere}
      ORDER BY (CASE WHEN c.pinned_at IS NULL THEN 0 ELSE 1 END) DESC, c.updated_at DESC, c.id DESC
      LIMIT ?
    `).all(...pageParameters, options.limit + 1) as Row[];
    const hasMore = rows.length > options.limit;
    const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
    const last = pageRows.at(-1);
    return {
      data: pageRows.map((row) => this.conversationFromRow(row)),
      ...(total === undefined ? {} : { total }),
      nextCursor: hasMore && last ? {
        pinned: nullableText(last, "pinned_at") ? 1 : 0,
        updatedAt: text(last, "updated_at"),
        id: text(last, "id"),
      } : null,
    };
  }

  bindConversation(id: string, threadId: string, now: string): void {
    this.sqlite.prepare(
      "UPDATE conversations SET remote_thread_id = ?, status = 'ready', error = NULL, updated_at = ? WHERE id = ?",
    ).run(threadId, now, id);
  }

  updateConversationPreferences(id: string, model: string | null, effort: string | null, now: string): void {
    this.sqlite.prepare(
      "UPDATE conversations SET model = ?, effort = ?, updated_at = ? WHERE id = ?",
    ).run(model, effort, now, id);
  }

  updateConversation(id: string, input: { title?: string; pinned?: boolean }, now: string): ConversationRecord | null {
    const current = this.getConversation(id);
    if (!current) return null;
    const title = input.title ?? current.title;
    const pinnedAt = input.pinned === undefined ? current.pinnedAt : input.pinned ? now : null;
    this.sqlite.prepare(
      "UPDATE conversations SET title = ?, pinned_at = ?, updated_at = ? WHERE id = ?",
    ).run(title, pinnedAt, now, id);
    return this.getConversation(id);
  }

  deleteConversation(id: string): boolean {
    this.sqlite.exec("BEGIN");
    try {
      this.sqlite.prepare("DELETE FROM events WHERE conversation_id = ?").run(id);
      const result = this.sqlite.prepare("DELETE FROM conversations WHERE id = ?").run(id);
      this.sqlite.exec("COMMIT");
      return result.changes > 0;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  failConversation(id: string, error: string, now: string): void {
    this.sqlite.prepare(
      "UPDATE conversations SET status = 'error', error = ?, updated_at = ? WHERE id = ?",
    ).run(error, now, id);
  }

  createRun(record: RunRecord): void {
    this.sqlite.prepare(`
      INSERT INTO runs (
        id, conversation_id, prompt, model, effort, client_request_id, remote_turn_id, status,
        progress_phase, progress_label, progress_updated_at, recovery_deadline_at,
        error, created_at, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.conversationId,
      record.prompt,
      record.model,
      record.effort,
      record.clientRequestId,
      record.remoteTurnId,
      record.status,
      record.progressPhase,
      record.progressLabel,
      record.progressUpdatedAt,
      record.recoveryDeadlineAt,
      record.error,
      record.createdAt,
      record.startedAt,
      record.finishedAt,
    );
    this.touchConversation(record.conversationId, record.createdAt);
  }

  createConversationWithRun(conversation: ConversationRecord, run: RunRecord): void {
    this.transaction(() => {
      this.createConversation(conversation);
      this.createRun(run);
    });
  }

  private runFromRow(row: Row): RunRecord {
    return {
      id: text(row, "id"),
      conversationId: text(row, "conversation_id"),
      prompt: text(row, "prompt"),
      model: nullableText(row, "model"),
      effort: nullableText(row, "effort"),
      clientRequestId: nullableText(row, "client_request_id"),
      remoteTurnId: nullableText(row, "remote_turn_id"),
      status: text(row, "status") as RunRecord["status"],
      progressPhase: nullableText(row, "progress_phase"),
      progressLabel: nullableText(row, "progress_label"),
      progressUpdatedAt: nullableText(row, "progress_updated_at"),
      recoveryDeadlineAt: nullableText(row, "recovery_deadline_at"),
      error: nullableText(row, "error"),
      createdAt: text(row, "created_at"),
      startedAt: nullableText(row, "started_at"),
      finishedAt: nullableText(row, "finished_at"),
    };
  }

  getRun(id: string): RunRecord | null {
    const row = this.sqlite.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? this.runFromRow(row) : null;
  }

  getRunByClientRequestId(clientRequestId: string): RunRecord | null {
    const row = this.sqlite.prepare("SELECT * FROM runs WHERE client_request_id = ?").get(clientRequestId) as Row | undefined;
    return row ? this.runFromRow(row) : null;
  }

  listRuns(conversationId: string): RunRecord[] {
    return (this.sqlite.prepare("SELECT * FROM runs WHERE conversation_id = ? ORDER BY created_at").all(conversationId) as Row[])
      .map((row) => this.runFromRow(row));
  }

  canDispatchQueuedRun(nodeId: string, workspaceId: string): boolean {
    const node = this.sqlite.prepare("SELECT max_concurrent_runs FROM nodes WHERE id = ?").get(nodeId) as Row | undefined;
    const workspace = this.sqlite.prepare("SELECT path FROM workspaces WHERE node_id = ? AND id = ?").get(nodeId, workspaceId) as Row | undefined;
    if (!node || !workspace) return false;
    const active = this.sqlite.prepare(`
      SELECT
        COUNT(*) AS node_count,
        SUM(CASE WHEN w.path = ? THEN 1 ELSE 0 END) AS workspace_count
      FROM runs r
      JOIN conversations c ON c.id = r.conversation_id
      JOIN workspaces w ON w.node_id = c.node_id AND w.id = c.workspace_id
      WHERE c.node_id = ?
        AND r.status IN ('dispatching', 'running', 'waiting_approval', 'recovering')
    `).get(text(workspace, "path"), nodeId) as Row;
    return Number(active.node_count) < Number(node.max_concurrent_runs)
      && Number(active.workspace_count ?? 0) === 0;
  }

  markRunDispatching(id: string): void {
    this.sqlite.prepare("UPDATE runs SET status = 'dispatching' WHERE id = ? AND status = 'queued'").run(id);
  }

  startRun(payload: RunStartedPayload): void {
    this.sqlite.prepare(`
      UPDATE runs SET remote_turn_id = ?, status = 'running', progress_phase = 'analyzing',
        progress_label = '正在分析任务', progress_updated_at = ?, recovery_deadline_at = NULL,
        error = NULL, started_at = ? WHERE id = ?
    `).run(payload.turnId, payload.startedAt, payload.startedAt, payload.runId);
    this.touchConversation(payload.conversationId, payload.startedAt);
  }

  updateRunProgress(payload: RunProgressPayload): void {
    this.sqlite.prepare(`
      UPDATE runs SET progress_phase = ?, progress_label = ?, progress_updated_at = ?,
        status = CASE WHEN status = 'recovering' THEN 'running' ELSE status END,
        recovery_deadline_at = NULL
      WHERE id = ? AND status NOT IN ('completed', 'failed', 'interrupted')
    `).run(payload.phase, payload.label, payload.occurredAt, payload.runId);
    this.touchConversation(payload.conversationId, payload.occurredAt);
  }

  finishRun(payload: RunFinishedPayload): void {
    this.sqlite.prepare(`
      UPDATE runs SET status = ?, error = ?, finished_at = ?, recovery_deadline_at = NULL,
        progress_phase = NULL, progress_label = NULL, progress_updated_at = ? WHERE id = ?
        AND status NOT IN ('completed', 'failed', 'interrupted')
    `).run(payload.status, payload.error ?? null, payload.finishedAt, payload.finishedAt, payload.runId);
    this.sqlite.prepare(
      "UPDATE approvals SET status = 'expired', resolved_at = ? WHERE run_id = ? AND status = 'pending'",
    ).run(payload.finishedAt, payload.runId);
    this.touchConversation(payload.conversationId, payload.finishedAt);
  }

  failRun(id: string, error: string, now: string): void {
    this.sqlite.prepare(
      "UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
    ).run(error, now, id);
  }

  reconcileNodeRuns(nodeId: string, activeRunIds: string[], now: string): string[] {
    const recovering = this.sqlite.prepare(`
      SELECT r.id FROM runs r JOIN conversations c ON c.id = r.conversation_id
      WHERE c.node_id = ? AND r.status = 'recovering'
    `).all(nodeId) as Row[];
    const active = new Set(activeRunIds);
    const failed: string[] = [];
    for (const row of recovering) {
      const runId = text(row, "id");
      if (active.has(runId)) {
        this.sqlite.prepare("UPDATE runs SET status = 'running', recovery_deadline_at = NULL WHERE id = ?").run(runId);
      } else {
        this.failRun(runId, "节点重启后无法确认原任务状态，为避免重复执行，任务没有自动重跑", now);
        failed.push(runId);
      }
    }
    return failed;
  }

  failExpiredRecoveringRuns(now: string): string[] {
    const rows = this.sqlite.prepare(`
      SELECT id FROM runs WHERE status = 'recovering' AND recovery_deadline_at IS NOT NULL AND recovery_deadline_at < ?
    `).all(now) as Row[];
    for (const row of rows) this.failRun(text(row, "id"), "无法确认远端任务状态，恢复等待已超时", now);
    return rows.map((row) => text(row, "id"));
  }

  private touchConversation(id: string, now: string): void {
    this.sqlite.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, id);
  }

  insertUserMessage(input: {
    id: string;
    conversationId: string;
    runId: string | null;
    content: string;
    attachmentIds?: string[];
    createdAt: string;
  }): void {
    this.sqlite.prepare(`
      INSERT OR IGNORE INTO messages (
        id, conversation_id, run_id, role, content, revision, complete,
        attachment_ids_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'user', ?, 1, 1, ?, ?, ?)
    `).run(
      input.id,
      input.conversationId,
      input.runId,
      input.content,
      JSON.stringify(input.attachmentIds ?? []),
      input.createdAt,
      input.createdAt,
    );
    this.touchConversation(input.conversationId, input.createdAt);
  }

  upsertMessageSnapshot(payload: MessageSnapshotPayload): boolean {
    const result = this.sqlite.prepare(`
      INSERT INTO messages (
        id, conversation_id, run_id, role, content, revision, complete,
        attachment_ids_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        revision = excluded.revision,
        complete = excluded.complete,
        updated_at = excluded.updated_at
      WHERE excluded.revision > messages.revision
    `).run(
      payload.messageId,
      payload.conversationId,
      payload.runId,
      payload.role,
      payload.content,
      payload.revision,
      payload.complete ? 1 : 0,
      payload.occurredAt,
      payload.occurredAt,
    );
    if (result.changes > 0) this.touchConversation(payload.conversationId, payload.occurredAt);
    return result.changes > 0;
  }

  listMessages(conversationId: string): MessageRecord[] {
    const rows = this.sqlite.prepare(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, CASE role WHEN 'user' THEN 0 ELSE 1 END, id",
    ).all(conversationId) as Row[];
    return rows.map((row) => ({
      id: text(row, "id"),
      conversationId: text(row, "conversation_id"),
      runId: nullableText(row, "run_id"),
      role: text(row, "role") as MessageRecord["role"],
      content: text(row, "content"),
      revision: Number(row.revision),
      complete: Number(row.complete) === 1,
      attachmentIds: parseJson(row.attachment_ids_json ?? "[]") as string[],
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
    }));
  }

  insertApproval(nodeId: string, approval: InteractionRequestedPayload): void {
    this.sqlite.prepare(`
      INSERT INTO approvals (
        id, node_id, conversation_id, run_id, method, request_id, summary, risk, details_json,
        response_json, status, requested_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, NULL)
      ON CONFLICT(id) DO NOTHING
    `).run(
      approval.approvalId,
      nodeId,
      approval.conversationId,
      approval.runId ?? null,
      approval.method,
      approval.requestId,
      approval.summary,
      approval.risk ?? null,
      JSON.stringify(approval.details),
      approval.requestedAt,
    );
    if (approval.runId) {
      this.sqlite.prepare(
        "UPDATE runs SET status = 'waiting_approval', progress_phase = 'waiting_user', progress_label = '等待你的操作', progress_updated_at = ? WHERE id = ? AND status = 'running'",
      ).run(approval.requestedAt, approval.runId);
    }
  }

  private approvalFromRow(row: Row): ApprovalRecord {
    return {
      id: text(row, "id"),
      nodeId: text(row, "node_id"),
      conversationId: text(row, "conversation_id"),
      runId: nullableText(row, "run_id"),
      method: text(row, "method"),
      requestId: text(row, "request_id"),
      summary: text(row, "summary"),
      risk: nullableText(row, "risk"),
      details: parseJson(row.details_json),
      response: row.response_json === null ? null : parseJson(row.response_json),
      status: text(row, "status") as ApprovalRecord["status"],
      requestedAt: text(row, "requested_at"),
      resolvedAt: nullableText(row, "resolved_at"),
    };
  }

  getApproval(id: string): ApprovalRecord | null {
    const row = this.sqlite.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
    return row ? this.approvalFromRow(row) : null;
  }

  listApprovals(status?: string, conversationId?: string): ApprovalRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (status) {
      clauses.push("status = ?");
      values.push(status);
    }
    if (conversationId) {
      clauses.push("conversation_id = ?");
      values.push(conversationId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.sqlite.prepare(`SELECT * FROM approvals ${where} ORDER BY requested_at DESC`).all(...values) as Row[];
    return rows.map((row) => this.approvalFromRow(row));
  }

  resolveApproval(id: string, response: unknown, now: string): void {
    this.sqlite.prepare(`
      UPDATE approvals SET response_json = ?, status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'pending'
    `).run(JSON.stringify(response), now, id);
    const approval = this.getApproval(id);
    if (approval?.runId) {
      this.sqlite.prepare(
        "UPDATE runs SET status = 'running', progress_phase = 'working', progress_label = '正在继续任务', progress_updated_at = ? WHERE id = ? AND status = 'waiting_approval'",
      ).run(now, approval.runId);
      this.sqlite.prepare(
        "DELETE FROM notifications WHERE run_id = ? AND kind = 'waiting_user'",
      ).run(approval.runId);
    }
  }

  createCommand(id: string, nodeId: string, command: ControlCommand, now: string): CommandRecord {
    const result = this.sqlite.prepare(`
      INSERT OR IGNORE INTO commands (id, node_id, kind, payload_json, status, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', NULL, ?, ?)
    `).run(id, nodeId, command.type, JSON.stringify(command), now, now);
    if (result.changes === 0) {
      const existing = this.getCommand(id);
      if (!existing) throw new Error(`Unable to read existing command: ${id}`);
      return existing;
    }
    return { id, nodeId, kind: command.type, command, status: "queued", error: null, createdAt: now, updatedAt: now };
  }

  getCommand(id: string): CommandRecord | null {
    const row = this.sqlite.prepare("SELECT * FROM commands WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: text(row, "id"),
      nodeId: text(row, "node_id"),
      kind: text(row, "kind"),
      command: parseJson(row.payload_json) as ControlCommand,
      status: text(row, "status") as CommandRecord["status"],
      error: nullableText(row, "error"),
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
    };
  }

  updateCommand(id: string, status: CommandRecord["status"], error: string | null, now: string): void {
    this.sqlite.prepare(
      "UPDATE commands SET status = ?, error = ?, updated_at = ? WHERE id = ?",
    ).run(status, error, now, id);
  }

  listPendingCommands(nodeId: string): CommandRecord[] {
    const rows = this.sqlite.prepare(`
      SELECT * FROM commands WHERE node_id = ? AND status IN ('queued', 'accepted') ORDER BY created_at
    `).all(nodeId) as Row[];
    return rows.map((row) => ({
      id: text(row, "id"),
      nodeId: text(row, "node_id"),
      kind: text(row, "kind"),
      command: parseJson(row.payload_json) as ControlCommand,
      status: text(row, "status") as CommandRecord["status"],
      error: nullableText(row, "error"),
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
    }));
  }

  deliveryExists(nodeId: string, bootId: string, sequence: number): boolean {
    return Boolean(this.sqlite.prepare(
      "SELECT 1 FROM deliveries WHERE node_id = ? AND boot_id = ? AND sequence = ?",
    ).get(nodeId, bootId, sequence));
  }

  recordDelivery(nodeId: string, bootId: string, sequence: number, now: string): void {
    this.sqlite.prepare(
      "INSERT OR IGNORE INTO deliveries (node_id, boot_id, sequence, received_at) VALUES (?, ?, ?, ?)",
    ).run(nodeId, bootId, sequence, now);
  }

  applyAgentError(error: AgentErrorPayload, now: string): void {
    if (error.runId) this.failRun(error.runId, error.message, now);
    if (error.conversationId && this.getConversation(error.conversationId)?.status === "creating") {
      this.failConversation(error.conversationId, error.message, now);
    }
  }

  createNotification(input: Omit<NotificationRecord, "id" | "readAt"> & { id?: string }): NotificationRecord {
    const id = input.id ?? `${input.runId ?? input.conversationId}:${input.kind}`;
    this.sqlite.prepare(`
      INSERT INTO notifications (id, node_id, conversation_id, run_id, kind, title, read_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, read_at = NULL, created_at = excluded.created_at
    `).run(id, input.nodeId, input.conversationId, input.runId, input.kind, input.title, input.createdAt);
    return { id, nodeId: input.nodeId, conversationId: input.conversationId, runId: input.runId, kind: input.kind, title: input.title, readAt: null, createdAt: input.createdAt };
  }

  listNotifications(unreadOnly = false): NotificationRecord[] {
    const rows = this.sqlite.prepare(`
      SELECT * FROM notifications ${unreadOnly ? "WHERE read_at IS NULL" : ""} ORDER BY created_at DESC
    `).all() as Row[];
    return rows.map((row) => ({
      id: text(row, "id"),
      nodeId: text(row, "node_id"),
      conversationId: text(row, "conversation_id"),
      runId: nullableText(row, "run_id"),
      kind: text(row, "kind") as NotificationRecord["kind"],
      title: text(row, "title"),
      readAt: nullableText(row, "read_at"),
      createdAt: text(row, "created_at"),
    }));
  }

  markConversationNotificationsRead(conversationId: string, now: string): number {
    return Number(this.sqlite.prepare(
      "UPDATE notifications SET read_at = ? WHERE conversation_id = ? AND read_at IS NULL",
    ).run(now, conversationId).changes);
  }

  markNotificationRead(id: string, now: string): boolean {
    return this.sqlite.prepare("UPDATE notifications SET read_at = ? WHERE id = ?").run(now, id).changes > 0;
  }

  markAllNotificationsRead(now: string): number {
    return Number(this.sqlite.prepare(
      "UPDATE notifications SET read_at = ? WHERE read_at IS NULL",
    ).run(now).changes);
  }

  listTaskCenter(limit = 200): TaskCenterRecord[] {
    const normalizedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const active = this.sqlite.prepare(`
      SELECT r.id, r.status, r.progress_label, r.created_at, r.started_at,
        c.id AS conversation_id, c.title AS conversation_title,
        n.id AS node_id, COALESCE(n.display_name, n.name) AS node_name,
        (SELECT m.content FROM messages m
          WHERE m.conversation_id = c.id AND m.run_id = r.id AND m.role = 'assistant'
          ORDER BY m.updated_at DESC, m.id DESC LIMIT 1) AS latest_reply
      FROM runs r
      JOIN conversations c ON c.id = r.conversation_id
      JOIN nodes n ON n.id = c.node_id
      WHERE r.status IN ('queued', 'dispatching', 'running', 'waiting_approval', 'recovering')
      ORDER BY COALESCE(r.started_at, r.created_at) DESC
    `).all() as Row[];
    const notifications = this.sqlite.prepare(`
      SELECT x.*, c.title AS conversation_title,
        n.id AS node_id_value, COALESCE(n.display_name, n.name) AS node_name,
        (SELECT m.content FROM messages m
          WHERE m.conversation_id = c.id AND m.role = 'assistant'
            AND (x.run_id IS NULL OR m.run_id = x.run_id)
          ORDER BY m.updated_at DESC, m.id DESC LIMIT 1) AS latest_reply
      FROM notifications x
      JOIN conversations c ON c.id = x.conversation_id
      JOIN nodes n ON n.id = x.node_id
      ORDER BY x.created_at DESC
      LIMIT ?
    `).all(normalizedLimit) as Row[];
    const notificationRecords = notifications.map((row): TaskCenterRecord => ({
      id: text(row, "id"),
      nodeId: text(row, "node_id_value"),
      nodeName: text(row, "node_name"),
      conversationId: text(row, "conversation_id"),
      conversationTitle: text(row, "conversation_title"),
      runId: nullableText(row, "run_id"),
      status: text(row, "kind") as NotificationRecord["kind"],
      progressLabel: text(row, "title"),
      replyPreview: notificationPreview(nullableText(row, "latest_reply")),
      unread: row.read_at === null,
      occurredAt: text(row, "created_at"),
    }));
    const activeRunIds = new Set(active.map((row) => text(row, "id")));
    const activeRecords = active.map((row): TaskCenterRecord => {
      const notification = notificationRecords.find((entry) => entry.runId === text(row, "id"));
      return {
        id: `active:${text(row, "id")}`,
        nodeId: text(row, "node_id"),
        nodeName: text(row, "node_name"),
        conversationId: text(row, "conversation_id"),
        conversationTitle: text(row, "conversation_title"),
        runId: text(row, "id"),
        status: text(row, "status") as RunRecord["status"],
        progressLabel: nullableText(row, "progress_label"),
        replyPreview: notificationPreview(nullableText(row, "latest_reply")),
        unread: notification?.unread ?? false,
        occurredAt: nullableText(row, "started_at") ?? text(row, "created_at"),
      };
    });
    return [
      ...activeRecords,
      ...notificationRecords.filter((entry) => !entry.runId || !activeRunIds.has(entry.runId)),
    ].slice(0, normalizedLimit);
  }

  getGlobalSettings(): GlobalSettingsRecord {
    const rows = this.sqlite.prepare(
      "SELECT key, value_json FROM settings WHERE scope = 'global' AND scope_id = 'default'",
    ).all() as Row[];
    const values = new Map(rows.map((row) => [text(row, "key"), parseJson(row.value_json)]));
    return {
      defaultModel: typeof values.get("defaultModel") === "string" ? values.get("defaultModel") as string : null,
      defaultEffort: typeof values.get("defaultEffort") === "string" ? values.get("defaultEffort") as string : null,
    };
  }

  updateGlobalSettings(settings: GlobalSettingsRecord, now: string): GlobalSettingsRecord {
    const statement = this.sqlite.prepare(`
      INSERT INTO settings (scope, scope_id, key, value_json, updated_at)
      VALUES ('global', 'default', ?, ?, ?)
      ON CONFLICT(scope, scope_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `);
    this.sqlite.exec("BEGIN");
    try {
      statement.run("defaultModel", JSON.stringify(settings.defaultModel), now);
      statement.run("defaultEffort", JSON.stringify(settings.defaultEffort), now);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getGlobalSettings();
  }

  createAttachment(record: AttachmentRecord): AttachmentRecord {
    this.sqlite.prepare(`
      INSERT INTO attachments (
        id, conversation_id, message_client_id, name, media_type, size, received_size,
        sha256, status, storage_key, download_token, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.conversationId, record.messageClientId, record.name, record.mediaType,
      record.size, record.receivedSize, record.sha256, record.status, record.storageKey,
      record.downloadToken, record.expiresAt, record.createdAt,
    );
    return record;
  }

  totalAttachmentBytes(): number {
    const row = this.sqlite.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM attachments").get() as Row;
    return Number(row.total);
  }

  private attachmentFromRow(row: Row): AttachmentRecord {
    return {
      id: text(row, "id"),
      conversationId: nullableText(row, "conversation_id"),
      messageClientId: text(row, "message_client_id"),
      name: text(row, "name"),
      mediaType: text(row, "media_type"),
      size: Number(row.size),
      receivedSize: Number(row.received_size),
      sha256: nullableText(row, "sha256"),
      status: text(row, "status") as AttachmentRecord["status"],
      storageKey: text(row, "storage_key"),
      downloadToken: text(row, "download_token"),
      expiresAt: text(row, "expires_at"),
      createdAt: text(row, "created_at"),
    };
  }

  getAttachment(id: string): AttachmentRecord | null {
    const row = this.sqlite.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as Row | undefined;
    return row ? this.attachmentFromRow(row) : null;
  }

  listAttachments(ids: string[]): AttachmentRecord[] {
    return ids.map((id) => this.getAttachment(id)).filter((value): value is AttachmentRecord => Boolean(value));
  }

  listConversationAttachments(conversationId: string): AttachmentRecord[] {
    return (this.sqlite.prepare(
      "SELECT * FROM attachments WHERE conversation_id = ? ORDER BY created_at",
    ).all(conversationId) as Row[]).map((row) => this.attachmentFromRow(row));
  }

  updateAttachmentOffset(id: string, expectedOffset: number, chunkLength: number): AttachmentRecord | null {
    const result = this.sqlite.prepare(`
      UPDATE attachments SET received_size = received_size + ?
      WHERE id = ? AND status = 'uploading' AND received_size = ? AND received_size + ? <= size
    `).run(chunkLength, id, expectedOffset, chunkLength);
    return result.changes > 0 ? this.getAttachment(id) : null;
  }

  finalizeAttachment(id: string, sha256: string, storageKey: string): AttachmentRecord | null {
    const result = this.sqlite.prepare(`
      UPDATE attachments SET sha256 = ?, storage_key = ?, status = 'ready'
      WHERE id = ? AND status = 'uploading' AND received_size = size
    `).run(sha256, storageKey, id);
    return result.changes > 0 ? this.getAttachment(id) : null;
  }

  bindAttachments(ids: string[], conversationId: string): void {
    const statement = this.sqlite.prepare(
      "UPDATE attachments SET conversation_id = ?, status = 'consumed' WHERE id = ? AND status = 'ready'",
    );
    for (const id of ids) statement.run(conversationId, id);
  }

  listExpiredAttachments(now: string): AttachmentRecord[] {
    return (this.sqlite.prepare("SELECT * FROM attachments WHERE expires_at < ?").all(now) as Row[])
      .map((row) => this.attachmentFromRow(row));
  }

  deleteAttachment(id: string): void {
    this.sqlite.prepare("DELETE FROM attachments WHERE id = ?").run(id);
  }

  setAdminTokenHash(tokenHash: string, updatedAt: string): void {
    this.sqlite.prepare(`
      INSERT INTO admin_credentials (id, token_hash, updated_at)
      VALUES ('primary', ?, ?)
      ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, updated_at = excluded.updated_at
    `).run(tokenHash, updatedAt);
  }

  getAdminTokenHash(): string | null {
    const row = this.sqlite.prepare("SELECT token_hash FROM admin_credentials WHERE id = 'primary'").get() as Row | undefined;
    return row ? text(row, "token_hash") : null;
  }

  createAdminSession(record: AdminSessionRecord): void {
    this.sqlite.prepare(`
      INSERT INTO admin_sessions (id, token_hash, created_at, last_seen_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(record.id, record.tokenHash, record.createdAt, record.lastSeenAt, record.expiresAt, record.revokedAt);
  }

  getAdminSession(id: string): AdminSessionRecord | null {
    const row = this.sqlite.prepare("SELECT * FROM admin_sessions WHERE id = ?").get(id) as Row | undefined;
    return row ? {
      id: text(row, "id"),
      tokenHash: text(row, "token_hash"),
      createdAt: text(row, "created_at"),
      lastSeenAt: text(row, "last_seen_at"),
      expiresAt: text(row, "expires_at"),
      revokedAt: nullableText(row, "revoked_at"),
    } : null;
  }

  touchAdminSession(id: string, lastSeenAt: string): void {
    this.sqlite.prepare("UPDATE admin_sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL").run(lastSeenAt, id);
  }

  revokeAdminSession(id: string, revokedAt: string): void {
    this.sqlite.prepare("UPDATE admin_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(revokedAt, id);
  }

  revokeAllAdminSessions(revokedAt: string): number {
    return Number(this.sqlite.prepare("UPDATE admin_sessions SET revoked_at = ? WHERE revoked_at IS NULL").run(revokedAt).changes);
  }

  cleanupAdminSessions(cutoff: string): number {
    return Number(this.sqlite.prepare("DELETE FROM admin_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)").run(cutoff, cutoff).changes);
  }

  createEnrollmentToken(record: EnrollmentTokenRecord): void {
    this.sqlite.prepare(`
      INSERT INTO enrollment_tokens (id, token_hash, token_ciphertext, created_at, expires_at, used_at, revoked_at, node_id, credential_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.id, record.tokenHash, record.tokenCiphertext, record.createdAt, record.expiresAt, record.usedAt, record.revokedAt, record.nodeId, record.credentialId);
  }

  private enrollmentTokenFromRow(row: Row): EnrollmentTokenRecord {
    return {
      id: text(row, "id"),
      tokenHash: text(row, "token_hash"),
      tokenCiphertext: nullableText(row, "token_ciphertext"),
      createdAt: text(row, "created_at"),
      expiresAt: text(row, "expires_at"),
      usedAt: nullableText(row, "used_at"),
      revokedAt: nullableText(row, "revoked_at"),
      nodeId: nullableText(row, "node_id"),
      credentialId: nullableText(row, "credential_id"),
    };
  }

  getEnrollmentToken(id: string): EnrollmentTokenRecord | null {
    const row = this.sqlite.prepare("SELECT * FROM enrollment_tokens WHERE id = ?").get(id) as Row | undefined;
    return row ? this.enrollmentTokenFromRow(row) : null;
  }

  listEnrollmentTokens(limit = 30): EnrollmentTokenRecord[] {
    return (this.sqlite.prepare("SELECT * FROM enrollment_tokens ORDER BY created_at DESC LIMIT ?").all(Math.max(1, Math.min(100, limit))) as Row[])
      .map((row) => this.enrollmentTokenFromRow(row));
  }

  revokeEnrollmentToken(id: string, revokedAt: string): boolean {
    return this.sqlite.prepare(`
      UPDATE enrollment_tokens SET revoked_at = ?
      WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
    `).run(revokedAt, id, revokedAt).changes > 0;
  }

  cleanupEnrollmentTokens(expiredAt: string): number {
    return Number(this.sqlite.prepare("DELETE FROM enrollment_tokens WHERE expires_at <= ?").run(expiredAt).changes);
  }

  consumeEnrollmentToken(input: {
    id: string;
    nodeId: string;
    credentialId: string;
    credentialHash: string;
    usedAt: string;
  }): boolean {
    return this.transaction(() => {
      const token = this.getEnrollmentToken(input.id);
      if (!token || token.revokedAt || token.expiresAt <= input.usedAt) return false;
      const credentialWithSameId = this.getNodeCredential(input.credentialId);
      if (credentialWithSameId
        && (credentialWithSameId.nodeId !== input.nodeId || credentialWithSameId.tokenHash !== input.credentialHash)) return false;
      if (token.usedAt) {
        const existing = credentialWithSameId;
        return token.nodeId === input.nodeId
          && token.credentialId === input.credentialId
          && existing?.nodeId === input.nodeId
          && existing.tokenHash === input.credentialHash
          && !existing.revokedAt;
      }
      const claimed = this.sqlite.prepare(`
        UPDATE enrollment_tokens
        SET used_at = ?, node_id = ?, credential_id = ?
        WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
      `).run(input.usedAt, input.nodeId, input.credentialId, input.id, input.usedAt);
      if (claimed.changes === 0) return false;
      this.sqlite.prepare(`
        INSERT INTO node_credentials (id, node_id, token_hash, created_at, last_used_at, revoked_at)
        VALUES (?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(id) DO UPDATE SET
          node_id = excluded.node_id,
          token_hash = excluded.token_hash,
          created_at = excluded.created_at,
          last_used_at = NULL,
          revoked_at = NULL
      `).run(input.credentialId, input.nodeId, input.credentialHash, input.usedAt);
      return true;
    });
  }

  getNodeCredential(id: string): NodeCredentialRecord | null {
    const row = this.sqlite.prepare("SELECT * FROM node_credentials WHERE id = ?").get(id) as Row | undefined;
    return row ? {
      id: text(row, "id"),
      nodeId: text(row, "node_id"),
      tokenHash: text(row, "token_hash"),
      createdAt: text(row, "created_at"),
      lastUsedAt: nullableText(row, "last_used_at"),
      revokedAt: nullableText(row, "revoked_at"),
    } : null;
  }

  touchNodeCredential(id: string, usedAt: string): void {
    this.sqlite.prepare("UPDATE node_credentials SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL").run(usedAt, id);
  }

  nodeHasCredentials(nodeId: string): boolean {
    return Boolean(this.sqlite.prepare("SELECT 1 FROM node_credentials WHERE node_id = ? LIMIT 1").get(nodeId));
  }

  revokeNodeCredentials(nodeId: string, revokedAt: string): number {
    return Number(this.sqlite.prepare(`
      UPDATE node_credentials SET revoked_at = ?
      WHERE node_id = ? AND revoked_at IS NULL
    `).run(revokedAt, nodeId).changes);
  }

  createUiEvent(type: string, resourceId: string | null, occurredAt: string): UiEventRecord {
    const result = this.sqlite.prepare(
      "INSERT INTO ui_events (type, resource_id, occurred_at) VALUES (?, ?, ?)",
    ).run(type, resourceId, occurredAt);
    return { revision: Number(result.lastInsertRowid), type, resourceId, occurredAt };
  }

  listUiEventsAfter(revision: number, limit = 1000): UiEventRecord[] {
    return (this.sqlite.prepare(
      "SELECT * FROM ui_events WHERE revision > ? ORDER BY revision LIMIT ?",
    ).all(revision, limit) as Row[]).map((row) => ({
      revision: Number(row.revision),
      type: text(row, "type"),
      resourceId: nullableText(row, "resource_id"),
      occurredAt: text(row, "occurred_at"),
    }));
  }

  currentUiRevision(): number {
    const row = this.sqlite.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM ui_events").get() as Row;
    return Number(row.revision);
  }

  cleanupNotifications(readCutoff: string, unreadCutoff: string, maximumStored = 2000): number {
    const expired = this.sqlite.prepare(`
      DELETE FROM notifications
      WHERE (read_at IS NOT NULL AND created_at < ?)
        OR created_at < ?
    `).run(readCutoff, unreadCutoff);
    const overflow = this.sqlite.prepare(`
      DELETE FROM notifications
      WHERE read_at IS NOT NULL AND id IN (
        SELECT id FROM notifications
        ORDER BY created_at DESC
        LIMIT -1 OFFSET ?
      )
    `).run(Math.max(1, Math.trunc(maximumStored)));
    return Number(expired.changes) + Number(overflow.changes);
  }

  cleanupUiEvents(cutoff: string): number {
    return Number(this.sqlite.prepare("DELETE FROM ui_events WHERE occurred_at < ?").run(cutoff).changes);
  }
}
