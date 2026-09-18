import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import {
  CONTROL_PROTOCOL_VERSION,
  WORKSPACE_FILE_READ_CAPABILITY,
  isRecord,
  parseAgentMessage,
  type AgentDurableMessage,
  type ControlCommand,
  type ControlCommandMessage,
  type AttachmentDescriptor,
  type JsonValue,
  type ReasoningEffort,
} from "@controller-center/protocol";
import { loadConfig } from "./config.js";
import { findAgentPackage } from "./agent-package.js";
import { AgentConnections } from "./connections.js";
import { ControlDatabase, type CommandRecord, type ConversationListCursor, type EnrollmentTokenRecord, type MessageListCursor, type WorkspaceRecord } from "./database.js";
import { UiEventBus } from "./event-bus.js";
import {
  ADMIN_SESSION_IDLE_MS,
  ADMIN_SESSION_LIFETIME_MS,
  ENROLLMENT_TOKEN_LIFETIME_MS,
  createOpaqueToken,
  decryptEnrollmentToken,
  encryptEnrollmentToken,
  ensureAdminToken,
  ensureEnrollmentDisplayKey,
  hashSecret,
  parseOpaqueToken,
  secretMatches,
} from "./auth.js";

const config = loadConfig();
const controlPlanePackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const agentPackageVersion = controlPlanePackage.version;
const database = new ControlDatabase(config.databasePath);
ensureAdminToken(database, config.adminTokenPath, config.adminToken);
const enrollmentDisplayKey = ensureEnrollmentDisplayKey(config.enrollmentDisplayKeyPath);
const connections = new AgentConnections();
const events = new UiEventBus();
const app = Fastify({ logger: true, trustProxy: config.trustProxy });
const uiStreams = new Set<FastifyReply["raw"]>();
const taskCenterPolicy = { limit: 200, replyPreviewCharacters: 120, readRetentionDays: 30, unreadRetentionDays: 90 } as const;
const workspaceFileMaxBytes = 8 * 1024 * 1024;
const workspaceFileCacheMaxBytes = 64 * 1024 * 1024;
const workspaceFileLifetimeMs = 5 * 60 * 1000;

interface WorkspaceFileCacheEntry {
  id: string;
  conversationId: string;
  nodeId: string;
  path: string;
  name: string;
  mediaType: string;
  content: Buffer;
  createdAt: number;
  expiresAt: number;
}

const workspaceFileCache = new Map<string, WorkspaceFileCacheEntry>();
const workspaceFileRequests = new Map<string, number[]>();
mkdirSync(config.attachmentDirectory, { recursive: true, mode: 0o700 });
app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: 2 * 1024 * 1024 }, (_request, body, done) => {
  done(null, body);
});

await app.register(cors, {
  origin: config.corsOrigin === "*"
    ? true
    : config.corsOrigin.split(",").map((value) => value.trim()),
  credentials: true,
  exposedHeaders: ["X-Request-Id", "Content-Disposition"],
});
await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } });

app.addHook("onRequest", async (request, reply) => {
  reply.header("X-Request-Id", request.id);
});

app.setErrorHandler((error, request, reply) => {
  const candidateStatus = typeof error === "object" && error !== null && "statusCode" in error
    ? Number(error.statusCode)
    : null;
  const statusCode = typeof candidateStatus === "number" && candidateStatus >= 400 && candidateStatus < 600
    ? candidateStatus
    : 500;
  if (statusCode >= 500) request.log.error({ err: error, requestId: request.id }, "Unhandled control-plane request error");
  else request.log.warn({ err: error, requestId: request.id }, "Rejected control-plane request");
  return reply.code(statusCode).send({
    error: statusCode >= 500 ? "控制中心内部错误" : error instanceof Error ? error.message : String(error),
    requestId: request.id,
  });
});

function now(): string {
  return new Date().toISOString();
}

function pruneWorkspaceFileCache(): void {
  const timestamp = Date.now();
  for (const [id, entry] of workspaceFileCache) {
    if (entry.expiresAt <= timestamp) workspaceFileCache.delete(id);
  }
  let totalBytes = [...workspaceFileCache.values()].reduce((sum, entry) => sum + entry.content.byteLength, 0);
  for (const [id, entry] of workspaceFileCache) {
    if (totalBytes <= workspaceFileCacheMaxBytes) break;
    workspaceFileCache.delete(id);
    totalBytes -= entry.content.byteLength;
  }
}

function publicWorkspaceFile(file: WorkspaceFileCacheEntry) {
  return {
    id: file.id,
    conversationId: file.conversationId,
    name: file.name,
    path: file.path,
    mediaType: file.mediaType,
    size: file.content.byteLength,
    expiresAt: new Date(file.expiresAt).toISOString(),
    contentUrl: `/api/workspace-files/${file.id}/content`,
  };
}

function consumeWorkspaceFileRateLimit(bucketId: string, limit: number): boolean {
  const cutoff = Date.now() - 60_000;
  for (const [id, timestamps] of workspaceFileRequests) {
    if (id === bucketId) continue;
    const active = timestamps.filter((timestamp) => timestamp > cutoff);
    if (active.length) workspaceFileRequests.set(id, active);
    else workspaceFileRequests.delete(id);
  }
  const recent = (workspaceFileRequests.get(bucketId) ?? []).filter((timestamp) => timestamp > cutoff);
  if (recent.length >= limit) {
    workspaceFileRequests.set(bucketId, recent);
    return false;
  }
  recent.push(Date.now());
  workspaceFileRequests.set(bucketId, recent);
  return true;
}

function encodeConversationCursor(cursor: ConversationListCursor | null): string | null {
  return cursor ? Buffer.from(JSON.stringify(cursor)).toString("base64url") : null;
}

function decodeConversationCursor(value: string | undefined): ConversationListCursor | null {
  if (!value || value.length > 512) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ConversationListCursor>;
    if ((decoded.pinned !== 0 && decoded.pinned !== 1)
      || typeof decoded.updatedAt !== "string"
      || !Number.isFinite(Date.parse(decoded.updatedAt))
      || typeof decoded.id !== "string"
      || !decoded.id) return null;
    return { pinned: decoded.pinned, updatedAt: decoded.updatedAt, id: decoded.id };
  } catch {
    return null;
  }
}

function encodeMessageCursor(cursor: MessageListCursor | null): string | null {
  return cursor ? Buffer.from(JSON.stringify(cursor)).toString("base64url") : null;
}

function decodeMessageCursor(value: string | undefined): MessageListCursor | null {
  if (!value || value.length > 512) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<MessageListCursor>;
    if (typeof decoded.createdAt !== "string"
      || !Number.isFinite(Date.parse(decoded.createdAt))
      || (decoded.roleOrder !== 0 && decoded.roleOrder !== 1)
      || typeof decoded.id !== "string"
      || !decoded.id) return null;
    return { createdAt: decoded.createdAt, roleOrder: decoded.roleOrder, id: decoded.id };
  } catch {
    return null;
  }
}

