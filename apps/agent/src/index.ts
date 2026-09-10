import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import WebSocket from "ws";
import {
  CONTROL_PROTOCOL_VERSION,
  isRecord,
  parseControlMessage,
  toJsonValue,
  type AgentCommandAckMessage,
  type AgentToControlMessage,
  type AttachmentDescriptor,
  type ControlCommand,
  type DurableAgentPayload,
  type JsonValue,
  type ModelDescriptor,
  type ReasoningEffort,
  type RunProgressPhase,
} from "@controller-center/protocol";
import { AppServerClient, type AppServerNotification, type AppServerRequest, type RpcRequestId } from "./app-server-client.js";
import { loadConfig } from "./config.js";
import { AgentStateStore } from "./state-store.js";

const AGENT_VERSION = "0.1.0";

interface ActiveRun {
  conversationId: string;
  runId: string;
  workspaceId: string;
  threadId: string;
  turnId: string;
  lastProgressPhase?: string;
}

interface BufferedAssistantMessage {
  messageId: string;
  itemId: string;
  conversationId: string;
  runId: string;
  content: string;
  revision: number;
  timer: NodeJS.Timeout | null;
  complete: boolean;
}

interface PendingApproval {
  requestId: RpcRequestId;
  method: string;
  conversationId: string;
  runId?: string;
}

interface ThreadResult {
  thread?: { id?: string };
}

interface TurnResult {
  turn?: { id?: string; status?: string };
}

interface ModelListResult {
  data?: unknown[];
}

const config = loadConfig();
const bootId = randomUUID();
const state = new AgentStateStore(config.dataDirectory);
const appServer = new AppServerClient(config.codexBinary);
const conversationByThread = new Map<string, string>();
const loadedThreads = new Set<string>();
const activeRunsByTurn = new Map<string, ActiveRun>();
const workspaceLocks = new Map<string, string>();
const startingRunIds = new Set<string>();
const pendingApprovals = new Map<string, PendingApproval>();
const assistantMessages = new Map<string, BufferedAssistantMessage>();
let socket: WebSocket | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let attachmentCleanupTimer: NodeJS.Timeout | null = null;
let reconnectAttempt = 0;
let shuttingDown = false;
let appServerApprovalPolicy: "on-request" | "unlessTrusted" = "on-request";
let appServerSandboxMode: "workspace-write" | "workspaceWrite" = "workspace-write";
let availableModels: ModelDescriptor[] = [];

type AppServerUserInput =
  | { type: "text"; text: string; text_elements?: never[] }
  | { type: "localImage"; path: string }
  | { type: "localAudio"; path: string }
  | { type: "mention"; name: string; path: string };

function timestamp(): string {
  return new Date().toISOString();
}

