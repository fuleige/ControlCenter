import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import {
  CONTROL_PROTOCOL_VERSION,
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
import { AgentConnections } from "./connections.js";
import { ControlDatabase, type CommandRecord, type ConversationListCursor } from "./database.js";
import { UiEventBus } from "./event-bus.js";

const config = loadConfig();
const database = new ControlDatabase(config.databasePath);
const connections = new AgentConnections();
const events = new UiEventBus();
const app = Fastify({ logger: true });
const taskCenterPolicy = { limit: 200, replyPreviewCharacters: 120, readRetentionDays: 30, unreadRetentionDays: 90 } as const;
mkdirSync(config.attachmentDirectory, { recursive: true, mode: 0o700 });
app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: 2 * 1024 * 1024 }, (_request, body, done) => {
  done(null, body);
});

await app.register(cors, {
  origin: config.corsOrigin === "*"
    ? true
    : config.corsOrigin.split(",").map((value) => value.trim()),
  credentials: false,
});
await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } });

function now(): string {
  return new Date().toISOString();
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

app.addHook("onRequest", async (request, reply) => {
  if (!request.url.startsWith("/api/") || request.url.startsWith("/api/health") || !config.adminToken) return;
  const query = request.query as { token?: string };
  const token = bearerToken(request) || query.token || "";
  if (!safeTokenEqual(token, config.adminToken)) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

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
    if (run.status === "queued" && !database.canDispatchQueuedRun(command.nodeId, command.command.workspaceId)) {
      return false;
    }
  }
  const sent = connections.sendCommand(command.nodeId, commandEnvelope(command));
  if (sent && (command.command.type === "run.start" || command.command.type === "conversation.start")) {
    database.markRunDispatching(command.command.runId);
  }
  return sent;
}

function dispatchPending(nodeId: string): void {
  for (const command of database.listPendingCommands(nodeId)) dispatch(command);
}

function publish(type: string, resourceId?: string): void {
  const event = database.createUiEvent(type, resourceId ?? null, now());
  events.publish(event);
}

interface UiPresence {
  conversationId: string | null;
  visible: boolean;
  seenAt: number;
}

const uiPresence = new Map<string, UiPresence>();

function conversationIsVisible(conversationId: string): boolean {
  const cutoff = Date.now() - 45_000;
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
  publish("notification.created", runId);
}

function normalizedAttachmentName(value: string): string {
  return path.basename(value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180) || "附件";
}

function prepareAttachments(ids: unknown, messageClientId: string): { ids: string[]; descriptors: AttachmentDescriptor[]; error?: string } {
  if (ids === undefined || ids === null) return { ids: [], descriptors: [] };
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id.trim())) {
    return { ids: [], descriptors: [], error: "attachmentIds must be an array of IDs" };
  }
  const uniqueIds = [...new Set(ids.map((id) => id.trim()))];
  if (uniqueIds.length > 10) return { ids: [], descriptors: [], error: "A message can contain at most 10 attachments" };
  const records = database.listAttachments(uniqueIds);
  if (records.length !== uniqueIds.length) return { ids: [], descriptors: [], error: "One or more attachments do not exist" };
  if (records.some((record) => record.status !== "ready" || !record.sha256)) {
    return { ids: [], descriptors: [], error: "All attachments must finish uploading before sending" };
  }
  if (records.some((record) => record.messageClientId !== messageClientId)) {
    return { ids: [], descriptors: [], error: "An attachment belongs to a different message" };
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
      publish("conversation.updated", payload.conversationId);
      break;
    case "run.started":
      database.startRun(payload);
      publish("run.updated", payload.runId);
      break;
    case "run.progress":
      database.updateRunProgress(payload);
      publish("run.updated", payload.runId);
      break;
    case "message.snapshot":
      if (database.upsertMessageSnapshot(payload)) publish("message.updated", payload.conversationId);
      break;
    case "run.finished":
      database.finishRun(payload);
      if (payload.status === "completed") notifyRun(payload.runId, "completed", "任务已完成", payload.finishedAt);
      if (payload.status === "failed") notifyRun(payload.runId, "failed", payload.error ?? "任务执行失败", payload.finishedAt);
      publish("run.updated", payload.runId);
      shouldDispatchPending = true;
      break;
    case "interaction.requested":
      database.insertApproval(nodeId, payload);
      if (payload.runId) notifyRun(payload.runId, "waiting_user", payload.summary, payload.requestedAt);
      publish("approval.created", payload.approvalId);
      break;
    case "interaction.resolved":
      database.resolveApproval(payload.approvalId, payload.response, payload.resolvedAt);
      publish("approval.updated", payload.approvalId);
      break;
    case "agent.stateReport":
      for (const failedRunId of database.reconcileNodeRuns(nodeId, payload.activeRuns.map((run) => run.runId), payload.reportedAt)) {
        notifyRun(failedRunId, "failed", "节点重启后无法确认原任务状态", payload.reportedAt);
        publish("run.updated", failedRunId);
      }
      shouldDispatchPending = true;
      break;
    case "agent.error":
      database.applyAgentError(payload, receivedAt);
      if (payload.runId) notifyRun(payload.runId, "failed", payload.message, receivedAt);
      publish("agent.error", payload.runId ?? payload.conversationId);
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

app.get("/agent/connect", { websocket: true }, (socket: WebSocket, request) => {
  if (!safeTokenEqual(bearerToken(request), config.agentToken)) {
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
        if (message.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
          socket.send(JSON.stringify({
            type: "control.error",
            code: "protocol_version_mismatch",
            message: `Expected protocol ${CONTROL_PROTOCOL_VERSION}`,
          }));
          socket.close(4400, "Protocol mismatch");
          return;
        }
        nodeId = message.node.id;
        initialized = true;
        const restarted = database.upsertNode(message.node, message.bootId, now());
        connections.set(nodeId, message.bootId, socket);
        connections.send(nodeId, {
          type: "control.welcome",
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          nodeId,
          connectedAt: now(),
          heartbeatIntervalMs: config.heartbeatIntervalMs,
        });
        publish("node.online", nodeId);
        if (restarted) publish("node.restarted", nodeId);
        dispatchPending(nodeId);
        return;
      }

      if (!nodeId) throw new Error("Missing node identity");
      if (message.type === "agent.heartbeat") {
        database.updateHeartbeat(nodeId, message.activeRuns, now());
      } else if (message.type === "agent.commandAck") {
        database.updateCommand(message.commandId, message.status, message.error ?? null, now());
        publish("command.updated", message.commandId);
      } else if (message.type === "agent.message") {
        processDurableMessage(nodeId, message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      app.log.warn({ nodeId, error: message }, "Rejected agent message");
      socket.send(JSON.stringify({ type: "control.error", code: "invalid_message", message }));
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
  if (!("name" in (request.body ?? {}))) return reply.code(400).send({ error: "name is required" });
  const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
  if (name.length > 64) return reply.code(400).send({ error: "name must be 64 characters or fewer" });
  if (!database.updateNodeName(request.params.id, name || null, now())) {
    return reply.code(404).send({ error: "Node not found" });
  }
  publish("node.updated", request.params.id);
  const node = database.listNodes().find((candidate) => candidate.id === request.params.id);
  return { node };
});

app.get<{ Querystring: { nodeId?: string; q?: string; status?: string; limit?: string; cursor?: string } }>("/api/conversations", async (request, reply) => {
  const query = request.query.q?.trim() ?? "";
  if (query.length > 100) return reply.code(400).send({ error: "q must not exceed 100 characters" });
  const requestedLimit = Number.parseInt(request.query.limit ?? "50", 10);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    return reply.code(400).send({ error: "limit must be between 1 and 100" });
  }
  const cursor = decodeConversationCursor(request.query.cursor);
  if (request.query.cursor && !cursor) return reply.code(400).send({ error: "Invalid conversation cursor" });
  if (request.query.status && !["active", "failed"].includes(request.query.status)) {
    return reply.code(400).send({ error: "status must be active or failed" });
  }
  const page = database.listConversationPage({
    ...(request.query.nodeId?.trim() ? { nodeId: request.query.nodeId.trim() } : {}),
    ...(query ? { query } : {}),
    ...(request.query.status ? { runStatus: request.query.status as "active" | "failed" } : {}),
    limit: requestedLimit,
    ...(cursor ? { cursor } : {}),
  });
  return { data: page.data, total: page.total, nextCursor: encodeConversationCursor(page.nextCursor) };
});

app.patch<{ Params: { id: string }; Body: { title?: string; pinned?: boolean } }>("/api/conversations/:id", async (request, reply) => {
  const input: { title?: string; pinned?: boolean } = {};
  if (typeof request.body?.title === "string") {
    const title = request.body.title.trim();
    if (!title || title.length > 80) return reply.code(400).send({ error: "title must contain 1 to 80 characters" });
    input.title = title;
  }
  if (typeof request.body?.pinned === "boolean") input.pinned = request.body.pinned;
  if (Object.keys(input).length === 0) return reply.code(400).send({ error: "title or pinned is required" });
  const conversation = database.updateConversation(request.params.id, input, now());
  if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
  publish("conversation.updated", conversation.id);
  return { conversation };
});

app.get<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
  const conversation = database.getConversation(request.params.id);
  if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
  return {
    conversation,
    runs: database.listRuns(conversation.id),
    messages: database.listMessages(conversation.id),
    attachments: database.listConversationAttachments(conversation.id).map(({ downloadToken: _downloadToken, storageKey: _storageKey, ...attachment }) => attachment),
    approvals: database.listApprovals(undefined, conversation.id),
  };
});