const reasoningEfforts = new Set<ReasoningEffort>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function automaticConversationTitle(prompt: string): string {
  const normalized = prompt
    .replace(/```[\s\S]*?```/g, " 代码 ")
    .replace(/[`*_>#]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:请(?:帮我)?|麻烦(?:帮我)?|帮我|帮忙|可以帮我|能否|我想(?:要)?|我需要)\s*/u, "");
  const sentence = normalized.split(/[。！？!?\n]/u)[0]?.trim() ?? "";
  const source = sentence || normalized;
  if (!source) {
    const time = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date());
    return `新会话 ${time}`;
  }
  const characters = Array.from(source);
  return characters.length > 30 ? `${characters.slice(0, 30).join("")}…` : source;
}

function safeTokenEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function bearerToken(request: FastifyRequest): string {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

const secureAdminCookie = config.publicOrigin.startsWith("https://");
const adminCookieName = secureAdminCookie ? "__Host-cc_session" : "cc_session";
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function cookieValue(request: FastifyRequest, name: string): string {
  const source = request.headers.cookie ?? "";
  for (const part of source.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function sessionCookie(token: string, maximumAgeSeconds = Math.floor(ADMIN_SESSION_LIFETIME_MS / 1000)): string {
  return `${adminCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maximumAgeSeconds}${secureAdminCookie ? "; Secure" : ""}`;
}

function authenticatedSession(request: FastifyRequest, touch = false): { id: string; expiresAt: string } | null {
  const parsed = parseOpaqueToken(cookieValue(request, adminCookieName), "ccs");
  if (!parsed) return null;
  const session = database.getAdminSession(parsed.id);
  const timestamp = Date.now();
  if (!session
    || session.revokedAt
    || !secretMatches(parsed.token, session.tokenHash)
    || Date.parse(session.expiresAt) <= timestamp
    || Date.parse(session.lastSeenAt) + ADMIN_SESSION_IDLE_MS <= timestamp) return null;
  if (touch && timestamp - Date.parse(session.lastSeenAt) > 5 * 60 * 1000) {
    database.touchAdminSession(session.id, new Date(timestamp).toISOString());
  }
  return { id: session.id, expiresAt: session.expiresAt };
}

function requestHasValidAdminToken(request: FastifyRequest): boolean {
  const token = bearerToken(request);
  const tokenHash = database.getAdminTokenHash();
  return Boolean(token && tokenHash && secretMatches(token, tokenHash));
}

function originAllowed(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  const configured = new Set([
    config.publicOrigin,
    ...config.corsOrigin.split(",").map((value) => value.trim()),
  ]);
  return config.corsOrigin === "*" || configured.has(origin);
}

app.addHook("onRequest", async (request, reply) => {
  const pathname = request.url.split("?", 1)[0] ?? request.url;
  if (!pathname.startsWith("/api/")
    || pathname === "/api/health"
    || pathname === "/api/auth/login"
    || pathname === "/api/auth/session") return;
  if (!originAllowed(request)) return reply.code(403).send({ error: "请求来源不受信任" });
  if (requestHasValidAdminToken(request) || authenticatedSession(request, true)) return;
  return reply.code(401).send({ error: "登录状态已失效" });
});

function enrollmentStatus(record: { expiresAt: string; usedAt: string | null; revokedAt: string | null }): "pending" | "used" | "revoked" | "expired" {
  if (record.usedAt) return "used";
  if (record.revokedAt) return "revoked";
  return Date.parse(record.expiresAt) <= Date.now() ? "expired" : "pending";
}

function publicEnrollment(record: EnrollmentTokenRecord) {
  let token: string | null = null;
  if (record.tokenCiphertext) {
    try {
      token = decryptEnrollmentToken(record.tokenCiphertext, enrollmentDisplayKey);
    } catch {
      app.log.warn({ enrollmentTokenId: record.id }, "Unable to decrypt enrollment token display value");
    }
  }
  return {
    id: record.id,
    status: enrollmentStatus(record),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    usedAt: record.usedAt,
    nodeId: record.nodeId,
    token,
  };
}

function commandEnvelope(command: CommandRecord): ControlCommandMessage {
  return {
    type: "control.command",
    commandId: command.id,
    command: command.command,
    createdAt: command.createdAt,
  };
}

function dispatch(command: CommandRecord): boolean {
  if (command.command.type === "run.start" || command.command.type === "conversation.start") {
    const run = database.getRun(command.command.runId);
    if (!run || ["completed", "failed", "interrupted"].includes(run.status)) {
      database.updateCommand(command.id, "failed", "Run is no longer dispatchable", now());
      return false;
    }
    if (run.status === "queued" && !database.canDispatchQueuedRun(command.nodeId, command.command.conversationId)) {
      return false;
    }
  }
  if (command.command.type === "conversation.compact") {
    const conversation = database.getConversation(command.command.conversationId);
    if (!conversation?.compaction || conversation.compaction.id !== command.command.compactionId
      || ["completed", "failed"].includes(conversation.compaction.status)) {
      database.updateCommand(command.id, "failed", "Compaction is no longer dispatchable", now());
      return false;
    }
  }
  const sent = connections.sendCommand(command.nodeId, commandEnvelope(command));
  if (sent && (command.command.type === "run.start" || command.command.type === "conversation.start")) {
    database.markRunDispatching(command.command.runId);
  }
  if (sent && command.command.type === "conversation.compact") {
    database.markConversationCompactionDispatching(command.command.conversationId, command.command.compactionId);
  }
  return sent;
}

function dispatchPending(nodeId: string, includeAccepted = false): void {
  for (const command of database.listPendingCommands(nodeId, includeAccepted)) dispatch(command);
}

function syncNodeWorkspaces(nodeId: string): boolean {
  return connections.syncWorkspaces(nodeId, database.listManagedWorkspacesForAgent(nodeId));
}

async function validatePathOnNode(nodeId: string, workspacePath: string): Promise<
  { canonicalPath: string; suggestedName: string } | { statusCode: 400 | 404 | 409; error: string }
> {
  const node = database.listNodes().find((candidate) => candidate.id === nodeId);
  if (!node) return { statusCode: 404, error: "节点不存在" };
  if (node.status !== "online" || !connections.has(nodeId)) return { statusCode: 409, error: "节点当前离线，无法验证路径" };
  try {
    const result = await connections.validateWorkspace(nodeId, workspacePath);
    if (!result.valid || !result.canonicalPath) {
      return { statusCode: 400, error: result.error || "工作空间路径无效" };
    }
    return {
      canonicalPath: result.canonicalPath,
      suggestedName: (result.suggestedName?.trim() || result.canonicalPath).slice(0, 64),
    };
  } catch (error) {
    return { statusCode: 409, error: error instanceof Error ? error.message : String(error) };
  }
}

async function validateWorkspaceForUse(nodeId: string, workspaceId: string): Promise<
  { workspace: WorkspaceRecord } | { statusCode: 404 | 409; error: string }
> {
  const workspace = database.getWorkspace(nodeId, workspaceId);
  if (!workspace) return { statusCode: 404, error: "工作空间不存在" };
  if (workspace.archivedAt || workspace.status === "archived") return { statusCode: 409, error: "工作空间已停用" };
  const node = database.listNodes().find((candidate) => candidate.id === nodeId);
  if (!node || node.status !== "online" || !connections.has(nodeId)) {
    return { statusCode: 409, error: "节点当前离线，无法验证工作空间" };
  }
  try {
    const result = await connections.validateWorkspace(nodeId, workspace.path);
    if (!result.valid || !result.canonicalPath) {
      const error = result.error || "工作空间验证失败";
      database.updateWorkspaceValidation(nodeId, workspaceId, false, error, now());
      publish("workspace.updated", workspaceId);
      return { statusCode: 409, error };
    }
    if (result.canonicalPath !== workspace.path) {
      const error = "工作空间实际路径已经变化，请在工作空间管理中迁移路径";
      database.updateWorkspaceValidation(nodeId, workspaceId, false, error, now());
      publish("workspace.updated", workspaceId);
      return { statusCode: 409, error };
    }
    const validated = database.updateWorkspaceValidation(nodeId, workspaceId, true, null, now()) ?? workspace;
    return { workspace: validated };
  } catch (error) {
    return { statusCode: 409, error: error instanceof Error ? error.message : String(error) };
  }
}

function publish(type: string, resourceId?: string, conversationId?: string): void {
  const event = database.createUiEvent(type, resourceId ?? null, now(), conversationId ?? null);
  events.publish(event);
}

const pendingMessageUiEvents = new Map<string, { messageId: string; timer: NodeJS.Timeout }>();

function publishMessageUpdate(messageId: string, conversationId: string, complete: boolean): void {
  const pending = pendingMessageUiEvents.get(conversationId);
  if (complete) {
    if (pending) clearTimeout(pending.timer);
    pendingMessageUiEvents.delete(conversationId);
    publish("message.updated", messageId, conversationId);
    return;
  }
  if (pending) {
    pending.messageId = messageId;
    return;
  }
  const timer = setTimeout(() => {
    const latest = pendingMessageUiEvents.get(conversationId);
    if (!latest || latest.timer !== timer) return;
    pendingMessageUiEvents.delete(conversationId);
    publish("message.updated", latest.messageId, conversationId);
  }, 500);
  pendingMessageUiEvents.set(conversationId, { messageId, timer });
}

interface UiPresence {
  conversationId: string | null;
  visible: boolean;
  seenAt: number;
}

const uiPresence = new Map<string, UiPresence>();

function conversationIsVisible(conversationId: string): boolean {
  const cutoff = Date.now() - 60_000;
  return [...uiPresence.values()].some((entry) => entry.visible && entry.conversationId === conversationId && entry.seenAt >= cutoff);
}

function notifyRun(runId: string, kind: "completed" | "failed" | "waiting_user", title: string, occurredAt: string): void {
  const run = database.getRun(runId);
  if (!run || conversationIsVisible(run.conversationId)) return;
  const conversation = database.getConversation(run.conversationId);
  if (!conversation) return;
  database.createNotification({
    nodeId: conversation.nodeId,
    conversationId: conversation.id,
    runId,
    kind,
    title,
    createdAt: occurredAt,
  });
  publish("notification.created", runId, conversation.id);
}

function normalizedAttachmentName(value: string): string {
  return path.basename(value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180) || "附件";
}

function prepareAttachments(ids: unknown, messageClientId: string): { ids: string[]; descriptors: AttachmentDescriptor[]; error?: string } {
  if (ids === undefined || ids === null) return { ids: [], descriptors: [] };
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id.trim())) {
    return { ids: [], descriptors: [], error: "附件 ID 必须是有效的数组" };
  }
  const uniqueIds = [...new Set(ids.map((id) => id.trim()))];
  if (uniqueIds.length > 10) return { ids: [], descriptors: [], error: "单条消息最多包含 10 个附件" };
  const records = database.listAttachments(uniqueIds);
  if (records.length !== uniqueIds.length) return { ids: [], descriptors: [], error: "一个或多个附件不存在或已被删除" };
  if (records.some((record) => record.status !== "ready" || !record.sha256)) {
    return { ids: [], descriptors: [], error: "所有附件上传完成后才能发送" };
  }
  if (records.some((record) => record.messageClientId !== messageClientId)) {
    return { ids: [], descriptors: [], error: "附件属于另一条消息，不能重复使用" };
  }
  return {
    ids: uniqueIds,
    descriptors: records.map((record) => ({
      id: record.id,
      name: record.name,
      mediaType: record.mediaType,
      size: record.size,
      sha256: record.sha256!,
      downloadToken: record.downloadToken,
    })),
  };
}

function selectedModel(nodeId: string, requested?: string): string | null {
  const explicit = requested?.trim();
  if (explicit) return explicit;
  const preferred = database.getGlobalSettings().defaultModel;
  if (!preferred) return null;
  const node = database.listNodes().find((candidate) => candidate.id === nodeId);
  return node?.models.some((model) => model.id === preferred) ? preferred : null;
}

function selectedEffort(nodeId: string, modelId: string | null, requested?: ReasoningEffort | null): ReasoningEffort | null {
  const candidate = requested ?? database.getGlobalSettings().defaultEffort as ReasoningEffort | null;
  const node = database.listNodes().find((entry) => entry.id === nodeId);
  const model = node?.models.find((entry) => entry.id === modelId) ?? node?.models.find((entry) => entry.isDefault);
  if (!candidate) return model?.defaultReasoningEffort ?? null;
  if (!model || model.supportedReasoningEfforts.length === 0 || model.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === candidate)) return candidate;
  return model.defaultReasoningEffort ?? null;
}

function processDurableMessage(nodeId: string, message: AgentDurableMessage): void {
  if (database.deliveryExists(nodeId, message.bootId, message.sequence)) {
    connections.send(nodeId, { type: "control.deliveryAck", bootId: message.bootId, sequence: message.sequence });
    return;
  }

  const receivedAt = now();
  const payload = message.payload;
  let shouldDispatchPending = false;
  database.transaction(() => {
    switch (payload.type) {
    case "conversation.bound":
      database.bindConversation(payload.conversationId, payload.threadId, receivedAt);
      publish("conversation.updated", payload.conversationId, payload.conversationId);
      break;
    case "run.started":
      database.startRun(payload);
      publish("run.updated", payload.runId, payload.conversationId);
      break;
    case "run.progress":
      database.updateRunProgress(payload);
      publish("run.updated", payload.runId, payload.conversationId);
      break;
    case "message.snapshot":
      if (database.upsertMessageSnapshot(payload)) publishMessageUpdate(payload.messageId, payload.conversationId, payload.complete);
      break;
    case "conversation.tokenUsage":
      if (database.updateConversationTokenUsage(nodeId, payload)) {
        publish("usage.updated", payload.conversationId, payload.conversationId);
      }
      break;
    case "conversation.compaction":
      if (database.updateConversationCompaction(nodeId, payload)) {
        publish("conversation.compaction", payload.compactionId, payload.conversationId);
      }
      shouldDispatchPending = payload.status !== "running";
      break;
    case "run.finished":
      database.finishRun(payload);
      if (payload.status === "completed") notifyRun(payload.runId, "completed", "任务已完成", payload.finishedAt);
      if (payload.status === "failed") notifyRun(payload.runId, "failed", payload.error ?? "任务执行失败", payload.finishedAt);
      publish("run.updated", payload.runId, payload.conversationId);
      shouldDispatchPending = true;
      break;
    case "interaction.requested":
      database.insertApproval(nodeId, payload);
      if (payload.runId) notifyRun(payload.runId, "waiting_user", payload.summary, payload.requestedAt);
      publish("approval.created", payload.approvalId, payload.conversationId);
      break;
    case "interaction.resolved": {
      const approval = database.getApproval(payload.approvalId);
      database.resolveApproval(payload.approvalId, payload.response, payload.resolvedAt);
      publish("approval.updated", payload.approvalId, approval?.conversationId);
      break;
    }
    case "agent.stateReport":
      for (const failedRunId of database.reconcileNodeRuns(nodeId, payload.activeRuns.map((run) => run.runId), payload.reportedAt)) {
        notifyRun(failedRunId, "failed", "节点重启后无法确认原任务状态", payload.reportedAt);
        publish("run.updated", failedRunId, database.getRun(failedRunId)?.conversationId);
      }
      for (const conversationId of database.reconcileNodeCompactions(
        nodeId,
        (payload.activeCompactions ?? []).map((compaction) => compaction.compactionId),
        payload.reportedAt,
      )) {
        publish("conversation.compaction", database.getConversation(conversationId)?.compaction?.id, conversationId);
      }
      shouldDispatchPending = true;
      break;
    case "agent.error":
      database.applyAgentError(payload, receivedAt);
      if (payload.runId) notifyRun(payload.runId, "failed", payload.message, receivedAt);
      publish("agent.error", payload.runId ?? payload.conversationId, payload.conversationId);
      if (payload.compactionId && payload.conversationId) {
        publish("conversation.compaction", payload.compactionId, payload.conversationId);
      }
      shouldDispatchPending = true;
      break;
    }
    database.recordDelivery(nodeId, message.bootId, message.sequence, receivedAt);
  });
  connections.send(nodeId, { type: "control.deliveryAck", bootId: message.bootId, sequence: message.sequence });
  if (shouldDispatchPending) dispatchPending(nodeId);
}

app.get("/readyz", async () => ({ ready: true }));
app.get("/api/health", async () => ({ status: "ok", protocolVersion: CONTROL_PROTOCOL_VERSION }));

app.get("/api/auth/session", async (request) => {
  const session = authenticatedSession(request, true);
  return session ? { authenticated: true, expiresAt: session.expiresAt } : { authenticated: false };
});

app.post<{ Body: { token?: string } }>("/api/auth/login", async (request, reply) => {
  if (!originAllowed(request)) return reply.code(403).send({ error: "请求来源不受信任" });
  const remote = request.ip;
  const timestamp = Date.now();
  const attempt = loginAttempts.get(remote);
  if (attempt && attempt.resetAt > timestamp && attempt.count >= 8) {
    return reply.header("Retry-After", String(Math.ceil((attempt.resetAt - timestamp) / 1000))).code(429).send({ error: "尝试次数过多，请稍后再试" });
  }
  const token = typeof request.body?.token === "string" ? request.body.token.trim() : "";
  const expectedHash = database.getAdminTokenHash();
  if (!token || token.length > 256 || !expectedHash || !secretMatches(token, expectedHash)) {
    const current = attempt && attempt.resetAt > timestamp ? attempt : { count: 0, resetAt: timestamp + 10 * 60 * 1000 };
    current.count += 1;
    loginAttempts.set(remote, current);
    return reply.code(401).send({ error: "管理员 Token 无效" });
  }
  loginAttempts.delete(remote);
  const createdAt = new Date(timestamp).toISOString();
  const expiresAt = new Date(timestamp + ADMIN_SESSION_LIFETIME_MS).toISOString();
  const session = createOpaqueToken("ccs");
  database.createAdminSession({
    id: session.id,
    tokenHash: session.tokenHash,
    createdAt,
    lastSeenAt: createdAt,
    expiresAt,
    revokedAt: null,
  });
  reply.header("Set-Cookie", sessionCookie(session.token));
  return { authenticated: true, expiresAt };
});

app.post("/api/auth/logout", async (request, reply) => {
  const session = authenticatedSession(request);
  if (session) database.revokeAdminSession(session.id, now());
  reply.header("Set-Cookie", sessionCookie("", 0));
  return reply.code(204).send();
});

app.get("/api/agent-package", async (_request, reply) => {
  reply.header("Cache-Control", "no-store");
  const descriptor = findAgentPackage(config.agentArtifactDirectory, agentPackageVersion);
  return {
    package: descriptor ? {
      available: true,
      version: descriptor.version,
      fileName: descriptor.fileName,
      size: descriptor.size,
      sha256: descriptor.sha256,
      builtAt: descriptor.builtAt,
    } : {
      available: false,
      version: agentPackageVersion,
      fileName: null,
      size: null,
      sha256: null,
      builtAt: null,
    },
  };
});

app.get("/api/agent-package/download", async (_request, reply) => {
  const descriptor = findAgentPackage(config.agentArtifactDirectory, agentPackageVersion);
  if (!descriptor) return reply.code(404).send({ error: `Agent v${agentPackageVersion} 客户端安装包尚未生成` });
  reply.header("Cache-Control", "private, no-cache");
  reply.header("Content-Type", "application/gzip");
  reply.header("Content-Length", String(descriptor.size));
  reply.header("Content-Disposition", `attachment; filename="${descriptor.fileName}"`);
  reply.header("X-Content-Type-Options", "nosniff");
  return reply.send(createReadStream(descriptor.filePath));
});

app.get("/api/enrollment-tokens", async (_request, reply) => {
  reply.header("Cache-Control", "no-store");
  database.cleanupEnrollmentTokens(now());
  return {
    data: database.listEnrollmentTokens().map(publicEnrollment),
    lifetimeSeconds: Math.floor(ENROLLMENT_TOKEN_LIFETIME_MS / 1000),
  };
});

app.post("/api/enrollment-tokens", async (_request, reply) => {
  reply.header("Cache-Control", "no-store");
  const created = createOpaqueToken("cce");
  const createdAt = now();
  const record = {
    id: created.id,
    tokenHash: created.tokenHash,
    tokenCiphertext: encryptEnrollmentToken(created.token, enrollmentDisplayKey),
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + ENROLLMENT_TOKEN_LIFETIME_MS).toISOString(),
    usedAt: null,
    revokedAt: null,
    nodeId: null,
    credentialId: null,
  };
  database.createEnrollmentToken(record);
  return reply.code(201).send({ enrollment: publicEnrollment(record), token: created.token });
});

app.get<{ Params: { id: string } }>("/api/enrollment-tokens/:id", async (request, reply) => {
  reply.header("Cache-Control", "no-store");
  database.cleanupEnrollmentTokens(now());
  const record = database.getEnrollmentToken(request.params.id);
  return record ? { enrollment: publicEnrollment(record) } : reply.code(404).send({ error: "注册 Token 不存在" });
});

app.delete<{ Params: { id: string } }>("/api/enrollment-tokens/:id", async (request, reply) => {
  if (!database.revokeEnrollmentToken(request.params.id, now())) {
    const existing = database.getEnrollmentToken(request.params.id);
    if (!existing) return reply.code(404).send({ error: "注册 Token 不存在" });
    return reply.code(409).send({ error: "注册 Token 已使用、已撤销或已过期" });
  }
  return reply.code(204).send();
});

app.post<{ Body: { nodeId?: string; credential?: string } }>("/agent/enroll", async (request, reply) => {
  const enrollment = parseOpaqueToken(bearerToken(request), "cce");
  const credentialValue = typeof request.body?.credential === "string" ? request.body.credential.trim() : "";
  const credential = parseOpaqueToken(credentialValue, "ccn");
  const nodeId = typeof request.body?.nodeId === "string" ? request.body.nodeId.trim() : "";
  if (!enrollment || !credential || !/^[0-9a-f-]{36}$/i.test(nodeId)) {
    return reply.code(400).send({ error: "注册参数无效" });
  }
  const record = database.getEnrollmentToken(enrollment.id);
  if (!record || !secretMatches(enrollment.token, record.tokenHash)) {
    return reply.code(401).send({ error: "注册 Token 无效" });
  }
  const enrolled = database.consumeEnrollmentToken({
    id: enrollment.id,
    nodeId,
    credentialId: credential.id,
    credentialHash: hashSecret(credential.token),
    usedAt: now(),
  });
  if (!enrolled) return reply.code(409).send({ error: "注册 Token 已使用、已撤销或已过期" });
  publish("enrollment.used", enrollment.id);
  return reply.code(201).send({ nodeId });
});

app.get("/agent/connect", { websocket: true }, (socket: WebSocket, request) => {
  const suppliedToken = bearerToken(request);
  const parsedCredential = parseOpaqueToken(suppliedToken, "ccn");
  const credential = parsedCredential ? database.getNodeCredential(parsedCredential.id) : null;
  const credentialNodeId = credential && !credential.revokedAt && secretMatches(suppliedToken, credential.tokenHash)
    ? credential.nodeId
    : null;
  const legacyAuthenticated = safeTokenEqual(suppliedToken, config.agentToken);
  if (!legacyAuthenticated && !credentialNodeId) {
    socket.close(4401, "Invalid agent token");
    return;
  }

  let nodeId: string | null = null;
  let initialized = false;

  socket.on("message", (data) => {
    try {
      const message = parseAgentMessage(data.toString());
      if (!initialized) {
        if (message.type !== "agent.hello") throw new Error("agent.hello must be the first message");
        if (legacyAuthenticated && database.nodeHasCredentials(message.node.id)) {
          socket.close(4403, "This node must use its enrolled credential");
          return;
        }
        if (credentialNodeId && message.node.id !== credentialNodeId) {
          socket.close(4403, "Credential does not belong to this node");
          return;
        }
        if (message.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
          socket.send(JSON.stringify({
            type: "control.error",
            code: "protocol_version_mismatch",
            message: `Expected protocol ${CONTROL_PROTOCOL_VERSION}`,
          }));
          socket.close(4400, "Protocol mismatch");
          return;
        }
        const restarted = database.upsertNode(message.node, message.bootId, now());
        if (parsedCredential) database.touchNodeCredential(parsedCredential.id, now());
        nodeId = message.node.id;
        const capabilities = Array.isArray(message.node.capabilities)
          ? message.node.capabilities.filter((capability): capability is string => typeof capability === "string")
          : [];
        connections.set(nodeId, message.bootId, socket, capabilities);
        connections.send(nodeId, {
          type: "control.welcome",
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          nodeId,
          connectedAt: now(),
          heartbeatIntervalMs: config.heartbeatIntervalMs,
          tokenUsageBackfill: database.listTokenUsageBackfill(nodeId),
        });
        syncNodeWorkspaces(nodeId);
        initialized = true;
        publish("node.online", nodeId);
        if (restarted) publish("node.restarted", nodeId);
        // A reconnect is the only time an accepted command needs to be replayed.
        // The Agent persists command ids and will acknowledge without executing it twice.
        dispatchPending(nodeId, true);
        return;
      }

      if (!nodeId) throw new Error("Missing node identity");
      if (message.type === "agent.heartbeat") {
        database.updateHeartbeat(nodeId, message.activeRuns, now());
      } else if (message.type === "agent.commandAck") {
        const command = database.getCommand(message.commandId);
        if (!command || command.nodeId !== nodeId) {
          app.log.warn({ nodeId, commandId: message.commandId }, "Ignored command acknowledgement from the wrong node");
        } else {
          database.updateCommand(message.commandId, message.status, message.error ?? null, now());
          publish("command.updated", message.commandId);
        }
      } else if (message.type === "agent.workspaceValidation") {
        if (!connections.resolveWorkspaceValidation(nodeId, message)) {
          app.log.warn({ nodeId, requestId: message.requestId }, "Received an unknown workspace validation response");
        }
      } else if (message.type === "agent.workspaceFile") {
        if (!connections.resolveWorkspaceFileRead(nodeId, message)) {
          app.log.warn({ nodeId, requestId: message.requestId }, "Received an unknown workspace file response");
        }
      } else if (message.type === "agent.message") {
        processDurableMessage(nodeId, message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      app.log.warn({ nodeId, error: message }, "Rejected agent message");
      socket.send(JSON.stringify({ type: "control.error", code: "invalid_message", message }));
      if (!initialized) socket.close(4400, "Invalid handshake");
    }
  });

  socket.on("close", () => {
    if (nodeId && connections.remove(nodeId, socket)) {
      database.markNodeOffline(nodeId, now());
      publish("node.offline", nodeId);
    }
  });
});

app.get("/api/nodes", async () => ({ data: database.listNodes() }));

app.patch<{ Params: { id: string }; Body: { name?: string | null } }>("/api/nodes/:id", async (request, reply) => {
  if (!("name" in (request.body ?? {}))) return reply.code(400).send({ error: "节点名称不能为空" });
  const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
  if (name.length > 64) return reply.code(400).send({ error: "节点名称不能超过 64 个字符" });
  if (!database.updateNodeName(request.params.id, name || null, now())) {
    return reply.code(404).send({ error: "节点不存在或已被删除" });
  }
  publish("node.updated", request.params.id);
  const node = database.listNodes().find((candidate) => candidate.id === request.params.id);
  return { node };
});

app.post<{ Params: { id: string } }>("/api/nodes/:id/access/revoke", async (request, reply) => {
  if (!database.listNodes().some((node) => node.id === request.params.id)) {
    return reply.code(404).send({ error: "节点不存在" });
  }
  const revoked = database.revokeNodeCredentials(request.params.id, now());
  if (revoked === 0) return reply.code(409).send({ error: "该节点没有可撤销的独立凭证" });
  connections.close(request.params.id);
  database.markNodeOffline(request.params.id, now());
  publish("node.access-revoked", request.params.id);
  return { revoked };
});

app.get<{ Params: { id: string }; Querystring: { includeArchived?: string } }>("/api/nodes/:id/workspaces", async (request, reply) => {
  if (!database.listNodes().some((node) => node.id === request.params.id)) {
    return reply.code(404).send({ error: "节点不存在" });
  }
  return { data: database.listWorkspaces(request.params.id, request.query.includeArchived === "true") };
});

app.post<{ Params: { id: string }; Body: { name?: string; path?: string } }>("/api/nodes/:id/workspaces", async (request, reply) => {
  const requestedPath = request.body?.path?.trim() ?? "";
  const requestedName = request.body?.name?.trim() ?? "";
  if (!requestedPath) return reply.code(400).send({ error: "工作空间路径不能为空" });
  if (requestedPath.length > 4096) return reply.code(400).send({ error: "工作空间路径过长" });
  if (requestedName.length > 64) return reply.code(400).send({ error: "工作空间名称不能超过 64 个字符" });
  const validation = await validatePathOnNode(request.params.id, requestedPath);
  if ("error" in validation) return reply.code(validation.statusCode).send({ error: validation.error });
  const duplicate = database.findWorkspaceByPath(request.params.id, validation.canonicalPath);
  if (duplicate) return reply.code(409).send({ error: `该路径已经登记为“${duplicate.name}”`, workspace: duplicate });
  const createdAt = now();
  const workspace = database.createWebWorkspace({
    id: randomUUID(),
    nodeId: request.params.id,
    name: requestedName || validation.suggestedName,
    path: validation.canonicalPath,
    now: createdAt,
  });
  syncNodeWorkspaces(request.params.id);
  publish("workspace.created", workspace.id);
  return reply.code(201).send({ workspace });
});

app.patch<{
  Params: { nodeId: string; workspaceId: string };
  Body: { name?: string; path?: string; archived?: boolean; confirmMigration?: boolean };
}>("/api/nodes/:nodeId/workspaces/:workspaceId", async (request, reply) => {
  const current = database.getWorkspace(request.params.nodeId, request.params.workspaceId);
  if (!current) return reply.code(404).send({ error: "工作空间不存在" });
  if (current.isDefault) return reply.code(409).send({ error: "默认工作空间由 Agent 启动目录决定，不能修改" });
  if (current.source === "config") return reply.code(409).send({ error: "启动配置工作空间只能通过 Agent 配置修改" });
  const hasName = typeof request.body?.name === "string";
  const hasPath = typeof request.body?.path === "string";
  const hasArchived = typeof request.body?.archived === "boolean";
  if (!hasName && !hasPath && !hasArchived) return reply.code(400).send({ error: "没有需要修改的内容" });
  const name = hasName ? request.body.name!.trim() : undefined;
  if (hasName && (!name || name.length > 64)) return reply.code(400).send({ error: "工作空间名称必须为 1 到 64 个字符" });

  let canonicalPath: string | undefined;
  if (hasPath && request.body.path!.trim() !== current.path) {
    if (request.body.confirmMigration !== true) {
      return reply.code(409).send({
        error: current.conversationCount > 0
          ? `该工作空间已绑定 ${current.conversationCount} 个会话，迁移路径需要明确确认`
          : "迁移工作空间路径需要明确确认",
        requiresConfirmation: true,
        conversationCount: current.conversationCount,
      });
    }
    const validation = await validatePathOnNode(request.params.nodeId, request.body.path!.trim());
    if ("error" in validation) return reply.code(validation.statusCode).send({ error: validation.error });
    const duplicate = database.findWorkspaceByPath(request.params.nodeId, validation.canonicalPath, current.id);
    if (duplicate) return reply.code(409).send({ error: `该路径已经登记为“${duplicate.name}”` });
    canonicalPath = validation.canonicalPath;
  }
  if (request.body.archived === false && current.archivedAt) {
    const validation = await validatePathOnNode(request.params.nodeId, canonicalPath ?? current.path);
    if ("error" in validation) return reply.code(validation.statusCode).send({ error: validation.error });
    canonicalPath = validation.canonicalPath;
  }
  const workspace = database.updateWorkspace({
    nodeId: request.params.nodeId,
    id: request.params.workspaceId,
    ...(name ? { name } : {}),
    ...(canonicalPath ? { path: canonicalPath } : {}),
    ...(hasArchived ? { archived: request.body.archived } : {}),
    now: now(),
  });
  syncNodeWorkspaces(request.params.nodeId);
  publish("workspace.updated", request.params.workspaceId);
  return { workspace };
});

app.post<{ Params: { nodeId: string; workspaceId: string } }>("/api/nodes/:nodeId/workspaces/:workspaceId/validate", async (request, reply) => {
  const current = database.getWorkspace(request.params.nodeId, request.params.workspaceId);
  if (!current) return reply.code(404).send({ error: "工作空间不存在" });
  if (current.archivedAt) return reply.code(409).send({ error: "工作空间已停用" });
  const validation = await validatePathOnNode(request.params.nodeId, current.path);
  if ("error" in validation) {
    const workspace = database.updateWorkspaceValidation(request.params.nodeId, request.params.workspaceId, false, validation.error, now());
    publish("workspace.updated", request.params.workspaceId);
    return reply.code(validation.statusCode).send({ error: validation.error, workspace });
  }
  if (validation.canonicalPath !== current.path) {
    const error = "工作空间实际路径已经变化，请使用迁移路径功能";
    const workspace = database.updateWorkspaceValidation(request.params.nodeId, request.params.workspaceId, false, error, now());
    publish("workspace.updated", request.params.workspaceId);
    return reply.code(409).send({ error, workspace });
  }
  const workspace = database.updateWorkspaceValidation(request.params.nodeId, request.params.workspaceId, true, null, now());
  publish("workspace.updated", request.params.workspaceId);
  return { workspace };
});

app.delete<{ Params: { nodeId: string; workspaceId: string } }>("/api/nodes/:nodeId/workspaces/:workspaceId", async (request, reply) => {
  const current = database.getWorkspace(request.params.nodeId, request.params.workspaceId);
  if (!current) return reply.code(404).send({ error: "工作空间不存在" });
  if (current.isDefault) return reply.code(409).send({ error: "默认工作空间不能删除" });
  if (current.source === "config") return reply.code(409).send({ error: "启动配置工作空间只能通过 Agent 配置删除" });
  if (current.conversationCount > 0) {
    return reply.code(409).send({ error: "该工作空间已绑定会话，只能停用，不能删除" });
  }
  if (!database.deleteUnusedWorkspace(request.params.nodeId, request.params.workspaceId)) {
    return reply.code(409).send({ error: "工作空间当前不能删除" });
  }
  syncNodeWorkspaces(request.params.nodeId);
  publish("workspace.deleted", request.params.workspaceId);
  return reply.code(204).send();
});

app.get<{ Querystring: { nodeId?: string; q?: string; status?: string; limit?: string; cursor?: string; includeTotal?: string } }>("/api/conversations", async (request, reply) => {
  const query = request.query.q?.trim() ?? "";
  if (query.length > 100) return reply.code(400).send({ error: "搜索内容不能超过 100 个字符" });
  const requestedLimit = Number.parseInt(request.query.limit ?? "50", 10);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    return reply.code(400).send({ error: "每页数量必须在 1 到 100 之间" });
  }
  const cursor = decodeConversationCursor(request.query.cursor);
  if (request.query.cursor && !cursor) return reply.code(400).send({ error: "会话分页位置无效，请重新加载列表" });
  if (request.query.status && !["active", "failed"].includes(request.query.status)) {
    return reply.code(400).send({ error: "会话状态筛选值只能是 active 或 failed" });
  }
  if (request.query.includeTotal && !["true", "false"].includes(request.query.includeTotal)) {
    return reply.code(400).send({ error: "includeTotal 参数必须是 true 或 false" });
  }
  const page = database.listConversationPage({
    ...(request.query.nodeId?.trim() ? { nodeId: request.query.nodeId.trim() } : {}),
    ...(query ? { query } : {}),
    ...(request.query.status ? { runStatus: request.query.status as "active" | "failed" } : {}),
    limit: requestedLimit,
    includeTotal: request.query.includeTotal !== "false",
    ...(cursor ? { cursor } : {}),
  });
  return { data: page.data, total: page.total, nextCursor: encodeConversationCursor(page.nextCursor) };
});

app.patch<{ Params: { id: string }; Body: { title?: string; pinned?: boolean } }>("/api/conversations/:id", async (request, reply) => {
  const input: { title?: string; pinned?: boolean } = {};
  if (typeof request.body?.title === "string") {
    const title = request.body.title.trim();
    if (!title || title.length > 80) return reply.code(400).send({ error: "会话标题必须为 1 到 80 个字符" });
    input.title = title;
  }
  if (typeof request.body?.pinned === "boolean") input.pinned = request.body.pinned;
  if (Object.keys(input).length === 0) return reply.code(400).send({ error: "请提供会话标题或置顶状态" });
  const conversation = database.updateConversation(request.params.id, input, now());
  if (!conversation) return reply.code(404).send({ error: "会话不存在或已被删除" });
  publish("conversation.updated", conversation.id, conversation.id);
  return { conversation };
});

app.get<{
  Params: { id: string };
  Querystring: { messageLimit?: string; beforeMessage?: string };
}>("/api/conversations/:id", async (request, reply) => {
  const conversation = database.getConversation(request.params.id);
  if (!conversation) return reply.code(404).send({ error: "会话不存在或已被删除" });
  const messageLimit = Number.parseInt(request.query.messageLimit ?? "60", 10);
  if (!Number.isSafeInteger(messageLimit) || messageLimit < 1 || messageLimit > 100) {
    return reply.code(400).send({ error: "每页消息数量必须在 1 到 100 之间" });
  }
  const beforeMessage = decodeMessageCursor(request.query.beforeMessage);
  if (request.query.beforeMessage && !beforeMessage) {
    return reply.code(400).send({ error: "消息分页位置无效，请重新打开会话" });
  }
  const messagePage = database.listMessagePage(conversation.id, messageLimit, beforeMessage ?? undefined);
  const attachmentIds = [...new Set(messagePage.data.flatMap((message) => message.attachmentIds))];
  return {
    conversation,
    runs: database.listRecentRuns(conversation.id),
    messages: messagePage.data,
    messagePage: {
      hasMore: messagePage.nextCursor !== null,
      before: encodeMessageCursor(messagePage.nextCursor),
    },
    attachments: database.listAttachments(attachmentIds).map(({ downloadToken: _downloadToken, storageKey: _storageKey, ...attachment }) => attachment),
    approvals: database.listApprovals("pending", conversation.id),
  };
});

app.get<{ Params: { id: string } }>("/api/conversations/:id/workspace-file-history", async (request, reply) => {
  const conversation = database.getConversation(request.params.id);
  if (!conversation) return reply.code(404).send({ error: "会话不存在或已被删除", code: "conversation_not_found" });
  return { data: database.listConversationOpenedFiles(conversation.id) };
});

app.delete<{ Params: { id: string; fileId: string } }>("/api/conversations/:id/workspace-file-history/:fileId", async (request, reply) => {
  const conversation = database.getConversation(request.params.id);
  if (!conversation) return reply.code(404).send({ error: "会话不存在或已被删除", code: "conversation_not_found" });
  if (!database.deleteConversationOpenedFile(conversation.id, request.params.fileId)) {
    return reply.code(404).send({ error: "文件历史记录不存在或已被删除", code: "file_history_not_found" });
  }
  publish("workspace-file-history.deleted", request.params.fileId, conversation.id);
  return reply.code(204).send();
});

app.post<{
  Params: { id: string };
  Body: { path?: string; baseFileId?: string; recordHistory?: boolean };
}>("/api/conversations/:id/workspace-files", async (request, reply) => {
  const conversation = database.getConversation(request.params.id);
  if (!conversation) return reply.code(404).send({ error: "会话不存在或已被删除", code: "conversation_not_found" });
  const requestedPath = request.body?.path?.trim() ?? "";
  if (!requestedPath || requestedPath.length > 4096 || requestedPath.includes("\0")) {
    return reply.code(400).send({ error: "文件路径无效", code: "invalid_file_path" });
  }
  if (!connections.has(conversation.nodeId)) {
    return reply.code(409).send({ error: "该会话所属 Agent 当前离线", code: "agent_offline" });
  }
  if (!connections.hasCapability(conversation.nodeId, WORKSPACE_FILE_READ_CAPABILITY)) {
    return reply.code(409).send({ error: "该 Agent 版本尚不支持对话文件预览，请先升级并重启 Agent", code: "agent_upgrade_required" });
  }
  const recordHistory = request.body?.recordHistory !== false;
  if (!consumeWorkspaceFileRateLimit(`${conversation.id}:${recordHistory ? "open" : "embed"}`, recordHistory ? 20 : 80)) {
    return reply.code(429).send({ error: "文件打开过于频繁，请稍后再试", code: "workspace_file_rate_limited" });
  }

  pruneWorkspaceFileCache();
  let basePath: string | undefined;
  const baseFileId = request.body?.baseFileId?.trim();
  if (baseFileId) {
    const baseFile = workspaceFileCache.get(baseFileId);
    if (!baseFile || baseFile.expiresAt <= Date.now() || baseFile.conversationId !== conversation.id || baseFile.nodeId !== conversation.nodeId) {
      return reply.code(404).send({ error: "作为相对路径基准的文件已经失效，请重新打开", code: "base_file_expired" });
    }
    basePath = baseFile.path;
  }

  let result;
  try {
    result = await connections.readWorkspaceFile(
      conversation.nodeId,
      conversation.workspaceId,
      requestedPath,
      basePath,
      workspaceFileMaxBytes,
    );
  } catch (error) {
    return reply.code(409).send({
      error: error instanceof Error ? error.message : "Agent 读取文件失败",
      code: "agent_file_read_unavailable",
    });
  }
  if (!result.ok) {
    const statusCode = result.errorCode === "not_found" ? 404
      : result.errorCode === "forbidden" ? 403
        : result.errorCode === "too_large" ? 413
          : result.errorCode === "not_file" ? 422
            : 502;
    return reply.code(statusCode).send({ error: result.error || "Agent 读取文件失败", code: result.errorCode ?? "read_failed" });
  }
  if (!result.path || result.path.length > 4096
    || !result.name || result.name.length > 1024
    || !result.mediaType || result.mediaType.length > 128
    || !result.contentBase64
    || typeof result.size !== "number" || !Number.isSafeInteger(result.size) || result.size < 0
    || result.contentBase64.length > Math.ceil(workspaceFileMaxBytes / 3) * 4 + 8) {
    return reply.code(502).send({ error: "Agent 返回了无效的文件内容", code: "invalid_agent_file" });
  }
  const content = Buffer.from(result.contentBase64, "base64");
  if (content.byteLength !== result.size || content.byteLength > workspaceFileMaxBytes) {
    return reply.code(502).send({ error: "Agent 返回的文件大小不一致", code: "invalid_agent_file" });
  }
  const createdAt = Date.now();
  const file: WorkspaceFileCacheEntry = {
    id: randomUUID(),
    conversationId: conversation.id,
    nodeId: conversation.nodeId,
    path: result.path,
    name: result.name,
    mediaType: /^[\w.+-]+\/[\w.+-]+(?:;\s*charset=[\w-]+)?$/iu.test(result.mediaType)
      ? result.mediaType
      : "application/octet-stream",
    content,
    createdAt,
    expiresAt: createdAt + workspaceFileLifetimeMs,
  };
  workspaceFileCache.set(file.id, file);
  pruneWorkspaceFileCache();
  if (!recordHistory) return reply.code(201).send({ file: publicWorkspaceFile(file) });
  const history = database.upsertConversationOpenedFile({
    id: randomUUID(),
    conversationId: conversation.id,
    path: file.path,
    name: file.name,
    mediaType: file.mediaType,
    size: file.content.byteLength,
    openedAt: new Date(createdAt).toISOString(),
  });
  publish("workspace-file-history.updated", history.id, conversation.id);
  return reply.code(201).send({ file: publicWorkspaceFile(file), history });
});

app.get<{ Params: { id: string } }>("/api/workspace-files/:id", async (request, reply) => {
  pruneWorkspaceFileCache();
  const file = workspaceFileCache.get(request.params.id);
  if (!file || file.expiresAt <= Date.now()) return reply.code(404).send({ error: "文件预览已经失效，请从对话中重新打开" });
  return { file: publicWorkspaceFile(file) };
});

app.get<{ Params: { id: string } }>("/api/workspace-files/:id/content", async (request, reply) => {
  pruneWorkspaceFileCache();
  const file = workspaceFileCache.get(request.params.id);
  if (!file || file.expiresAt <= Date.now()) return reply.code(404).send({ error: "文件预览已经失效，请重新打开" });
  const encodedName = encodeURIComponent(file.name.replace(/[\uD800-\uDFFF]/gu, "�")).replace(/'/gu, "%27");
  return reply
    .header("Cache-Control", "private, no-store")
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Security-Policy", "sandbox; default-src 'none'")
    .header("Content-Disposition", `attachment; filename*=UTF-8''${encodedName}`)
    .type(file.mediaType)
    .send(file.content);
});

app.post<{
  Params: { id: string };
  Body: { clientRequestId?: string };
}>("/api/conversations/:id/compact", async (request, reply) => {
  const conversation = database.getConversation(request.params.id);
  if (!conversation) return reply.code(404).send({ error: "会话不存在或已被删除" });
  const clientRequestId = request.body?.clientRequestId?.trim() || randomUUID();
  if (clientRequestId.length > 128) {
    return reply.code(400).send({ error: "客户端请求 ID 不能超过 128 个字符" });
  }
  const commandId = `compact:${clientRequestId}`;
  const existing = database.getCommand(commandId);
  if (existing) {
    if (existing.command.type !== "conversation.compact" || existing.command.conversationId !== conversation.id) {
      return reply.code(409).send({ error: "该客户端请求 ID 已用于另一个操作" });
    }
    const compaction = database.getConversation(conversation.id)?.compaction;
    if (!compaction || compaction.id !== existing.command.compactionId) {
      return reply.code(409).send({ error: "该压缩请求已经失效，请重新发起" });
    }
    return reply.code(200).send({
      compaction,
      dispatched: ["accepted", "completed"].includes(existing.status) || compaction.status !== "queued",
      deduplicated: true,
    });
  }
  if (conversation.status !== "ready" || !conversation.remoteThreadId) {
    return reply.code(409).send({ error: "节点上的会话尚未就绪，暂时不能压缩上下文" });
  }
  if (database.hasActiveRun(conversation.id)) {
    return reply.code(409).send({ error: "当前会话仍有任务在运行，请等待完成或先中止任务" });
  }
  if (database.hasActiveConversationCompaction(conversation.id)) {
    return reply.code(409).send({ error: "当前会话已经在压缩上下文，请勿重复操作" });
  }
  const node = database.listNodes().find((candidate) => candidate.id === conversation.nodeId);
  if (!node || node.status !== "online" || !connections.has(conversation.nodeId)) {
    return reply.code(409).send({ error: "节点当前离线，暂时不能压缩上下文" });
  }
  const requestedAt = now();
  const compactionId = randomUUID();
  const command = database.transaction(() => {
    database.createConversationCompaction(conversation.id, compactionId, requestedAt);
    return database.createCommand(commandId, conversation.nodeId, {
      type: "conversation.compact",
      compactionId,
      conversationId: conversation.id,
      threadId: conversation.remoteThreadId!,
    }, requestedAt);
  });
  const dispatched = dispatch(command);
  publish("conversation.compaction", compactionId, conversation.id);
  return reply.code(202).send({
    compaction: database.getConversation(conversation.id)?.compaction,
    dispatched,
    deduplicated: false,
  });
});

app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
  const conversation = database.getConversation(request.params.id);
  if (!conversation) return reply.code(404).send({ error: "会话不存在或已被删除" });
  if (database.hasActiveRun(conversation.id)) return reply.code(409).send({ error: "请先中止当前任务，再删除会话" });
  if (database.hasActiveConversationCompaction(conversation.id)) {
    return reply.code(409).send({ error: "会话正在压缩上下文，请等待压缩完成后再删除" });
  }
  if (conversation.status === "creating" && !conversation.remoteThreadId) {
    return reply.code(409).send({ error: "会话仍在创建中，请稍后再试" });
  }
  if (conversation.remoteThreadId) {
    const command = database.createCommand(randomUUID(), conversation.nodeId, {
      type: "conversation.delete",
      conversationId: conversation.id,
      threadId: conversation.remoteThreadId,
    }, now());
    dispatch(command);
  }
  database.deleteConversation(conversation.id);
  publish("conversation.deleted", conversation.id, conversation.id);
  return reply.code(204).send();
});

app.post<{
  Body: { nodeId?: string; workspaceId?: string; title?: string; model?: string };
}>("/api/conversations", async (request, reply) => {
  const body = request.body ?? {};
  const { nodeId, workspaceId } = body;
  const title = body.title?.trim();
  if (!nodeId || !workspaceId || !title) {
    return reply.code(400).send({ error: "节点、工作空间和会话标题不能为空" });
  }
  const workspaceValidation = await validateWorkspaceForUse(nodeId, workspaceId);
  if ("error" in workspaceValidation) return reply.code(workspaceValidation.statusCode).send({ error: workspaceValidation.error });

  const createdAt = now();
  const conversationId = randomUUID();
  const model = selectedModel(nodeId, body.model);
  const command: ControlCommand = {
    type: "conversation.create",
    conversationId,
    workspaceId,
    title,
    ...(model ? { model } : {}),
  };
  const commandRecord = database.transaction(() => {
    database.createConversation({
      id: conversationId,
      nodeId,
      workspaceId,
      title,
      model,
      effort: null,
      clientRequestId: null,
      remoteThreadId: null,
      status: "creating",
      error: null,
      pinnedAt: null,
      latestRunStatus: null,
      tokenUsage: null,
      compaction: null,
      createdAt,
      updatedAt: createdAt,
    });
    return database.createCommand(randomUUID(), nodeId, command, createdAt);
  });
  const dispatched = dispatch(commandRecord);
  publish("conversation.created", conversationId, conversationId);
  return reply.code(201).send({ conversation: database.getConversation(conversationId), dispatched });
});

app.post<{
  Body: {
    nodeId?: string;
    workspaceId?: string;
    prompt?: string;
    model?: string;
    effort?: ReasoningEffort;
    clientRequestId?: string;
    attachmentIds?: string[];
    allowWorkspaceConcurrency?: boolean;
  };
}>("/api/conversations/start", async (request, reply) => {
  const body = request.body ?? {};
  const nodeId = body.nodeId?.trim();
  const workspaceId = body.workspaceId?.trim();
  const prompt = body.prompt?.trim();
  const clientRequestId = body.clientRequestId?.trim() || randomUUID();
  if (!nodeId || !workspaceId || !prompt) {
    return reply.code(400).send({ error: "节点、工作空间和任务内容不能为空" });
  }
  if (clientRequestId.length > 128) {
    return reply.code(400).send({ error: "客户端请求 ID 不能超过 128 个字符" });
  }
  if (body.effort && !reasoningEfforts.has(body.effort)) {
    return reply.code(400).send({ error: "所选思考强度不受支持" });
  }
  const existing = database.getConversationByClientRequestId(clientRequestId);
  if (existing) {
    const existingRun = database.listRuns(existing.id)[0] ?? null;
    if (existing.nodeId !== nodeId || existing.workspaceId !== workspaceId || existingRun?.prompt !== prompt) {
      return reply.code(409).send({ error: "该客户端请求 ID 已用于另一个会话" });
    }
    return reply.send({
      conversation: existing,
      run: existingRun,
      deduplicated: true,
    });
  }
  const preparedAttachments = prepareAttachments(body.attachmentIds, clientRequestId);
  if (preparedAttachments.error) return reply.code(400).send({ error: preparedAttachments.error });
  const workspaceValidation = await validateWorkspaceForUse(nodeId, workspaceId);
  if ("error" in workspaceValidation) return reply.code(workspaceValidation.statusCode).send({ error: workspaceValidation.error });
  if (body.allowWorkspaceConcurrency !== true && database.hasActiveRunInWorkspace(nodeId, workspaceId)) {
    return reply.code(409).send({
      code: "workspace_busy",
      error: `工作空间“${workspaceValidation.workspace.name}”已有正在运行或排队的任务`,
    });
  }
  const createdAt = now();
  const conversationId = randomUUID();
  const runId = randomUUID();
  const title = automaticConversationTitle(prompt);
  const model = selectedModel(nodeId, body.model);
  const effort = selectedEffort(nodeId, model, body.effort);
  const conversationRecord = {
    id: conversationId,
    nodeId,
    workspaceId,
    title,
    model,
    effort,
    clientRequestId,
    remoteThreadId: null,
    status: "creating",
    error: null,
    pinnedAt: null,
    latestRunStatus: "queued",
    tokenUsage: null,
    compaction: null,
    createdAt,
    updatedAt: createdAt,
  } as const;
  const runRecord = {
    id: runId,
    conversationId,
    prompt,
    model,
    effort,
    clientRequestId,
    remoteTurnId: null,
    status: "queued",
    progressPhase: null,
    progressLabel: "等待节点接收任务",
    progressUpdatedAt: createdAt,
    recoveryDeadlineAt: null,
    error: null,
    errorCode: null,
    createdAt,
    startedAt: null,
    finishedAt: null,
  } as const;
  const command: ControlCommand = {
    type: "conversation.start",
    conversationId,
    workspaceId,
    title,
    runId,
    prompt,
    ...(model ? { model } : {}),
    ...(effort ? { effort: effort as ReasoningEffort } : {}),
    ...(preparedAttachments.descriptors.length ? { attachments: preparedAttachments.descriptors } : {}),
  };
  database.transaction(() => {
    database.createConversation(conversationRecord);
    database.createRun(runRecord);
    database.insertUserMessage({
      id: `user:${clientRequestId}`,
      conversationId,
      runId,
      content: prompt,
      ...(preparedAttachments.ids.length ? { attachmentIds: preparedAttachments.ids } : {}),
      createdAt,
    });
    if (preparedAttachments.ids.length) database.bindAttachments(preparedAttachments.ids, conversationId);
    database.createCommand(`start:${clientRequestId}`, nodeId, command, createdAt);
  });
  dispatchPending(nodeId);
  const dispatched = database.getRun(runId)?.status === "dispatching";
  publish("conversation.created", conversationId, conversationId);
  publish("run.created", runId, conversationId);
  return reply.code(201).send({
    conversation: database.getConversation(conversationId),
    run: database.getRun(runId),
    dispatched,
    deduplicated: false,
  });
});

app.post<{
  Params: { id: string };
  Body: {
    prompt?: string;
    model?: string;
    effort?: ReasoningEffort;
    clientRequestId?: string;
    attachmentIds?: string[];
    allowWorkspaceConcurrency?: boolean;
  };
}>("/api/conversations/:id/runs", async (request, reply) => {
  const body = request.body ?? {};
  const prompt = body.prompt?.trim();
  const clientRequestId = body.clientRequestId?.trim() || randomUUID();
  if (!prompt) return reply.code(400).send({ error: "消息内容不能为空" });
  if (body.effort && !reasoningEfforts.has(body.effort)) {
    return reply.code(400).send({ error: "所选思考强度不受支持" });
  }
  const conversation = database.getConversation(request.params.id);
  if (!conversation) return reply.code(404).send({ error: "会话不存在或已被删除" });
  const existingRun = database.getRunByClientRequestId(clientRequestId);
  if (existingRun) {
    if (existingRun.conversationId !== conversation.id || existingRun.prompt !== prompt) {
      return reply.code(409).send({ error: "该客户端请求 ID 已用于另一个任务" });
    }
    return { run: existingRun, deduplicated: true };
  }
  const preparedAttachments = prepareAttachments(body.attachmentIds, clientRequestId);
  if (preparedAttachments.error) return reply.code(400).send({ error: preparedAttachments.error });
  if (conversation.status !== "ready" || !conversation.remoteThreadId) {
    return reply.code(409).send({ error: "节点上的会话尚未就绪，请稍后再试" });
  }
  if (database.hasActiveConversationCompaction(conversation.id)) {
    return reply.code(409).send({ error: "当前会话正在压缩上下文，请等待完成后再发送消息" });
  }
  if (database.hasActiveRun(conversation.id)) {
    return reply.code(409).send({ error: "当前会话已有活动任务，请向当前任务追加指令或等待任务完成" });
  }
  const workspaceValidation = await validateWorkspaceForUse(conversation.nodeId, conversation.workspaceId);
  if ("error" in workspaceValidation) return reply.code(workspaceValidation.statusCode).send({ error: workspaceValidation.error });
  if (body.allowWorkspaceConcurrency !== true
    && database.hasActiveRunInWorkspace(conversation.nodeId, conversation.workspaceId)) {
    return reply.code(409).send({
      code: "workspace_busy",
      error: `工作空间“${workspaceValidation.workspace.name}”已有正在运行或排队的任务`,
    });
  }
  if (database.hasActiveConversationCompaction(conversation.id)) {
    return reply.code(409).send({ error: "当前会话正在压缩上下文，请等待完成后再发送消息" });
  }
  const createdAt = now();
  const runId = randomUUID();
  const model = body.model?.trim() || conversation.model;
  const effort = selectedEffort(conversation.nodeId, model, body.effort ?? conversation.effort as ReasoningEffort | null);
  const runRecord = {
    id: runId,
    conversationId: conversation.id,
    prompt,
    model,
    effort,
    clientRequestId,
    remoteTurnId: null,
    status: "queued",
    progressPhase: null,
    progressLabel: "等待节点接收任务",
    progressUpdatedAt: createdAt,
    recoveryDeadlineAt: null,
    error: null,
    errorCode: null,
    createdAt,
    startedAt: null,
    finishedAt: null,
  } as const;
  const command: ControlCommand = {
    type: "run.start",
    conversationId: conversation.id,
    runId,
    workspaceId: conversation.workspaceId,
    threadId: conversation.remoteThreadId,
    prompt,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(preparedAttachments.descriptors.length ? { attachments: preparedAttachments.descriptors } : {}),
  };
  database.transaction(() => {
    database.createRun(runRecord);
    database.insertUserMessage({
      id: `user:${clientRequestId}`,
      conversationId: conversation.id,
      runId,
      content: prompt,
      ...(preparedAttachments.ids.length ? { attachmentIds: preparedAttachments.ids } : {}),
      createdAt,
    });
    if (preparedAttachments.ids.length) database.bindAttachments(preparedAttachments.ids, conversation.id);
    database.updateConversationPreferences(conversation.id, model, effort, createdAt);
    database.createCommand(`run:${clientRequestId}`, conversation.nodeId, command, createdAt);
  });
  dispatchPending(conversation.nodeId);
  const dispatched = database.getRun(runId)?.status === "dispatching";
  publish("run.created", runId, conversation.id);
  return reply.code(201).send({ run: database.getRun(runId), dispatched });
});

app.post<{ Params: { id: string }; Body: { allowWorkspaceConcurrency?: boolean } }>("/api/runs/:id/retry", async (request, reply) => {
  const body = request.body ?? {};
  const sourceRun = database.getRun(request.params.id);
  if (!sourceRun) return reply.code(404).send({ error: "任务不存在或已被删除" });
  if (!sourceRun.status || !["failed", "interrupted"].includes(sourceRun.status)) {
    return reply.code(409).send({ error: "只有失败或已中止的任务可以重新执行" });
  }
  const conversation = database.getConversation(sourceRun.conversationId);
  if (!conversation?.remoteThreadId || conversation.status !== "ready") {
    return reply.code(409).send({ error: "节点上的会话尚未就绪，请稍后再试" });
  }
  const clientRequestId = `retry:${sourceRun.id}`;
  const existingRetry = database.getRunByClientRequestId(clientRequestId);
  if (existingRetry) {
    return reply.code(200).send({
      run: existingRetry,
      dispatched: existingRetry.status === "dispatching",
      deduplicated: true,
    });
  }
  if (database.hasActiveConversationCompaction(conversation.id)) {
    return reply.code(409).send({ error: "当前会话正在压缩上下文，请等待完成后再重新执行任务" });
  }
  if (database.hasActiveRun(conversation.id)) {
    return reply.code(409).send({ error: "当前会话已有活动任务，请等待任务完成后再重新执行" });
  }
  const workspaceValidation = await validateWorkspaceForUse(conversation.nodeId, conversation.workspaceId);
  if ("error" in workspaceValidation) return reply.code(workspaceValidation.statusCode).send({ error: workspaceValidation.error });
  if (body.allowWorkspaceConcurrency !== true
    && database.hasActiveRunInWorkspace(conversation.nodeId, conversation.workspaceId)) {
    return reply.code(409).send({
      code: "workspace_busy",
      error: `工作空间“${workspaceValidation.workspace.name}”已有正在运行或排队的任务`,
    });
  }
  if (database.hasActiveConversationCompaction(conversation.id)) {
    return reply.code(409).send({ error: "当前会话正在压缩上下文，请等待完成后再重新执行任务" });
  }
  const sourceMessage = database.listMessages(conversation.id)
    .find((message) => message.role === "user" && message.runId === sourceRun.id);
  const attachmentIds = sourceMessage?.attachmentIds ?? [];
  const attachments = database.listAttachments(attachmentIds);
  if (attachments.length !== attachmentIds.length || attachments.some((attachment) => !attachment.sha256)) {
    return reply.code(409).send({ error: "原任务的附件已不可用，无法重新执行" });
  }
  const attachmentDescriptors: AttachmentDescriptor[] = attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    mediaType: attachment.mediaType,
    size: attachment.size,
    sha256: attachment.sha256!,
    downloadToken: attachment.downloadToken,
  }));
  const createdAt = now();
  const runId = randomUUID();
  const runRecord = {
    id: runId,
    conversationId: conversation.id,
    prompt: sourceRun.prompt,
    model: sourceRun.model,
    effort: sourceRun.effort,
    clientRequestId,
    remoteTurnId: null,
    status: "queued",
    progressPhase: null,
    progressLabel: "等待节点接收任务",
    progressUpdatedAt: createdAt,
    recoveryDeadlineAt: null,
    error: null,
    errorCode: null,
    createdAt,
    startedAt: null,
    finishedAt: null,
  } as const;
  const command: ControlCommand = {
    type: "run.start",
    conversationId: conversation.id,
    runId,
    workspaceId: conversation.workspaceId,
    threadId: conversation.remoteThreadId,
    prompt: sourceRun.prompt,
    ...(sourceRun.model ? { model: sourceRun.model } : {}),
    ...(sourceRun.effort ? { effort: sourceRun.effort as ReasoningEffort } : {}),
    ...(attachmentDescriptors.length ? { attachments: attachmentDescriptors } : {}),
  };
  database.transaction(() => {
    database.createRun(runRecord);
    database.insertUserMessage({
      id: `user:${clientRequestId}`,
      conversationId: conversation.id,
      runId,
      content: sourceRun.prompt,
      ...(attachmentIds.length ? { attachmentIds } : {}),
      createdAt,
    });
    database.createCommand(`run:${clientRequestId}`, conversation.nodeId, command, createdAt);
  });
  dispatchPending(conversation.nodeId);
  publish("run.created", runId, conversation.id);
  return reply.code(201).send({ run: database.getRun(runId), dispatched: database.getRun(runId)?.status === "dispatching", deduplicated: false });
});

app.post<{ Params: { id: string } }>("/api/runs/:id/interrupt", async (request, reply) => {
  const run = database.getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: "任务不存在或已被删除" });
  const conversation = database.getConversation(run.conversationId);
  if (!conversation?.remoteThreadId || !run.remoteTurnId) {
    return reply.code(409).send({ error: "任务尚未在节点上启动，当前无法中止" });
  }
  const createdAt = now();
  const command = database.createCommand(randomUUID(), conversation.nodeId, {
    type: "run.interrupt",
    conversationId: conversation.id,
    runId: run.id,
    threadId: conversation.remoteThreadId,
    turnId: run.remoteTurnId,
  }, createdAt);
  return reply.code(202).send({ dispatched: dispatch(command) });
});

app.post<{ Params: { id: string }; Body: { prompt?: string; clientRequestId?: string; attachmentIds?: string[] } }>("/api/runs/:id/steer", async (request, reply) => {
  const prompt = request.body?.prompt?.trim();
  const clientRequestId = request.body?.clientRequestId?.trim() || randomUUID();
  if (!prompt) return reply.code(400).send({ error: "追加的任务内容不能为空" });
  const existingCommand = database.getCommand(`steer:${clientRequestId}`);
  if (existingCommand) {
    if (existingCommand.command.type !== "run.steer" || existingCommand.command.runId !== request.params.id || existingCommand.command.prompt !== prompt) {
      return reply.code(409).send({ error: "该客户端请求 ID 已用于另一条追加指令" });
    }
    return reply.code(202).send({ dispatched: existingCommand.status !== "failed", deduplicated: true });
  }
  const run = database.getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: "任务不存在或已被删除" });
  const conversation = database.getConversation(run.conversationId);
  if (!conversation?.remoteThreadId || !run.remoteTurnId || !["running", "waiting_approval"].includes(run.status)) {
    return reply.code(409).send({ error: "任务当前不在运行，无法追加指令" });
  }
  const preparedAttachments = prepareAttachments(request.body?.attachmentIds, clientRequestId);
  if (preparedAttachments.error) return reply.code(400).send({ error: preparedAttachments.error });
  const createdAt = now();
  const controlCommand: ControlCommand = {
    type: "run.steer",
    conversationId: conversation.id,
    runId: run.id,
    threadId: conversation.remoteThreadId,
    turnId: run.remoteTurnId,
    prompt,
    ...(preparedAttachments.descriptors.length ? { attachments: preparedAttachments.descriptors } : {}),
  };
  const command = database.transaction(() => {
    const createdCommand = database.createCommand(`steer:${clientRequestId}`, conversation.nodeId, controlCommand, createdAt);
    database.insertUserMessage({
      id: `user:${clientRequestId}`,
      conversationId: conversation.id,
      runId: run.id,
      content: prompt,
      ...(preparedAttachments.ids.length ? { attachmentIds: preparedAttachments.ids } : {}),
      createdAt,
    });
    if (preparedAttachments.ids.length) database.bindAttachments(preparedAttachments.ids, conversation.id);
    return createdCommand;
  });
  publish("message.updated", `user:${clientRequestId}`, conversation.id);
  return reply.code(202).send({ dispatched: dispatch(command) });
});

app.get<{ Querystring: { status?: string; conversationId?: string } }>("/api/approvals", async (request) => ({
  data: database.listApprovals(request.query.status, request.query.conversationId),
}));

app.post<{ Params: { id: string }; Body: { response?: JsonValue } }>("/api/approvals/:id/resolve", async (request, reply) => {
  const approval = database.getApproval(request.params.id);
  if (!approval) return reply.code(404).send({ error: "确认请求不存在或已处理" });
  if (approval.status !== "pending") return reply.code(409).send({ error: "确认请求已被处理，不能重复提交" });
  if (!isRecord(request.body?.response)) return reply.code(400).send({ error: "确认结果格式无效" });
  const command = database.createCommand(randomUUID(), approval.nodeId, {
    type: "approval.resolve",
    approvalId: approval.id,
    response: request.body.response as JsonValue,
  }, now());
  const dispatched = dispatch(command);
  publish("approval.updated", approval.id, approval.conversationId);
  return reply.code(202).send({ dispatched });
});

app.get("/api/settings", async () => ({ settings: database.getGlobalSettings() }));

app.patch<{ Body: { defaultModel?: string | null; defaultEffort?: ReasoningEffort | null } }>("/api/settings", async (request, reply) => {
  const current = database.getGlobalSettings();
  const defaultModel = request.body?.defaultModel === undefined
    ? current.defaultModel
    : typeof request.body.defaultModel === "string" && request.body.defaultModel.trim()
      ? request.body.defaultModel.trim()
      : null;
  const defaultEffort = request.body?.defaultEffort === undefined
    ? current.defaultEffort
    : request.body.defaultEffort;
  if (defaultEffort && !reasoningEfforts.has(defaultEffort as ReasoningEffort)) {
    return reply.code(400).send({ error: "所选思考强度不受支持" });
  }
  const settings = database.updateGlobalSettings({ defaultModel, defaultEffort: defaultEffort ?? null }, now());
  publish("settings.updated", "global");
  return { settings };
});

app.get("/api/task-center", async () => ({
  data: database.listTaskCenter(taskCenterPolicy.limit),
  unreadCount: database.listNotifications(true).length,
  policy: taskCenterPolicy,
}));

app.post("/api/notifications/read-all", async (_request, reply) => {
  if (database.markAllNotificationsRead(now()) > 0) publish("notification.updated", "all");
  return reply.code(204).send();
});

app.post<{ Params: { id: string } }>("/api/notifications/:id/read", async (request, reply) => {
  if (!database.markNotificationRead(request.params.id, now())) return reply.code(404).send({ error: "通知不存在或已被清理" });
  publish("notification.updated", request.params.id);
  return reply.code(204).send();
});

app.post<{ Params: { id: string } }>("/api/conversations/:id/read", async (request, reply) => {
  if (!database.getConversation(request.params.id)) return reply.code(404).send({ error: "会话不存在或已被删除" });
  if (database.markConversationNotificationsRead(request.params.id, now()) > 0) publish("notification.updated", request.params.id, request.params.id);
  return reply.code(204).send();
});

app.post<{ Body: { sessionId?: string; conversationId?: string | null; visible?: boolean } }>("/api/ui/presence", async (request, reply) => {
  const sessionId = request.body?.sessionId?.trim();
  if (!sessionId || sessionId.length > 128) return reply.code(400).send({ error: "浏览器会话 ID 无效" });
  const conversationId = typeof request.body.conversationId === "string" ? request.body.conversationId : null;
  uiPresence.set(sessionId, { conversationId, visible: request.body.visible === true, seenAt: Date.now() });
  return reply.code(204).send();
});

app.post<{
  Body: { name?: string; mediaType?: string; size?: number; messageClientId?: string; conversationId?: string };
}>("/api/attachments", async (request, reply) => {
  const size = Number(request.body?.size);
  const messageClientId = request.body?.messageClientId?.trim();
  if (!Number.isSafeInteger(size) || size <= 0 || size > 20 * 1024 * 1024) {
    return reply.code(400).send({ error: "附件大小必须在 1 字节到 20MB 之间" });
  }
  if (!messageClientId || messageClientId.length > 128) return reply.code(400).send({ error: "附件所属消息 ID 无效" });
  if (database.totalAttachmentBytes() + size > 2 * 1024 * 1024 * 1024) {
    return reply.code(507).send({ error: "附件存储空间已满，请清理后重试" });
  }
  const id = randomUUID();
  const storageKey = `${id}.upload`;
  const createdAt = now();
  const record = {
    id,
    conversationId: request.body?.conversationId?.trim() || null,
    messageClientId,
    name: normalizedAttachmentName(request.body?.name ?? "附件"),
    mediaType: request.body?.mediaType?.trim().slice(0, 120) || "application/octet-stream",
    size,
    receivedSize: 0,
    sha256: null,
    status: "uploading",
    storageKey,
    downloadToken: randomBytes(24).toString("base64url"),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt,
  } as const;
  const filePath = path.join(config.attachmentDirectory, storageKey);
  closeSync(openSync(filePath, "wx", 0o600));
  try { database.createAttachment(record); }
  catch (error) { if (existsSync(filePath)) unlinkSync(filePath); throw error; }
  return reply.code(201).send({ attachment: record });
});

app.get<{ Params: { id: string } }>("/api/attachments/:id", async (request, reply) => {
  const attachment = database.getAttachment(request.params.id);
  if (!attachment) return reply.code(404).send({ error: "附件不存在或已被清理" });
  return { attachment };
});

app.put<{ Params: { id: string; offset: string }; Body: Buffer }>("/api/attachments/:id/chunks/:offset", async (request, reply) => {
  const attachment = database.getAttachment(request.params.id);
  if (!attachment) return reply.code(404).send({ error: "附件不存在或已被清理" });
  const offset = Number(request.params.offset);
  const chunk = request.body;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Buffer.isBuffer(chunk) || chunk.length === 0 || chunk.length > 1024 * 1024) {
    return reply.code(400).send({ error: "附件分片无效" });
  }
  if (attachment.status !== "uploading") return reply.code(409).send({ error: "附件已不处于上传状态", receivedSize: attachment.receivedSize });
  if (offset < attachment.receivedSize && offset + chunk.length <= attachment.receivedSize) {
    return { receivedSize: attachment.receivedSize, deduplicated: true };
  }
  if (offset !== attachment.receivedSize) {
    return reply.code(409).send({ error: "附件分片位置不匹配，请从服务端记录的位置继续上传", receivedSize: attachment.receivedSize });
  }
  const filePath = path.join(config.attachmentDirectory, attachment.storageKey);
  const file = openSync(filePath, "r+");
  try { writeSync(file, chunk, 0, chunk.length, offset); } finally { closeSync(file); }
  const updated = database.updateAttachmentOffset(attachment.id, offset, chunk.length);
  if (!updated) return reply.code(409).send({ error: "附件上传位置已变化，请重试当前分片" });
  return { receivedSize: updated.receivedSize, deduplicated: false };
});

app.post<{ Params: { id: string }; Body: { sha256?: string } }>("/api/attachments/:id/finalize", async (request, reply) => {
  const attachment = database.getAttachment(request.params.id);
  if (!attachment) return reply.code(404).send({ error: "附件不存在或已被清理" });
  if (attachment.status === "ready") return { attachment };
  if (attachment.status !== "uploading" || attachment.receivedSize !== attachment.size) {
    return reply.code(409).send({ error: "附件尚未上传完成", receivedSize: attachment.receivedSize });
  }
  const temporaryPath = path.join(config.attachmentDirectory, attachment.storageKey);
  const finalKey = `${attachment.id}.bin`;
  const finalPath = path.join(config.attachmentDirectory, finalKey);
  const readablePath = existsSync(temporaryPath) ? temporaryPath : finalPath;
  if (!existsSync(readablePath) || statSync(readablePath).size !== attachment.size) {
    return reply.code(409).send({ error: "附件数据不完整" });
  }
  const digest = createHash("sha256").update(readFileSync(readablePath)).digest("hex");
  if (request.body?.sha256 && request.body.sha256.toLowerCase() !== digest) {
    return reply.code(422).send({ error: "附件校验失败，请重新上传" });
  }
  if (existsSync(temporaryPath)) renameSync(temporaryPath, finalPath);
  else if (!existsSync(finalPath)) return reply.code(404).send({ error: "附件文件已丢失" });
  const finalized = database.finalizeAttachment(attachment.id, digest, finalKey);
  if (!finalized) return reply.code(409).send({ error: "附件状态已变化，无法完成上传" });
  return { attachment: finalized };
});

app.delete<{ Params: { id: string } }>("/api/attachments/:id", async (request, reply) => {
  const attachment = database.getAttachment(request.params.id);
  if (!attachment) return reply.code(204).send();
  if (attachment.status === "consumed") return reply.code(409).send({ error: "附件已随消息发送，不能删除" });
  const filePath = path.join(config.attachmentDirectory, attachment.storageKey);
  if (existsSync(filePath)) unlinkSync(filePath);
  database.deleteAttachment(attachment.id);
  return reply.code(204).send();
});

app.get<{ Params: { id: string }; Querystring: { token?: string } }>("/agent/attachments/:id", async (request, reply) => {
  const attachment = database.getAttachment(request.params.id);
  const downloadToken = bearerToken(request) || request.query.token || "";
  if (!attachment || !downloadToken || !safeTokenEqual(downloadToken, attachment.downloadToken)) {
    return reply.code(404).send({ error: "附件不存在或已被清理" });
  }
  if (!["ready", "consumed"].includes(attachment.status)) return reply.code(409).send({ error: "附件尚未准备完成" });
  const filePath = path.join(config.attachmentDirectory, attachment.storageKey);
  if (!existsSync(filePath)) return reply.code(404).send({ error: "附件文件已丢失" });
  reply.header("Content-Type", attachment.mediaType);
  reply.header("Content-Length", String(attachment.size));
  return reply.send(createReadStream(filePath));
});

app.get<{ Querystring: { after?: string } }>("/api/stream", async (request, reply: FastifyReply) => {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const headerRevision = Number(request.headers["last-event-id"] ?? 0);
  const queryRevision = Number(request.query.after ?? 0);
  const after = Number.isSafeInteger(headerRevision) && headerRevision > 0 ? headerRevision : Number.isSafeInteger(queryRevision) ? queryRevision : 0;
  let replayCursor = after;
  while (true) {
    const batch = database.listUiEventsAfter(replayCursor);
    for (const event of batch) {
      reply.raw.write(`id: ${event.revision}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`);
      replayCursor = event.revision;
    }
    if (batch.length < 1000) break;
  }
  reply.raw.write(`event: ready\ndata: ${JSON.stringify({ connectedAt: now(), revision: database.currentUiRevision() })}\n\n`);
  uiStreams.add(reply.raw);
  const unsubscribe = events.subscribe((event) => {
    reply.raw.write(`id: ${event.revision}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const keepAlive = setInterval(() => reply.raw.write(": keep-alive\n\n"), 15_000);
  request.raw.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
    uiStreams.delete(reply.raw);
  });
});