function codexVersion(): string {
  try {
    return execFileSync(config.codexBinary, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

function send(message: AgentToControlMessage): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function sendAck(commandId: string, status: AgentCommandAckMessage["status"], error?: string): void {
  send({ type: "agent.commandAck", commandId, status, ...(error ? { error } : {}) });
}

function flushOutbox(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  for (const message of state.pendingMessages()) send(message);
}

function emitDurable(payload: DurableAgentPayload): void {
  send(state.enqueue(bootId, payload));
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function nestedString(value: unknown, objectKey: string, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  return stringField(value[objectKey], key);
}

const reasoningEffortValues = new Set<ReasoningEffort>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function parseModelCatalog(result: ModelListResult): ModelDescriptor[] {
  if (!Array.isArray(result.data)) return [];
  return result.data.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = typeof entry.id === "string" ? entry.id : typeof entry.model === "string" ? entry.model : "";
    if (!id) return [];
    const supportedReasoningEfforts = Array.isArray(entry.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts.flatMap((option) => {
          if (!isRecord(option) || typeof option.reasoningEffort !== "string" || !reasoningEffortValues.has(option.reasoningEffort as ReasoningEffort)) return [];
          return [{
            reasoningEffort: option.reasoningEffort as ReasoningEffort,
            ...(typeof option.description === "string" ? { description: option.description } : {}),
          }];
        })
      : [];
    const defaultReasoningEffort = typeof entry.defaultReasoningEffort === "string"
      && reasoningEffortValues.has(entry.defaultReasoningEffort as ReasoningEffort)
      ? entry.defaultReasoningEffort as ReasoningEffort
      : undefined;
    return [{
      id,
      displayName: typeof entry.displayName === "string" ? entry.displayName : id,
      isDefault: entry.isDefault === true,
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      supportedReasoningEfforts,
    }];
  });
}

function contextFor(params: unknown): { threadId?: string; turnId?: string; conversationId?: string; run?: ActiveRun } {
  const threadId = stringField(params, "threadId") ?? nestedString(params, "thread", "id");
  const turnId = stringField(params, "turnId") ?? nestedString(params, "turn", "id");
  let run = turnId ? activeRunsByTurn.get(turnId) : undefined;
  if (!run && threadId) run = [...activeRunsByTurn.values()].find((candidate) => candidate.threadId === threadId);
  const conversationId = run?.conversationId ?? (threadId ? conversationByThread.get(threadId) : undefined);
  return {
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(run ? { run } : {}),
  };
}

function reportProgress(run: ActiveRun, phase: RunProgressPhase, label: string): void {
  if (run.lastProgressPhase === phase) return;
  run.lastProgressPhase = phase;
  emitDurable({
    type: "run.progress",
    conversationId: run.conversationId,
    runId: run.runId,
    phase,
    label,
    occurredAt: timestamp(),
  });
}

function flushAssistantMessage(message: BufferedAssistantMessage, complete = message.complete): void {
  if (message.timer) clearTimeout(message.timer);
  message.timer = null;
  message.complete = complete;
  if (!message.content && !complete) return;
  message.revision += 1;
  emitDurable({
    type: "message.snapshot",
    messageId: message.messageId,
    conversationId: message.conversationId,
    runId: message.runId,
    role: "assistant",
    revision: message.revision,
    content: message.content,
    complete,
    occurredAt: timestamp(),
  });
  if (complete) assistantMessages.delete(`${message.runId}:${message.itemId}`);
}

function appendAssistantDelta(run: ActiveRun, itemId: string, delta: string): void {
  const key = `${run.runId}:${itemId}`;
  let message = assistantMessages.get(key);
  if (!message) {
    message = {
      messageId: `${run.runId}:${itemId}`,
      itemId,
      conversationId: run.conversationId,
      runId: run.runId,
      content: "",
      revision: 0,
      timer: null,
      complete: false,
    };
    assistantMessages.set(key, message);
  }
  message.content += delta;
  if (Buffer.byteLength(message.content) >= (message.revision + 1) * 2048) {
    flushAssistantMessage(message, false);
  } else if (!message.timer) {
    message.timer = setTimeout(() => flushAssistantMessage(message!, false), 250);
  }
}

function completeAssistantMessage(run: ActiveRun, item: Record<string, unknown>): void {
  const itemId = typeof item.id === "string" ? item.id : randomUUID();
  const key = `${run.runId}:${itemId}`;
  let message = assistantMessages.get(key);
  if (!message) {
    message = {
      messageId: `${run.runId}:${itemId}`,
      itemId,
      conversationId: run.conversationId,
      runId: run.runId,
      content: "",
      revision: 0,
      timer: null,
      complete: false,
    };
    assistantMessages.set(key, message);
  }
  if (typeof item.text === "string") message.content = item.text;
  flushAssistantMessage(message, true);
}

function flushRunMessages(runId: string): void {
  for (const message of [...assistantMessages.values()]) {
    if (message.runId === runId) flushAssistantMessage(message, true);
  }
}

function handleNotification(notification: AppServerNotification): void {
  const context = contextFor(notification.params);
  const params = isRecord(notification.params) ? notification.params : null;
  const item = params && isRecord(params.item) ? params.item : null;

  if (context.run) {
    if (notification.method === "turn/plan/updated") reportProgress(context.run, "analyzing", "正在分析任务");
    if (notification.method === "item/started") {
      const itemType = stringField(item, "type");
      if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch"].includes(itemType ?? "")) {
        reportProgress(context.run, "working", "正在处理任务");
      }
    }
    if (notification.method === "item/completed") {
      const itemType = stringField(item, "type");
      if (itemType === "agentMessage" && item) {
        reportProgress(context.run, "finalizing", "正在整理回复");
        completeAssistantMessage(context.run, item);
      } else if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(itemType ?? "")) {
        reportProgress(context.run, "verifying", "正在验证结果");
      }
    }
    if (notification.method === "item/agentMessage/delta") {
      const itemId = stringField(notification.params, "itemId") ?? "response";
      const delta = stringField(notification.params, "delta") ?? "";
      reportProgress(context.run, "finalizing", "正在整理回复");
      if (delta) appendAssistantDelta(context.run, itemId, delta);
    }
  }

  if (notification.method === "turn/completed" && context.run) {
    flushRunMessages(context.run.runId);
    const statusValue = nestedString(notification.params, "turn", "status");
    const status = statusValue === "interrupted" ? "interrupted" : statusValue === "failed" ? "failed" : "completed";
    const turn = isRecord(notification.params) && isRecord(notification.params.turn) ? notification.params.turn : undefined;
    const error = turn && isRecord(turn.error) ? String(turn.error.message ?? "Codex run failed") : undefined;
    emitDurable({
      type: "run.finished",
      conversationId: context.run.conversationId,
      runId: context.run.runId,
      threadId: context.run.threadId,
      turnId: context.run.turnId,
      status,
      ...(error ? { error } : {}),
      finishedAt: timestamp(),
    });
    activeRunsByTurn.delete(context.run.turnId);
    if (workspaceLocks.get(context.run.workspaceId) === context.run.runId) {
      workspaceLocks.delete(context.run.workspaceId);
    }
  }

  if (notification.method === "serverRequest/resolved") {
    const resolvedRequestId = stringField(notification.params, "requestId");
    if (!resolvedRequestId) return;
    const entry = [...pendingApprovals.entries()].find(([, pending]) => String(pending.requestId) === resolvedRequestId);
    if (entry) {
      emitDurable({ type: "interaction.resolved", approvalId: entry[0], response: null, resolvedAt: timestamp() });
      pendingApprovals.delete(entry[0]);
    }
  }
}

const remotelyResolvableMethods = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "item/permissions/requestApproval",
  "mcpServer/elicitation/request",
]);