app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
  const conversation = database.getConversation(request.params.id);
  if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
  const hasActiveRun = database.listRuns(conversation.id)
    .some((run) => ["queued", "dispatching", "running", "waiting_approval", "recovering"].includes(run.status));
  if (hasActiveRun) return reply.code(409).send({ error: "End the active task before deleting this conversation" });
  if (conversation.status === "creating" && !conversation.remoteThreadId) {
    return reply.code(409).send({ error: "Conversation is still being created" });
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
  publish("conversation.deleted", conversation.id);
  return reply.code(204).send();
});

app.post<{
  Body: { nodeId?: string; workspaceId?: string; title?: string; model?: string };
}>("/api/conversations", async (request, reply) => {
  const body = request.body ?? {};
  const { nodeId, workspaceId } = body;
  const title = body.title?.trim();
  if (!nodeId || !workspaceId || !title) {
    return reply.code(400).send({ error: "nodeId, workspaceId and title are required" });
  }
  if (!database.getWorkspace(nodeId, workspaceId)) {
    return reply.code(404).send({ error: "Workspace not found on node" });
  }

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
      createdAt,
      updatedAt: createdAt,
    });
    return database.createCommand(randomUUID(), nodeId, command, createdAt);
  });
  const dispatched = dispatch(commandRecord);
  publish("conversation.created", conversationId);
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
  };
}>("/api/conversations/start", async (request, reply) => {
  const body = request.body ?? {};
  const nodeId = body.nodeId?.trim();
  const workspaceId = body.workspaceId?.trim();
  const prompt = body.prompt?.trim();
  const clientRequestId = body.clientRequestId?.trim() || randomUUID();
  if (!nodeId || !workspaceId || !prompt) {
    return reply.code(400).send({ error: "nodeId, workspaceId and prompt are required" });
  }
  if (clientRequestId.length > 128) {
    return reply.code(400).send({ error: "clientRequestId must be 128 characters or fewer" });
  }
  if (body.effort && !reasoningEfforts.has(body.effort)) {
    return reply.code(400).send({ error: "Unsupported reasoning effort" });
  }
  const existing = database.getConversationByClientRequestId(clientRequestId);
  if (existing) {
    const existingRun = database.listRuns(existing.id)[0] ?? null;
    if (existing.nodeId !== nodeId || existing.workspaceId !== workspaceId || existingRun?.prompt !== prompt) {
      return reply.code(409).send({ error: "clientRequestId was already used for a different conversation" });
    }
    return reply.send({
      conversation: existing,
      run: existingRun,
      deduplicated: true,
    });
  }
  const preparedAttachments = prepareAttachments(body.attachmentIds, clientRequestId);
  if (preparedAttachments.error) return reply.code(400).send({ error: preparedAttachments.error });
  if (!database.getWorkspace(nodeId, workspaceId)) {
    return reply.code(404).send({ error: "Workspace not found on node" });
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
  publish("conversation.created", conversationId);
  publish("run.created", runId);
  return reply.code(201).send({
    conversation: database.getConversation(conversationId),
    run: database.getRun(runId),
    dispatched,
    deduplicated: false,
  });
});

app.post<{
  Params: { id: string };
  Body: { prompt?: string; model?: string; effort?: ReasoningEffort; clientRequestId?: string; attachmentIds?: string[] };
}>("/api/conversations/:id/runs", async (request, reply) => {
  const body = request.body ?? {};
  const prompt = body.prompt?.trim();
  const clientRequestId = body.clientRequestId?.trim() || randomUUID();
  if (!prompt) return reply.code(400).send({ error: "prompt is required" });
  if (body.effort && !reasoningEfforts.has(body.effort)) {
    return reply.code(400).send({ error: "Unsupported reasoning effort" });
  }
  const conversation = database.getConversation(request.params.id);
  if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
  const existingRun = database.getRunByClientRequestId(clientRequestId);
  if (existingRun) {
    if (existingRun.conversationId !== conversation.id || existingRun.prompt !== prompt) {
      return reply.code(409).send({ error: "clientRequestId was already used for a different task" });
    }
    return { run: existingRun, deduplicated: true };
  }
  const preparedAttachments = prepareAttachments(body.attachmentIds, clientRequestId);
  if (preparedAttachments.error) return reply.code(400).send({ error: preparedAttachments.error });
  if (conversation.status !== "ready" || !conversation.remoteThreadId) {
    return reply.code(409).send({ error: "Conversation is not ready on the node" });
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
  publish("run.created", runId);
  return reply.code(201).send({ run: database.getRun(runId), dispatched });
});

app.post<{ Params: { id: string } }>("/api/runs/:id/retry", async (request, reply) => {
  const sourceRun = database.getRun(request.params.id);
  if (!sourceRun) return reply.code(404).send({ error: "Run not found" });
  if (!sourceRun.status || !["failed", "interrupted"].includes(sourceRun.status)) {
    return reply.code(409).send({ error: "Only failed or interrupted tasks can be retried" });
  }
  const conversation = database.getConversation(sourceRun.conversationId);
  if (!conversation?.remoteThreadId || conversation.status !== "ready") {
    return reply.code(409).send({ error: "Conversation is not ready on the node" });
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
  const sourceMessage = database.listMessages(conversation.id)
    .find((message) => message.role === "user" && message.runId === sourceRun.id);
  const attachmentIds = sourceMessage?.attachmentIds ?? [];
  const attachments = database.listAttachments(attachmentIds);
  if (attachments.length !== attachmentIds.length || attachments.some((attachment) => !attachment.sha256)) {
    return reply.code(409).send({ error: "The original task attachments are no longer available" });
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
  publish("run.created", runId);
  return reply.code(201).send({ run: database.getRun(runId), dispatched: database.getRun(runId)?.status === "dispatching", deduplicated: false });
});

app.post<{ Params: { id: string } }>("/api/runs/:id/interrupt", async (request, reply) => {
  const run = database.getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: "Run not found" });
  const conversation = database.getConversation(run.conversationId);
  if (!conversation?.remoteThreadId || !run.remoteTurnId) {
    return reply.code(409).send({ error: "Run has not started remotely" });
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
  if (!prompt) return reply.code(400).send({ error: "prompt is required" });
  const existingCommand = database.getCommand(`steer:${clientRequestId}`);
  if (existingCommand) {
    if (existingCommand.command.type !== "run.steer" || existingCommand.command.runId !== request.params.id || existingCommand.command.prompt !== prompt) {
      return reply.code(409).send({ error: "clientRequestId was already used for a different instruction" });
    }
    return reply.code(202).send({ dispatched: existingCommand.status !== "failed", deduplicated: true });
  }
  const run = database.getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: "Run not found" });
  const conversation = database.getConversation(run.conversationId);
  if (!conversation?.remoteThreadId || !run.remoteTurnId || !["running", "waiting_approval"].includes(run.status)) {
    return reply.code(409).send({ error: "Run is not active" });
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
  publish("message.updated", conversation.id);
  return reply.code(202).send({ dispatched: dispatch(command) });
});

app.get<{ Querystring: { status?: string; conversationId?: string } }>("/api/approvals", async (request) => ({
  data: database.listApprovals(request.query.status, request.query.conversationId),
}));

app.post<{ Params: { id: string }; Body: { response?: JsonValue } }>("/api/approvals/:id/resolve", async (request, reply) => {
  const approval = database.getApproval(request.params.id);
  if (!approval) return reply.code(404).send({ error: "Approval not found" });
  if (approval.status !== "pending") return reply.code(409).send({ error: "Approval is no longer pending" });
  if (!isRecord(request.body?.response)) return reply.code(400).send({ error: "response must be an object" });
  const command = database.createCommand(randomUUID(), approval.nodeId, {
    type: "approval.resolve",
    approvalId: approval.id,
    response: request.body.response as JsonValue,
  }, now());
  const dispatched = dispatch(command);
  publish("approval.updated", approval.id);
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
    return reply.code(400).send({ error: "Unsupported reasoning effort" });
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
  if (!database.markNotificationRead(request.params.id, now())) return reply.code(404).send({ error: "Notification not found" });
  publish("notification.updated", request.params.id);
  return reply.code(204).send();
});

app.post<{ Params: { id: string } }>("/api/conversations/:id/read", async (request, reply) => {
  if (!database.getConversation(request.params.id)) return reply.code(404).send({ error: "Conversation not found" });
  if (database.markConversationNotificationsRead(request.params.id, now()) > 0) publish("notification.updated", request.params.id);
  return reply.code(204).send();
});

app.post<{ Body: { sessionId?: string; conversationId?: string | null; visible?: boolean } }>("/api/ui/presence", async (request, reply) => {
  const sessionId = request.body?.sessionId?.trim();
  if (!sessionId || sessionId.length > 128) return reply.code(400).send({ error: "sessionId is required" });
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
    return reply.code(400).send({ error: "Attachment size must be between 1 byte and 20MB" });
  }
  if (!messageClientId || messageClientId.length > 128) return reply.code(400).send({ error: "messageClientId is required" });
  if (database.totalAttachmentBytes() + size > 2 * 1024 * 1024 * 1024) {
    return reply.code(507).send({ error: "Attachment storage quota exceeded" });
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
  if (!attachment) return reply.code(404).send({ error: "Attachment not found" });
  return { attachment };
});

app.put<{ Params: { id: string; offset: string }; Body: Buffer }>("/api/attachments/:id/chunks/:offset", async (request, reply) => {
  const attachment = database.getAttachment(request.params.id);
  if (!attachment) return reply.code(404).send({ error: "Attachment not found" });
  const offset = Number(request.params.offset);
  const chunk = request.body;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Buffer.isBuffer(chunk) || chunk.length === 0 || chunk.length > 1024 * 1024) {
    return reply.code(400).send({ error: "Invalid attachment chunk" });
  }
  if (attachment.status !== "uploading") return reply.code(409).send({ error: "Attachment is no longer uploading", receivedSize: attachment.receivedSize });
  if (offset < attachment.receivedSize && offset + chunk.length <= attachment.receivedSize) {
    return { receivedSize: attachment.receivedSize, deduplicated: true };
  }
  if (offset !== attachment.receivedSize) {
    return reply.code(409).send({ error: "Unexpected chunk offset", receivedSize: attachment.receivedSize });
  }
  const filePath = path.join(config.attachmentDirectory, attachment.storageKey);
  const file = openSync(filePath, "r+");
  try { writeSync(file, chunk, 0, chunk.length, offset); } finally { closeSync(file); }
  const updated = database.updateAttachmentOffset(attachment.id, offset, chunk.length);
  if (!updated) return reply.code(409).send({ error: "Attachment offset changed; retry this chunk" });
  return { receivedSize: updated.receivedSize, deduplicated: false };
});

app.post<{ Params: { id: string }; Body: { sha256?: string } }>("/api/attachments/:id/finalize", async (request, reply) => {
  const attachment = database.getAttachment(request.params.id);
  if (!attachment) return reply.code(404).send({ error: "Attachment not found" });
  if (attachment.status === "ready") return { attachment };
  if (attachment.status !== "uploading" || attachment.receivedSize !== attachment.size) {
    return reply.code(409).send({ error: "Attachment upload is incomplete", receivedSize: attachment.receivedSize });
  }
  const temporaryPath = path.join(config.attachmentDirectory, attachment.storageKey);
  const finalKey = `${attachment.id}.bin`;
  const finalPath = path.join(config.attachmentDirectory, finalKey);
  const readablePath = existsSync(temporaryPath) ? temporaryPath : finalPath;
  if (!existsSync(readablePath) || statSync(readablePath).size !== attachment.size) {
    return reply.code(409).send({ error: "Attachment data is incomplete" });
  }
  const digest = createHash("sha256").update(readFileSync(readablePath)).digest("hex");
  if (request.body?.sha256 && request.body.sha256.toLowerCase() !== digest) {
    return reply.code(422).send({ error: "Attachment checksum mismatch" });
  }
  if (existsSync(temporaryPath)) renameSync(temporaryPath, finalPath);
  else if (!existsSync(finalPath)) return reply.code(404).send({ error: "Attachment data is missing" });
  const finalized = database.finalizeAttachment(attachment.id, digest, finalKey);
  if (!finalized) return reply.code(409).send({ error: "Attachment could not be finalized" });
  return { attachment: finalized };
});

app.delete<{ Params: { id: string } }>("/api/attachments/:id", async (request, reply) => {
  const attachment = database.getAttachment(request.params.id);
  if (!attachment) return reply.code(204).send();
  if (attachment.status === "consumed") return reply.code(409).send({ error: "Attachment is already part of a message" });
  const filePath = path.join(config.attachmentDirectory, attachment.storageKey);
  if (existsSync(filePath)) unlinkSync(filePath);
  database.deleteAttachment(attachment.id);
  return reply.code(204).send();
});

app.get<{ Params: { id: string }; Querystring: { token?: string } }>("/agent/attachments/:id", async (request, reply) => {
  const attachment = database.getAttachment(request.params.id);
  if (!attachment || !request.query.token || !safeTokenEqual(request.query.token, attachment.downloadToken)) {
    return reply.code(404).send({ error: "Attachment not found" });
  }
  if (!["ready", "consumed"].includes(attachment.status)) return reply.code(409).send({ error: "Attachment is not ready" });
  const filePath = path.join(config.attachmentDirectory, attachment.storageKey);
  if (!existsSync(filePath)) return reply.code(404).send({ error: "Attachment data is missing" });
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
  const unsubscribe = events.subscribe((event) => {
    reply.raw.write(`id: ${event.revision}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const keepAlive = setInterval(() => reply.raw.write(": keep-alive\n\n"), 15_000);
  request.raw.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
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
    publish("run.updated", runId);
  }
  for (const [sessionId, presence] of uiPresence) {
    if (presence.seenAt < Date.now() - 45_000) uiPresence.delete(sessionId);
  }
  for (const attachment of database.listExpiredAttachments(currentTime)) {
    const filePath = path.join(config.attachmentDirectory, attachment.storageKey);
    if (existsSync(filePath)) unlinkSync(filePath);
    database.deleteAttachment(attachment.id);
  }
  database.cleanupNotifications(
    new Date(Date.now() - taskCenterPolicy.readRetentionDays * 24 * 60 * 60 * 1000).toISOString(),
    new Date(Date.now() - taskCenterPolicy.unreadRetentionDays * 24 * 60 * 60 * 1000).toISOString(),
  );
  database.cleanupUiEvents(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
}, Math.min(config.offlineAfterMs, 15_000));

const commandRetryTimer = setInterval(() => {
  for (const node of database.listNodes()) {
    if (node.status === "online") dispatchPending(node.id);
  }
}, 15_000);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "Shutting down control plane");
  clearInterval(staleTimer);
  clearInterval(commandRetryTimer);
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