const staleTimer = setInterval(() => {
  const currentTime = now();
  const cutoff = new Date(Date.now() - config.offlineAfterMs).toISOString();
  for (const nodeId of database.markStaleNodesOffline(cutoff, currentTime)) {
    connections.close(nodeId);
    publish("node.offline", nodeId);
  }
  for (const runId of database.failExpiredRecoveringRuns(currentTime)) {
    notifyRun(runId, "failed", "无法确认远端任务状态", currentTime);
    publish("run.updated", runId, database.getRun(runId)?.conversationId);
  }
  for (const conversationId of database.failExpiredRecoveringCompactions(currentTime)) {
    publish("conversation.compaction", database.getConversation(conversationId)?.compaction?.id, conversationId);
  }
  for (const [sessionId, presence] of uiPresence) {
    if (presence.seenAt < Date.now() - 60_000) uiPresence.delete(sessionId);
  }
}, Math.min(config.offlineAfterMs, 15_000));

function cleanupExpiringResources(): void {
  const currentTime = now();
  for (const attachment of database.listExpiredAttachments(currentTime)) {
    const filePath = path.join(config.attachmentDirectory, attachment.storageKey);
    if (existsSync(filePath)) unlinkSync(filePath);
    database.deleteAttachment(attachment.id);
  }
  database.cleanupEnrollmentTokens(currentTime);
  for (const [remote, attempt] of loginAttempts) {
    if (attempt.resetAt <= Date.now()) loginAttempts.delete(remote);
  }
}