function oneLine(value: unknown, fallback: string, maxLength = 220): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return fallback;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function interactionPresentation(request: AppServerRequest): { summary: string; risk?: string; details: JsonValue } {
  const params = isRecord(request.params) ? request.params : {};
  if (request.method === "item/commandExecution/requestApproval") {
    const command = oneLine(params.command, "一条本地命令");
    return {
      summary: `执行命令：${command}`,
      risk: oneLine(params.reason, "该命令将在所选节点的工作区环境中执行。"),
      details: { kind: "command" },
    };
  }
  if (request.method === "item/fileChange/requestApproval") {
    return {
      summary: "允许 Codex 修改工作区文件",
      risk: oneLine(params.reason, "修改只发生在当前节点的所选工作区。"),
      details: { kind: "fileChange" },
    };
  }
  if (request.method === "item/tool/requestUserInput") {
    const questions = Array.isArray(params.questions) ? params.questions.map((value, index) => {
      const question = isRecord(value) ? value : {};
      const options = Array.isArray(question.options) ? question.options.map((option) => {
        const item = isRecord(option) ? option : {};
        return {
          label: oneLine(item.label, "选项", 80),
          description: oneLine(item.description, "", 180),
        };
      }) : [];
      return {
        id: oneLine(question.id, String(index), 80),
        header: oneLine(question.header, "需要输入", 80),
        question: oneLine(question.question, "请提供所需信息", 300),
        isSecret: question.isSecret === true,
        options,
      };
    }) : [];
    return { summary: "Codex 需要你补充信息", details: toJsonValue({ kind: "userInput", questions }) };
  }
  if (request.method === "item/permissions/requestApproval") {
    return {
      summary: "Codex 请求额外权限",
      risk: oneLine(params.reason, "请确认该权限是否是完成当前任务所必需的。"),
      details: toJsonValue({ kind: "permissions", permissions: params.permissions ?? {} }),
    };
  }
  if (request.method === "mcpServer/elicitation/request") {
    return {
      summary: oneLine(params.message, `${oneLine(params.serverName, "MCP 服务")} 需要你的输入`, 300),
      risk: "信息将提交给发起请求的 MCP 服务。",
      details: toJsonValue({
        kind: "mcpElicitation",
        mode: params.mode ?? "form",
        ...(typeof params.url === "string" ? { url: params.url } : {}),
      }),
    };
  }
  return {
    summary: "Codex 需要你的确认",
    risk: "请仅在确认当前任务需要该操作时继续。",
    details: { kind: "confirmation" },
  };
}