function cleanupRetainedRecords(): void {
  database.cleanupNotifications(
    new Date(Date.now() - taskCenterPolicy.readRetentionDays * 24 * 60 * 60 * 1000).toISOString(),
    new Date(Date.now() - taskCenterPolicy.unreadRetentionDays * 24 * 60 * 60 * 1000).toISOString(),
  );
  database.cleanupUiEvents(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  const secretCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  database.cleanupAdminSessions(secretCutoff);
}

cleanupExpiringResources();
cleanupRetainedRecords();
const expiryCleanupTimer = setInterval(cleanupExpiringResources, 60_000);
const retentionCleanupTimer = setInterval(cleanupRetainedRecords, 60 * 60 * 1000);

const commandRetryTimer = setInterval(() => {
  for (const node of database.listNodes()) {
    if (node.status === "online") dispatchPending(node.id);
  }
}, 15_000);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Shutting down control plane");
  clearInterval(staleTimer);
  clearInterval(commandRetryTimer);
  clearInterval(expiryCleanupTimer);
  clearInterval(retentionCleanupTimer);
  for (const pending of pendingMessageUiEvents.values()) clearTimeout(pending.timer);
  pendingMessageUiEvents.clear();
  connections.closeAll();
  for (const stream of uiStreams) stream.end();
  uiStreams.clear();
  await app.close();
  database.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

if (config.agentToken === "dev-agent-token") {
  app.log.warn("Using the development agent token. Set AGENT_SHARED_TOKEN before deployment.");
}

await app.listen({ host: config.host, port: config.port });