function handleServerRequest(request: AppServerRequest): void {
  if (!remotelyResolvableMethods.has(request.method)) {
    appServer.respondError(request.id, -32601, `Controller Center cannot handle ${request.method}`);
    return;
  }
  const context = contextFor(request.params);
  if (!context.threadId || !context.conversationId) {
    appServer.respondError(request.id, -32000, "No Controller Center conversation is bound to this request");
    return;
  }
  const approvalId = randomUUID();
  pendingApprovals.set(approvalId, {
    requestId: request.id,
    method: request.method,
    conversationId: context.conversationId,
    ...(context.run ? { runId: context.run.runId } : {}),
  });
  const presentation = interactionPresentation(request);
  const payload = {
    type: "interaction.requested" as const,
    approvalId,
    conversationId: context.conversationId,
    ...(context.run ? { runId: context.run.runId } : {}),
    threadId: context.threadId,
    ...(context.turnId ? { turnId: context.turnId } : {}),
    method: request.method,
    requestId: String(request.id),
    summary: presentation.summary,
    ...(presentation.risk ? { risk: presentation.risk } : {}),
    details: presentation.details,
    requestedAt: timestamp(),
  };
  emitDurable(payload);
}

appServer.on("notification", (notification: AppServerNotification) => handleNotification(notification));
appServer.on("serverRequest", (request: AppServerRequest) => handleServerRequest(request));
appServer.on("stderr", (message: string) => process.stderr.write(`[codex] ${message}`));
appServer.on("clientError", (error: Error) => console.error("[agent] app-server error", error.message));
appServer.on("exit", (error: Error) => {
  loadedThreads.clear();
  for (const run of activeRunsByTurn.values()) {
    flushRunMessages(run.runId);
    emitDurable({
      type: "run.finished",
      conversationId: run.conversationId,
      runId: run.runId,
      threadId: run.threadId,
      turnId: run.turnId,
      status: "failed",
      error: error.message,
      finishedAt: timestamp(),
    });
  }
  activeRunsByTurn.clear();
  startingRunIds.clear();
  workspaceLocks.clear();
  pendingApprovals.clear();
});

function workspaceFor(id: string) {
  const workspace = config.workspaces.find((candidate) => candidate.id === id);
  if (!workspace) throw new Error(`Workspace is not allowed on this node: ${id}`);
  return workspace;
}

async function ensureThreadLoaded(threadId: string): Promise<void> {
  if (loadedThreads.has(threadId)) return;
  await appServer.request("thread/resume", { threadId });
  loadedThreads.add(threadId);
}

async function startThread(workspacePath: string, model?: string): Promise<ThreadResult> {
  const flavors = [
    { approvalPolicy: appServerApprovalPolicy, sandbox: appServerSandboxMode },
    { approvalPolicy: "unlessTrusted" as const, sandbox: "workspaceWrite" as const },
  ].filter((value, index, all) => all.findIndex((candidate) => candidate.approvalPolicy === value.approvalPolicy && candidate.sandbox === value.sandbox) === index);
  let lastError: unknown;
  for (const flavor of flavors) {
    try {
      const result = await appServer.request<ThreadResult>("thread/start", {
        cwd: workspacePath,
        approvalPolicy: flavor.approvalPolicy,
        sandbox: flavor.sandbox,
        serviceName: "controller_center",
        ...(model ? { model } : {}),
      });
      appServerApprovalPolicy = flavor.approvalPolicy;
      appServerSandboxMode = flavor.sandbox;
      return result;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("unknown variant")) throw error;
    }
  }
  throw lastError;
}

function attachmentDownloadUrl(attachment: AttachmentDescriptor): string {
  const url = new URL(config.controlUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = `/agent/attachments/${attachment.id}`;
  url.search = "";
  url.searchParams.set("token", attachment.downloadToken);
  return url.toString();
}

async function prepareAttachmentInputs(attachments: AttachmentDescriptor[] = []): Promise<AppServerUserInput[]> {
  if (attachments.length === 0) return [];
  const directory = path.join(config.dataDirectory, "attachments");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const inputs: AppServerUserInput[] = [];
  for (const attachment of attachments) {
    const safeName = path.basename(attachment.name).replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 120) || "attachment";
    const finalPath = path.join(directory, `${attachment.id}-${safeName}`);
    let validCache = false;
    if (existsSync(finalPath)) {
      validCache = createHash("sha256").update(readFileSync(finalPath)).digest("hex") === attachment.sha256;
      if (!validCache) unlinkSync(finalPath);
    }
    if (!validCache) {
      const response = await fetch(attachmentDownloadUrl(attachment));
      if (!response.ok) throw new Error(`无法下载附件 ${attachment.name} (${response.status})`);
      const content = Buffer.from(await response.arrayBuffer());
      if (content.length !== attachment.size) throw new Error(`附件大小校验失败：${attachment.name}`);
      const digest = createHash("sha256").update(content).digest("hex");
      if (digest !== attachment.sha256) throw new Error(`附件哈希校验失败：${attachment.name}`);
      const temporaryPath = `${finalPath}.tmp-${process.pid}`;
      writeFileSync(temporaryPath, content, { mode: 0o600 });
      renameSync(temporaryPath, finalPath);
    }
    if (attachment.mediaType.startsWith("image/")) inputs.push({ type: "localImage", path: finalPath });
    else if (attachment.mediaType.startsWith("audio/")) inputs.push({ type: "localAudio", path: finalPath });
    else inputs.push({ type: "mention", name: attachment.name, path: finalPath });
  }
  return inputs;
}

function cleanupAttachmentCache(): void {
  const directory = path.join(config.dataDirectory, "attachments");
  if (!existsSync(directory)) return;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of readdirSync(directory)) {
    const filePath = path.join(directory, name);
    try { if (statSync(filePath).isFile() && statSync(filePath).mtimeMs < cutoff) unlinkSync(filePath); }
    catch (error) { console.warn("[agent] unable to clean attachment cache", error instanceof Error ? error.message : error); }
  }
}

async function startTurnForConversation(input: {
  commandId: string;
  conversationId: string;
  runId: string;
  workspaceId: string;
  threadId: string;
  prompt: string;
  model?: string;
  effort?: ReasoningEffort;
  attachments?: AttachmentDescriptor[];
}): Promise<void> {
  if (activeRunsByTurn.size + startingRunIds.size >= config.maxConcurrentRuns) throw new Error("Node concurrency limit reached");
  const workspace = workspaceFor(input.workspaceId);
  if (workspaceLocks.has(workspace.id)) throw new Error(`Workspace is busy: ${workspace.name}`);
  workspaceLocks.set(input.workspaceId, input.runId);
  startingRunIds.add(input.runId);
  try {
    conversationByThread.set(input.threadId, input.conversationId);
    await ensureThreadLoaded(input.threadId);
    const attachmentInputs = await prepareAttachmentInputs(input.attachments);
    const result = await appServer.request<TurnResult>("turn/start", {
      threadId: input.threadId,
      input: [{ type: "text", text: input.prompt, text_elements: [] }, ...attachmentInputs],
      cwd: workspace.path,
      approvalPolicy: appServerApprovalPolicy,
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [workspace.path],
        networkAccess: config.networkAccess,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
    });
    const turnId = result.turn?.id;
    if (!turnId) throw new Error("turn/start did not return a turn id");
    const active: ActiveRun = {
      conversationId: input.conversationId,
      runId: input.runId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId,
    };
    activeRunsByTurn.set(turnId, active);
    emitDurable({
      type: "run.started",
      commandId: input.commandId,
      conversationId: input.conversationId,
      runId: input.runId,
      threadId: input.threadId,
      turnId,
      startedAt: timestamp(),
    });
    reportProgress(active, "analyzing", "正在分析任务");
  } catch (error) {
    if (workspaceLocks.get(input.workspaceId) === input.runId) workspaceLocks.delete(input.workspaceId);
    throw error;
  } finally {
    startingRunIds.delete(input.runId);
  }
}

async function executeCommand(commandId: string, command: ControlCommand): Promise<void> {
  await appServer.start();
  switch (command.type) {
    case "conversation.create": {
      const workspace = workspaceFor(command.workspaceId);
      const result = await startThread(workspace.path, command.model);
      const threadId = result.thread?.id;
      if (!threadId) throw new Error("thread/start did not return a thread id");
      conversationByThread.set(threadId, command.conversationId);
      loadedThreads.add(threadId);
      try {
        await appServer.request("thread/name/set", { threadId, name: command.title });
      } catch (error) {
        console.warn("[agent] unable to set thread name", error instanceof Error ? error.message : error);
      }
      emitDurable({
        type: "conversation.bound",
        commandId,
        conversationId: command.conversationId,
        threadId,
      });
      break;
    }
    case "conversation.start": {
      if (activeRunsByTurn.size >= config.maxConcurrentRuns) throw new Error("Node concurrency limit reached");
      const workspace = workspaceFor(command.workspaceId);
      if (workspaceLocks.has(workspace.id)) throw new Error(`Workspace is busy: ${workspace.name}`);
      const result = await startThread(workspace.path, command.model);
      const threadId = result.thread?.id;
      if (!threadId) throw new Error("thread/start did not return a thread id");
      conversationByThread.set(threadId, command.conversationId);
      loadedThreads.add(threadId);
      try {
        await appServer.request("thread/name/set", { threadId, name: command.title });
      } catch (error) {
        console.warn("[agent] unable to set thread name", error instanceof Error ? error.message : error);
      }
      emitDurable({
        type: "conversation.bound",
        commandId,
        conversationId: command.conversationId,
        threadId,
      });
      await startTurnForConversation({
        commandId,
        conversationId: command.conversationId,
        runId: command.runId,
        workspaceId: command.workspaceId,
        threadId,
        prompt: command.prompt,
        ...(command.model ? { model: command.model } : {}),
        ...(command.effort ? { effort: command.effort } : {}),
        ...(command.attachments ? { attachments: command.attachments } : {}),
      });
      break;
    }
    case "conversation.delete":
      await appServer.request("thread/delete", { threadId: command.threadId });
      conversationByThread.delete(command.threadId);
      loadedThreads.delete(command.threadId);
      break;
    case "run.start": {
      await startTurnForConversation({
        commandId,
        conversationId: command.conversationId,
        runId: command.runId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        prompt: command.prompt,
        ...(command.model ? { model: command.model } : {}),
        ...(command.effort ? { effort: command.effort } : {}),
        ...(command.attachments ? { attachments: command.attachments } : {}),
      });
      break;
    }
    case "run.steer": {
      const attachmentInputs = await prepareAttachmentInputs(command.attachments);
      await appServer.request("turn/steer", {
        threadId: command.threadId,
        expectedTurnId: command.turnId,
        input: [{ type: "text", text: command.prompt, text_elements: [] }, ...attachmentInputs],
      });
      break;
    }
    case "run.interrupt":
      await appServer.request("turn/interrupt", { threadId: command.threadId, turnId: command.turnId });
      break;
    case "approval.resolve": {
      const pending = pendingApprovals.get(command.approvalId);
      if (!pending) throw new Error("Approval is no longer pending in the local app-server session");
      appServer.respond(pending.requestId, command.response);
      pendingApprovals.delete(command.approvalId);
      emitDurable({
        type: "interaction.resolved",
        approvalId: command.approvalId,
        response: command.response,
        resolvedAt: timestamp(),
      });
      break;
    }
  }
}

async function handleCommand(commandId: string, command: ControlCommand): Promise<void> {
  const existing = state.beginCommand(commandId, command);
  if (existing) {
    if (existing.status === "completed") sendAck(commandId, "completed");
    else if (existing.status === "failed" || existing.status === "uncertain") {
      const error = existing.error ?? "Command state is uncertain after an agent restart";
      sendAck(commandId, "failed", error);
      const fatalContext = existing.command.type === "conversation.start"
        ? { conversationId: existing.command.conversationId, runId: existing.command.runId }
        : existing.command.type === "conversation.create"
        ? { conversationId: existing.command.conversationId }
        : existing.command.type === "run.start"
          ? { conversationId: existing.command.conversationId, runId: existing.command.runId }
          : {};
      emitDurable({
        type: "agent.error",
        commandId,
        ...fatalContext,
        message: error,
        occurredAt: timestamp(),
      });
    } else {
      sendAck(commandId, "accepted");
    }
    return;
  }

  sendAck(commandId, "accepted");
  try {
    await executeCommand(commandId, command);
    state.finishCommand(commandId);
    sendAck(commandId, "completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.finishCommand(commandId, message);
    sendAck(commandId, "failed", message);
    const fatalContext = command.type === "conversation.start"
      ? { conversationId: command.conversationId, runId: command.runId }
      : command.type === "conversation.create"
      ? { conversationId: command.conversationId }
      : command.type === "run.start"
        ? { conversationId: command.conversationId, runId: command.runId }
        : {};
    emitDurable({
      type: "agent.error",
      commandId,
      ...fatalContext,
      message,
      occurredAt: timestamp(),
    });
  }
}

function connect(): void {
  if (shuttingDown) return;
  const nextSocket = new WebSocket(config.controlUrl, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  socket = nextSocket;

  nextSocket.on("open", () => {
    reconnectAttempt = 0;
    send({
      type: "agent.hello",
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      bootId,
      node: {
        id: config.nodeId,
        name: config.nodeName,
        platform: os.platform(),
        arch: os.arch(),
        agentVersion: AGENT_VERSION,
        codexVersion: codexVersion(),
        maxConcurrentRuns: config.maxConcurrentRuns,
        workspaces: config.workspaces,
        models: availableModels,
      },
    });
  });

  nextSocket.on("message", (data) => {
    try {
      const message = parseControlMessage(data.toString());
      if (message.type === "control.welcome") {
        flushOutbox();
        emitDurable({
          type: "agent.stateReport",
          activeRuns: [...activeRunsByTurn.values()].map((run) => ({
            conversationId: run.conversationId,
            runId: run.runId,
            threadId: run.threadId,
            turnId: run.turnId,
            workspaceId: run.workspaceId,
          })),
          reportedAt: timestamp(),
        });
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          send({
            type: "agent.heartbeat",
            bootId,
            activeRuns: activeRunsByTurn.size,
            sentAt: timestamp(),
          });
        }, message.heartbeatIntervalMs);
      } else if (message.type === "control.deliveryAck") {
        state.acknowledge(message.bootId, message.sequence);
      } else if (message.type === "control.command") {
        void handleCommand(message.commandId, message.command);
      } else if (message.type === "control.error") {
        console.error(`[control] ${message.code}: ${message.message}`);
      }
    } catch (error) {
      console.error("[agent] invalid control message", error instanceof Error ? error.message : error);
    }
  });

  nextSocket.on("close", (code, reason) => {
    if (socket === nextSocket) socket = null;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (shuttingDown) return;
    const baseDelay = Math.min(30_000, 1_000 * 2 ** reconnectAttempt++);
    const delay = baseDelay + Math.floor(Math.random() * 500);
    console.warn(`[agent] control connection closed (${code} ${reason.toString()}); reconnecting in ${delay}ms`);
    reconnectTimer = setTimeout(connect, delay);
  });

  nextSocket.on("error", (error) => console.error("[agent] websocket error", error.message));
}

function shutdown(): void {
  shuttingDown = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (attachmentCleanupTimer) clearInterval(attachmentCleanupTimer);
  socket?.close(1000, "Agent shutting down");
  appServer.close();
  state.close();
}

process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });

console.log(`[agent] node ${config.nodeName} (${config.nodeId})`);
console.log(`[agent] workspaces: ${config.workspaces.map((workspace) => `${workspace.name}=${workspace.path}`).join(", ")}`);

async function bootstrap(): Promise<void> {
  cleanupAttachmentCache();
  attachmentCleanupTimer = setInterval(cleanupAttachmentCache, 60 * 60 * 1000);
  try {
    await appServer.start();
    availableModels = parseModelCatalog(await appServer.request<ModelListResult>("model/list", {
      limit: 100,
      includeHidden: false,
    }));
    console.log(`[agent] models: ${availableModels.map((model) => model.displayName).join(", ") || "local default"}`);
  } catch (error) {
    console.warn("[agent] unable to discover models; using local default", error instanceof Error ? error.message : error);
  }
  connect();
}

void bootstrap();
