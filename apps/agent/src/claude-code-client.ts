import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isRecord, type RunErrorCode } from "@controller-center/protocol";
import type {
  CanUseTool,
  ElicitationRequest,
  ModelInfo,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  AppServerRpcError,
  type AppServerNotification,
  type AppServerRequest,
  type ClassifiedAppServerError,
  type RpcRequestId,
  type ThreadTokenUsageSummary,
} from "./app-server-client.js";

/** The subset of AppServerClient that the Agent uses; both runtimes implement it. */
export interface RuntimeClient extends EventEmitter {
  start(): Promise<void>;
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  respond(id: RpcRequestId, result: unknown): void;
  respondError(id: RpcRequestId, code: number, message: string): void;
  close(): void;
}

type ClaudeSdk = typeof import("@anthropic-ai/claude-agent-sdk");
type UserContentBlock = Exclude<SDKUserMessage["message"]["content"], string>[number];

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const INLINE_IMAGE_TYPES: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
// Larger images are referenced by path so Claude Code can read and downscale them.
const MAX_INLINE_IMAGE_BYTES = 3_500_000;
const INTERRUPT_GRACE_MS = 15_000;
// How long a finished turn's CLI may keep running before it is stopped.
const PROCESS_EXIT_GRACE_MS = 3_000;
// Upper bound for waiting on a previous process or an interrupt request, so a
// stuck SDK call cannot block the thread forever.
const PROCESS_WAIT_LIMIT_MS = 15_000;
const DENIED_BY_USER = "The user denied this request in Controller Center.";

function oneLineMessage(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return fallback;
  return text.length > 260 ? `${text.slice(0, 260)}…` : text;
}

function withRawMessage(summary: string, raw: string): string {
  return raw && raw !== summary ? `${summary}：${raw}` : summary;
}

/** Convert Claude Code / Claude API failures into the same product-facing categories as Codex. */
export function classifyClaudeCodeError(input: unknown): ClassifiedAppServerError {
  const envelope = isRecord(input) ? input : {};
  const error = isRecord(envelope.error) ? envelope.error : envelope;
  const rawMessage = oneLineMessage(error.message, "");
  const type = typeof error.claudeErrorType === "string" ? error.claudeErrorType : "";
  const httpStatusCode = typeof error.httpStatusCode === "number" ? error.httpStatusCode : null;
  const text = rawMessage.toLowerCase();
  let code: RunErrorCode = "unknown";
  let summary = "Claude Code 执行失败";
  let retryMessage = "Claude 暂时出错，正在自动重试";

  if (/prompt is too long|context window|context length|maximum context|too many tokens/.test(text)) {
    code = "context_window_exceeded";
    summary = "当前上下文已超出模型限制，请先压缩上下文后再继续";
    retryMessage = "上下文空间不足，Claude 正在尝试恢复";
  } else if (["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "cloud_credential_error"].includes(type)
    || httpStatusCode === 401 || httpStatusCode === 403
    || /invalid api key|run \/login|not logged in|oauth token/.test(text)) {
    code = "authentication_failed";
    summary = "节点上的 Claude Code 登录已失效或无权访问，请在节点重新登录";
    retryMessage = "Claude 登录状态异常，正在尝试恢复";
  } else if (type === "billing_error" || /usage limit|hit your limit|(?<!rate )limit reached|credit balance|extra usage/.test(text)) {
    code = "usage_limit_exceeded";
    summary = "Claude 使用额度已耗尽或计费不可用，请等待额度恢复或检查账户";
    retryMessage = "Claude 使用额度暂时受限，正在重试";
  } else if (type === "rate_limit" || httpStatusCode === 429) {
    code = "rate_limit_exceeded";
    summary = "Claude 请求频率受限，请稍后重试";
    retryMessage = "Claude 请求频率受限，正在自动重试";
  } else if (type === "overloaded" || type === "server_error" || httpStatusCode !== null && httpStatusCode >= 500) {
    code = "service_unavailable";
    summary = "Claude 服务暂时不可用，请稍后重试";
    retryMessage = "Claude 服务暂时不可用，正在自动重试";
  } else if (type === "model_not_found") {
    code = "invalid_request";
    summary = "所选 Claude 模型不可用，请更换模型后重试";
    retryMessage = "Claude 正在重新尝试当前请求";
  } else if (type === "invalid_request") {
    code = "invalid_request";
    summary = "Claude 无法处理当前请求";
    retryMessage = "Claude 正在重新尝试当前请求";
  } else if (type === "refusal") {
    code = "policy_blocked";
    summary = "该请求被 Claude 安全策略拒绝";
    retryMessage = "Claude 正在重新检查请求";
  } else if (type === "error_max_turns" || type === "error_max_budget_usd") {
    code = "session_budget_exceeded";
    summary = "当前任务已达到执行轮次或预算限制";
    retryMessage = "任务预算暂时受限，Claude 正在重试";
  } else if (type === "active_turn_busy") {
    code = "active_turn_busy";
    summary = "当前会话正在压缩或执行其他操作，暂时不能追加指令";
    retryMessage = "当前会话暂时忙碌，Claude 正在等待继续";
  } else if (type === "spawn_failed") {
    code = "service_unavailable";
    summary = "无法启动节点上的 Claude Code，请确认已安装并可执行";
    retryMessage = "Claude Code 暂时无法启动，正在重试";
  } else if (/econnreset|etimedout|socket hang up|fetch failed|network error|connection (?:reset|closed|error)|stream (?:closed|ended|interrupted|error)/.test(text)) {
    code = "stream_interrupted";
    summary = "Claude 响应连接中断，请稍后重试";
    retryMessage = "Claude 响应连接中断，正在自动重试";
  } else if (type === "max_output_tokens") {
    summary = "Claude 回复超出单次最大输出长度";
  }

  return {
    code,
    message: withRawMessage(summary, rawMessage),
    retryMessage,
    rawMessage,
    willRetry: envelope.willRetry === true,
    httpStatusCode,
  };
}

/** Map a Claude Code tool to the Codex item type that drives run progress. */
export function toolItemType(toolName: string): string {
  if (toolName === "Bash" || toolName === "BashOutput" || toolName === "KillShell") return "commandExecution";
  if (FILE_EDIT_TOOLS.has(toolName)) return "fileChange";
  if (toolName.startsWith("mcp__")) return "mcpToolCall";
  if (toolName === "WebSearch" || toolName === "WebFetch") return "webSearch";
  if (toolName === "Task" || toolName === "Agent") return "collabAgentToolCall";
  return "dynamicToolCall";
}

function stringInput(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function briefInput(input: Record<string, unknown>): string {
  const preferred = stringInput(input, "url") ?? stringInput(input, "query") ?? stringInput(input, "file_path")
    ?? stringInput(input, "path") ?? stringInput(input, "pattern") ?? stringInput(input, "description");
  if (preferred) return preferred;
  const json = JSON.stringify(input);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}

/** Key under which "allow for this conversation" is remembered; null means never remembered. */
export function sessionApprovalKey(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === "AskUserQuestion") return null;
  if (toolName === "Bash") return `Bash:${stringInput(input, "command") ?? ""}`;
  if (FILE_EDIT_TOOLS.has(toolName)) return "fileChange";
  return `tool:${toolName}`;
}

/** Present a Claude Code permission prompt as one of the Codex requests the Web already renders. */
export function approvalRequest(
  toolName: string,
  input: Record<string, unknown>,
  context: { toolUseID: string; decisionReason?: string; blockedPath?: string },
): { method: string; params: Record<string, unknown> } {
  if (toolName === "Bash") {
    const reason = [stringInput(input, "description"), context.decisionReason].filter(Boolean).join(" · ");
    return {
      method: "item/commandExecution/requestApproval",
      params: { itemId: context.toolUseID, command: stringInput(input, "command") ?? "", ...(reason ? { reason } : {}) },
    };
  }
  if (FILE_EDIT_TOOLS.has(toolName)) {
    const target = context.blockedPath ?? stringInput(input, "file_path") ?? stringInput(input, "notebook_path");
    return {
      method: "item/fileChange/requestApproval",
      params: { itemId: context.toolUseID, ...(target ? { reason: `${toolName}：${target}` } : {}) },
    };
  }
  if (toolName === "AskUserQuestion") {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    return {
      method: "item/tool/requestUserInput",
      params: {
        itemId: context.toolUseID,
        questions: questions.map((value, index) => {
          const question = isRecord(value) ? value : {};
          return {
            id: String(index),
            header: question.header,
            question: question.question,
            isSecret: false,
            options: Array.isArray(question.options) ? question.options : [],
          };
        }),
      },
    };
  }
  return {
    method: "item/permissions/requestApproval",
    params: {
      itemId: context.toolUseID,
      reason: `${toolName}：${briefInput(input)}`,
      permissions: { tool: toolName },
    },
  };
}

/** Translate the Web's Codex-shaped answer back into a Claude Code permission decision. */
export function permissionFromResponse(
  method: string,
  input: Record<string, unknown>,
  response: unknown,
): { result: PermissionResult; rememberForSession: boolean } {
  const deny = { result: { behavior: "deny" as const, message: DENIED_BY_USER }, rememberForSession: false };
  if (!isRecord(response)) return deny;
  if (method === "item/tool/requestUserInput") {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const provided = isRecord(response.answers) ? response.answers : {};
    const answers: Record<string, string> = {};
    questions.forEach((value, index) => {
      const question = isRecord(value) && typeof value.question === "string" ? value.question : "";
      const entry = provided[String(index)];
      const values = isRecord(entry) && Array.isArray(entry.answers)
        ? entry.answers.filter((answer): answer is string => typeof answer === "string")
        : [];
      if (question && values.length > 0) answers[question] = values.join(", ");
    });
    if (Object.keys(answers).length === 0) return deny;
    return { result: { behavior: "allow", updatedInput: { ...input, answers } }, rememberForSession: false };
  }
  if (method === "item/permissions/requestApproval") {
    const granted = isRecord(response.permissions) && Object.keys(response.permissions).length > 0;
    if (!granted) return deny;
    return { result: { behavior: "allow", updatedInput: input }, rememberForSession: response.scope === "session" };
  }
  if (response.decision === "accept" || response.decision === "acceptForSession") {
    return { result: { behavior: "allow", updatedInput: input }, rememberForSession: response.decision === "acceptForSession" };
  }
  return deny;
}

/** Find an executable the way a shell would, because the SDK expects a path. */
export function resolveExecutable(binary: string, searchPath = process.env.PATH ?? ""): string | null {
  const candidates = binary.includes("/") ? [path.resolve(binary)] : searchPath.split(path.delimiter).filter(Boolean)
    .map((directory) => path.join(directory, binary));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

/**
 * Claude Code refuses bypassPermissions as root unless the host declares a
 * sandbox. --yolo is the operator's explicit opt-in, so declare it for the
 * Claude child process only, and keep any value the operator already set.
 */
export function needsSandboxDeclaration(yolo: boolean, uid = process.getuid?.(), environment: NodeJS.ProcessEnv = process.env): boolean {
  return yolo && uid === 0 && environment.IS_SANDBOX === undefined;
}

let shadowWarningSuppressed = false;

/**
 * In bypassPermissions mode the SDK warns on every query that canUseTool is
 * shadowed, yet Claude Code still routes AskUserQuestion through it, which the
 * Agent relies on. Drop only that warning so --yolo logs stay readable.
 */
function suppressShadowedCanUseToolWarning(): void {
  if (shadowWarningSuppressed) return;
  shadowWarningSuppressed = true;
  const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const options = rest[0];
    if (isRecord(options) && options.code === "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED") return;
    emitWarning(warning, ...rest);
  }) as typeof process.emitWarning;
}

function withinLimit<T>(promise: Promise<T> | undefined, fallback: T): Promise<T> {
  if (!promise) return Promise.resolve(fallback);
  let timer: NodeJS.Timeout | null = null;
  return Promise.race([
    promise.finally(() => { if (timer) clearTimeout(timer); }),
    new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), PROCESS_WAIT_LIMIT_MS); }),
  ]);
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): boolean {
    if (this.closed) return false;
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = null;
      waiting({ value: message, done: false });
    } else {
      this.items.push(message);
    }
    return true;
  }

  close(): void {
    this.closed = true;
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.waiting = resolve; });
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

interface ClaudeThreadRecord {
  cwd: string;
  model?: string;
  title?: string;
  usage?: ThreadTokenUsageSummary;
  createdAt: string;
}

/** Persists which Claude Code sessions this Agent created and their last known usage. */
class ClaudeThreadStore {
  private readonly filePath: string;
  private readonly threads = new Map<string, ClaudeThreadRecord>();

  constructor(dataDirectory: string) {
    this.filePath = path.join(dataDirectory, "claude-threads.json");
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      const threads = isRecord(parsed) && isRecord(parsed.threads) ? parsed.threads : {};
      for (const [id, value] of Object.entries(threads)) {
        if (SESSION_ID_PATTERN.test(id) && isRecord(value) && typeof value.cwd === "string") {
          this.threads.set(id, value as unknown as ClaudeThreadRecord);
        }
      }
    } catch (error) {
      console.warn("[agent] unable to read Claude thread registry", error instanceof Error ? error.message : error);
    }
  }

  get(threadId: string): ClaudeThreadRecord | undefined {
    return this.threads.get(threadId);
  }

  set(threadId: string, record: ClaudeThreadRecord): void {
    this.threads.set(threadId, record);
    this.save();
  }

  delete(threadId: string): void {
    if (this.threads.delete(threadId)) this.save();
  }

  save(): void {
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, threads: Object.fromEntries(this.threads) }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }
}

interface TurnError {
  message: string;
  claudeErrorType?: string;
  httpStatusCode?: number | null;
}

interface ActiveTurn {
  threadId: string;
  turnId: string;
  kind: "turn" | "compact";
  input: MessageQueue;
  query: Query | null;
  abortController: AbortController;
  completed: boolean;
  interruptRequested: boolean;
  interruptTimer: NodeJS.Timeout | null;
  lastError?: TurnError;
  mainModel?: string;
  stderrTail: string;
  currentMessageId?: string | undefined;
  callInputTokens: number;
  turnTokens: number;
  turnOutputTokens: number;
  lastContextTokens?: number;
  streamTextItems: Map<string, string>;
  streamTextCount: Map<string, number>;
  completedTextCount: Map<string, number>;
  toolTypes: Map<string, string>;
  compactError?: string;
}

interface PendingInteraction {
  resolve: (response: unknown) => void;
  threadId: string;
  turnId: string;
}

/**
 * Drives the local Claude Code CLI through the Claude Agent SDK while speaking
 * the Codex App Server method and notification names the Agent already uses.
 * Each turn runs one Claude Code process that resumes the thread's session.
 */
export class ClaudeCodeClient extends EventEmitter implements RuntimeClient {
  private sdk: ClaudeSdk | null = null;
  private executablePath: string | null = null;
  private readonly threads: ClaudeThreadStore;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly sessionApprovals = new Map<string, Set<string>>();
  private readonly processExits = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly claudeBinary: string,
    private readonly yolo: boolean,
    private readonly dataDirectory: string,
  ) {
    super();
    this.threads = new ClaudeThreadStore(dataDirectory);
  }

  async start(): Promise<void> {
    if (this.sdk && this.executablePath) return;
    this.executablePath = resolveExecutable(this.claudeBinary);
    if (!this.executablePath) {
      throw new Error(`找不到 Claude Code 可执行文件 ${this.claudeBinary}；请安装并登录 Claude Code，或通过 CLAUDE_BIN 指定路径`);
    }
    // Loaded lazily so Codex nodes never load the SDK.
    this.sdk = await import("@anthropic-ai/claude-agent-sdk");
    if (this.yolo) suppressShadowedCanUseToolWarning();
    if (needsSandboxDeclaration(this.yolo)) {
      console.warn("[agent] Claude Code 以 root 运行全权限模式：已为 Claude 子进程设置 IS_SANDBOX=1");
    }
  }

  async request<T = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    await this.start();
    const input = isRecord(params) ? params : {};
    switch (method) {
      case "thread/unsubscribe":
        return {} as T;
      case "thread/start":
        return this.startThread(input) as T;
      case "thread/resume":
        return this.resumeThread(input) as Promise<T>;
      case "thread/name/set":
        return this.setThreadName(input) as Promise<T>;
      case "thread/delete":
        return this.deleteThread(input) as Promise<T>;
      case "thread/compact/start":
        return this.startCompaction(input) as Promise<T>;
      case "turn/start":
        return this.startTurn(input) as Promise<T>;
      case "turn/steer":
        return this.steerTurn(input) as Promise<T>;
      case "turn/interrupt":
        return this.interruptTurn(input) as Promise<T>;
      case "model/list":
        return { data: await this.listModels(timeoutMs) } as T;
      case "claude/usage/read":
        return this.readUsage(timeoutMs) as Promise<T>;
      default:
        throw new AppServerRpcError(`Claude Code runtime does not support ${method}`, -32601, null);
    }
  }

  respond(id: RpcRequestId, result: unknown): void {
    const pending = this.pendingInteractions.get(String(id));
    if (!pending) return;
    this.pendingInteractions.delete(String(id));
    pending.resolve(result);
  }

  respondError(id: RpcRequestId): void {
    this.respond(id, null);
  }

  close(): void {
    this.closed = true;
    for (const turn of this.activeTurns.values()) {
      turn.input.close();
      turn.abortController.abort();
    }
    for (const id of [...this.pendingInteractions.keys()]) this.respond(id, null);
  }

  private notification(method: string, params: Record<string, unknown>): void {
    this.emit("notification", { method, params } satisfies AppServerNotification);
  }

  private requireThreadId(input: Record<string, unknown>): string {
    const threadId = typeof input.threadId === "string" ? input.threadId : "";
    if (!SESSION_ID_PATTERN.test(threadId)) throw new Error("无效的 Claude Code 会话 ID");
    return threadId;
  }

  private startThread(input: Record<string, unknown>): { thread: { id: string } } {
    const cwd = typeof input.cwd === "string" ? input.cwd : "";
    if (!cwd) throw new Error("thread/start requires cwd");
    // Claude Code accepts a caller-chosen session ID, so the Controller Center
    // thread ID and the Claude session ID stay identical.
    const threadId = randomUUID();
    this.threads.set(threadId, {
      cwd,
      ...(typeof input.model === "string" && input.model ? { model: input.model } : {}),
      createdAt: new Date().toISOString(),
    });
    return { thread: { id: threadId } };
  }

  private threadRecord(threadId: string): ClaudeThreadRecord {
    const existing = this.threads.get(threadId);
    if (existing) return existing;
    throw new Error("该会话不是由当前节点的 Claude Code 运行时创建（可能是 Codex 会话或已被删除），无法继续；请新建会话");
  }

  private async sessionExists(threadId: string, cwd: string): Promise<boolean> {
    return Boolean(await this.sdk!.getSessionInfo(threadId, { dir: cwd }).catch(() => undefined));
  }

  private async resumeThread(input: Record<string, unknown>): Promise<{ thread: { id: string } }> {
    const threadId = this.requireThreadId(input);
    const record = this.threadRecord(threadId);
    // Codex reports stored usage when a thread is loaded; the Agent's backfill relies on that.
    if (record.usage) {
      const usage = record.usage;
      setImmediate(() => this.emitTokenUsage(threadId, undefined, usage));
    }
    return { thread: { id: threadId } };
  }

  private async setThreadName(input: Record<string, unknown>): Promise<Record<string, never>> {
    const threadId = this.requireThreadId(input);
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const record = this.threadRecord(threadId);
    if (!name) return {};
    this.threads.set(threadId, { ...record, title: name });
    if (await this.sessionExists(threadId, record.cwd)) {
      await this.sdk!.renameSession(threadId, name, { dir: record.cwd });
    }
    return {};
  }

  private async deleteThread(input: Record<string, unknown>): Promise<Record<string, never>> {
    const threadId = this.requireThreadId(input);
    const active = this.activeTurns.get(threadId);
    if (active) {
      active.interruptRequested = true;
      active.input.close();
      active.abortController.abort();
    }
    // An exiting CLI still appends session metadata; delete after it is gone.
    await withinLimit(this.processExits.get(threadId), undefined);
    const record = this.threads.get(threadId);
    if (record && await this.sessionExists(threadId, record.cwd)) {
      await this.sdk!.deleteSession(threadId, { dir: record.cwd });
    }
    this.threads.delete(threadId);
    this.sessionApprovals.delete(threadId);
    return {};
  }

  private busyError(message: string): Error {
    return Object.assign(new Error(message), { errorCode: "active_turn_busy" as RunErrorCode });
  }

  private async startTurn(input: Record<string, unknown>): Promise<{ turn: { id: string; status: string } }> {
    const threadId = this.requireThreadId(input);
    if (this.activeTurns.has(threadId)) throw this.busyError("当前会话已有任务在执行，请等待完成或先中止");
    const record = this.threadRecord(threadId);
    const content = this.userContent(input.input);
    const turn = this.createTurn(threadId, "turn");
    turn.input.push(this.userMessage(content));
    // As on a Codex thread, an explicit model also applies to later turns that omit one.
    if (typeof input.model === "string" && input.model && input.model !== record.model) {
      record.model = input.model;
      this.threads.set(threadId, { ...(this.threads.get(threadId) ?? record), model: input.model });
    }
    const model = record.model && record.model !== "default" ? record.model : undefined;
    const effort = typeof input.effort === "string" && EFFORT_LEVELS.has(input.effort) ? input.effort as Options["effort"] : undefined;
    const fastMode = input.serviceTier === undefined ? undefined : input.serviceTier !== "default";
    this.launchTurn(turn, record, {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(fastMode !== undefined ? { settings: { fastMode } } : {}),
    });
    return { turn: { id: turn.turnId, status: "inProgress" } };
  }

  private async startCompaction(input: Record<string, unknown>): Promise<Record<string, never>> {
    const threadId = this.requireThreadId(input);
    if (this.activeTurns.has(threadId)) throw this.busyError("当前会话已有任务在执行，暂时不能压缩上下文");
    const record = this.threadRecord(threadId);
    if (!await this.sessionExists(threadId, record.cwd)) throw new Error("当前会话还没有可压缩的上下文");
    const turn = this.createTurn(threadId, "compact");
    turn.input.push(this.userMessage([{ type: "text", text: "/compact" }]));
    this.launchTurn(turn, record, {});
    return {};
  }

  private async steerTurn(input: Record<string, unknown>): Promise<Record<string, never>> {
    const threadId = this.requireThreadId(input);
    const turn = this.activeTurns.get(threadId);
    if (!turn || turn.kind !== "turn" || turn.completed || turn.turnId !== input.expectedTurnId) {
      throw this.busyError("当前任务已结束或正在进行其他操作，无法追加指令");
    }
    // Claude Code folds queued messages into the running turn between tool rounds.
    if (!turn.input.push(this.userMessage(this.userContent(input.input)))) {
      throw this.busyError("当前任务正在结束，无法追加指令");
    }
    return {};
  }

  private async interruptTurn(input: Record<string, unknown>): Promise<Record<string, never>> {
    const threadId = this.requireThreadId(input);
    const turn = this.activeTurns.get(threadId);
    if (!turn || turn.completed || typeof input.turnId === "string" && input.turnId !== turn.turnId) return {};
    turn.interruptRequested = true;
    this.cancelInteractions(turn);
    turn.interruptTimer ??= setTimeout(() => {
      // Give up waiting for the interrupted turn's result and stop the process.
      turn.input.close();
      turn.abortController.abort();
    }, INTERRUPT_GRACE_MS);
    await withinLimit(turn.query?.interrupt().catch(() => undefined), undefined);
    return {};
  }

  private createTurn(threadId: string, kind: ActiveTurn["kind"]): ActiveTurn {
    const turn: ActiveTurn = {
      threadId,
      turnId: randomUUID(),
      kind,
      input: new MessageQueue(),
      query: null,
      abortController: new AbortController(),
      completed: false,
      interruptRequested: false,
      interruptTimer: null,
      stderrTail: "",
      callInputTokens: 0,
      turnTokens: 0,
      turnOutputTokens: 0,
      streamTextItems: new Map(),
      streamTextCount: new Map(),
      completedTextCount: new Map(),
      toolTypes: new Map(),
    };
    this.activeTurns.set(threadId, turn);
    return turn;
  }

  private launchTurn(turn: ActiveTurn, record: ClaudeThreadRecord, turnOptions: Partial<Options>): void {
    // As with Codex, the caller must receive the turn id before any of its notifications.
    setImmediate(() => {
      this.notification("turn/started", { threadId: turn.threadId, turn: { id: turn.turnId } });
      void this.runTurn(turn, record, turnOptions);
    });
  }

  private userContent(value: unknown): UserContentBlock[] {
    const items = Array.isArray(value) ? value : [];
    const content: UserContentBlock[] = [];
    for (const item of items) {
      if (!isRecord(item)) continue;
      if (item.type === "text" && typeof item.text === "string") {
        content.push({ type: "text", text: item.text });
        continue;
      }
      const filePath = typeof item.path === "string" ? item.path : "";
      if (!filePath) continue;
      const mediaType = INLINE_IMAGE_TYPES[path.extname(filePath).toLowerCase()];
      if (item.type === "localImage" && mediaType) {
        try {
          if (statSync(filePath).size <= MAX_INLINE_IMAGE_BYTES) {
            content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: readFileSync(filePath).toString("base64") } });
            continue;
          }
        } catch {
          // Fall back to referencing the path.
        }
      }
      const name = typeof item.name === "string" && item.name ? item.name : path.basename(filePath);
      content.push({ type: "text", text: `Attached file: ${name} (${filePath})` });
    }
    if (content.length === 0) throw new Error("消息内容为空");
    return content;
  }

  private userMessage(content: UserContentBlock[]): SDKUserMessage {
    return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid: randomUUID() };
  }

  private async runTurn(turn: ActiveTurn, record: ClaudeThreadRecord, turnOptions: Partial<Options>): Promise<void> {
    // Two Claude Code processes must never write the same session file, so a
    // turn starts only after the thread's previous process has exited.
    const previousExit = this.processExits.get(turn.threadId);
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => { markExited = resolve; });
    this.processExits.set(turn.threadId, exited);
    let exitTimer: NodeJS.Timeout | null = null;
    try {
      await withinLimit(previousExit, undefined);
      const exists = await this.sessionExists(turn.threadId, record.cwd);
      // Interrupted or deleted before the process started; finally reports it.
      if (turn.completed || turn.interruptRequested) return;
      // A thread that already used tokens must have a transcript; never start an
      // empty session under its ID, which would silently drop the history.
      if (!exists && (record.usage?.totalTokens ?? 0) > 0) {
        throw new Error("节点上的 Claude Code 会话记录已不存在（可能已在本机删除），无法继续；请新建会话");
      }
      const options: Options = {
        cwd: record.cwd,
        pathToClaudeCodeExecutable: this.executablePath!,
        abortController: turn.abortController,
        ...(exists ? { resume: turn.threadId } : { sessionId: turn.threadId, ...(record.title ? { title: record.title } : {}) }),
        systemPrompt: { type: "preset", preset: "claude_code" },
        includePartialMessages: true,
        additionalDirectories: [path.join(this.dataDirectory, "attachments")],
        permissionMode: this.yolo ? "bypassPermissions" : "acceptEdits",
        ...(this.yolo ? { allowDangerouslySkipPermissions: true } : {}),
        // `env` replaces the child environment, so pass it only when adding to it.
        ...(needsSandboxDeclaration(this.yolo) ? { env: { ...process.env, IS_SANDBOX: "1" } } : {}),
        canUseTool: (toolName, toolInput, context) => this.canUseTool(turn, toolName, toolInput, context),
        onElicitation: (request, context) => this.elicit(turn, request, context.signal),
        stderr: (data) => {
          turn.stderrTail = `${turn.stderrTail}${data}`.slice(-2_000);
          this.emit("stderr", data);
        },
        ...turnOptions,
      };
      const query = this.sdk!.query({ prompt: turn.input, options });
      turn.query = query;
      for await (const message of query) {
        this.handleMessage(turn, record, message);
        // Once the turn is reported its input is closed, so an idle CLI exits on
        // its own; keep draining until it does. Stop it if it lingers on
        // background work or messages queued before an interrupt, which must
        // not leak into the thread's next turn.
        if (turn.completed && !exitTimer) {
          exitTimer = setTimeout(() => turn.abortController.abort(), turn.interruptRequested ? 0 : PROCESS_EXIT_GRACE_MS);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stderr = turn.stderrTail.trim();
      turn.lastError ??= {
        message: stderr && !message.includes(stderr) ? `${message}；${stderr}` : message,
        ...(/ENOENT|EACCES|spawn/i.test(message) ? { claudeErrorType: "spawn_failed" } : {}),
      };
    } finally {
      if (exitTimer) clearTimeout(exitTimer);
      turn.query?.close();
      if (!turn.completed) {
        this.completeTurn(turn, turn.interruptRequested ? "interrupted" : "failed", turn.interruptRequested ? undefined : turn.lastError ?? {
          message: ["Claude Code 进程意外结束", turn.stderrTail.trim()].filter(Boolean).join("："),
        });
      }
      markExited();
      if (this.processExits.get(turn.threadId) === exited) this.processExits.delete(turn.threadId);
    }
  }

  private handleMessage(turn: ActiveTurn, record: ClaudeThreadRecord, message: SDKMessage): void {
    if (turn.completed) return;
    const { threadId, turnId } = turn;
    if (message.type === "system") {
      if (message.subtype === "init") {
        turn.mainModel = message.model;
      } else if (message.subtype === "api_retry") {
        this.notification("error", {
          threadId,
          turnId,
          willRetry: true,
          error: { message: message.error, claudeErrorType: message.error, httpStatusCode: message.error_status },
        });
      } else if (message.subtype === "status") {
        if (message.status === "compacting" && turn.kind === "turn") {
          this.notification("item/started", { threadId, turnId, item: { type: "contextCompaction", id: `compaction:${turnId}` } });
        }
        if (message.compact_result === "failed") turn.compactError = message.compact_error || "上下文压缩失败";
      } else if (message.subtype === "compact_boundary") {
        if (message.compact_metadata.post_tokens !== undefined) turn.lastContextTokens = message.compact_metadata.post_tokens;
        if (turn.kind === "turn") {
          this.notification("item/completed", { threadId, turnId, item: { type: "contextCompaction", id: `compaction:${turnId}` } });
        }
      }
      return;
    }

    if (message.type === "stream_event") {
      // Subagent output stays inside its tool call, as Codex keeps it out of the reply.
      if (message.parent_tool_use_id !== null) return;
      this.handleStreamEvent(turn, record, message.event as unknown);
      return;
    }

    if (message.type === "assistant") {
      if (message.parent_tool_use_id === null) {
        if (message.error) {
          const text = message.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(" ");
          turn.lastError = { message: text || message.error, claudeErrorType: message.error };
          return;
        }
        // Claude Code recovered (e.g. after hitting the output limit); the earlier error no longer applies.
        delete turn.lastError;
      }
      for (const block of message.message.content) {
        if (block.type === "text" && message.parent_tool_use_id === null) {
          const count = turn.completedTextCount.get(message.message.id) ?? 0;
          turn.completedTextCount.set(message.message.id, count + 1);
          if (!block.text.trim()) continue;
          this.notification("item/completed", {
            threadId,
            turnId,
            item: { type: "agentMessage", id: `${message.message.id}:text:${count}`, text: block.text },
          });
        } else if (block.type === "tool_use") {
          const itemType = toolItemType(block.name);
          turn.toolTypes.set(block.id, itemType);
          if (block.name === "TodoWrite") this.notification("turn/plan/updated", { threadId, turnId });
          else this.notification("item/started", { threadId, turnId, item: { type: itemType, id: block.id } });
        }
      }
      return;
    }

    if (message.type === "user") {
      const content = message.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const itemType = turn.toolTypes.get(block.tool_use_id);
        if (itemType) this.notification("item/completed", { threadId, turnId, item: { type: itemType, id: block.tool_use_id } });
      }
      return;
    }

    if (message.type === "result") this.handleResult(turn, record, message);
  }

  private handleStreamEvent(turn: ActiveTurn, record: ClaudeThreadRecord, event: unknown): void {
    if (!isRecord(event)) return;
    if (event.type === "message_start" && isRecord(event.message)) {
      turn.currentMessageId = typeof event.message.id === "string" ? event.message.id : undefined;
      const usage = isRecord(event.message.usage) ? event.message.usage : {};
      turn.callInputTokens = nonNegativeInteger(usage.input_tokens)
        + nonNegativeInteger(usage.cache_creation_input_tokens)
        + nonNegativeInteger(usage.cache_read_input_tokens);
      return;
    }
    const messageId = turn.currentMessageId;
    if (!messageId) return;
    if (event.type === "content_block_start" && isRecord(event.content_block) && event.content_block.type === "text") {
      const count = turn.streamTextCount.get(messageId) ?? 0;
      turn.streamTextCount.set(messageId, count + 1);
      turn.streamTextItems.set(`${messageId}:${String(event.index)}`, `${messageId}:text:${count}`);
      return;
    }
    if (event.type === "content_block_delta" && isRecord(event.delta) && event.delta.type === "text_delta") {
      const itemId = turn.streamTextItems.get(`${messageId}:${String(event.index)}`);
      const delta = typeof event.delta.text === "string" ? event.delta.text : "";
      if (itemId && delta) this.notification("item/agentMessage/delta", { threadId: turn.threadId, turnId: turn.turnId, itemId, delta });
      return;
    }
    if (event.type === "message_delta" && isRecord(event.usage)) {
      const output = nonNegativeInteger(event.usage.output_tokens);
      turn.lastContextTokens = turn.callInputTokens + output;
      turn.turnTokens += turn.callInputTokens + output;
      turn.turnOutputTokens += output;
      const base = record.usage;
      this.emitTokenUsage(turn.threadId, turn.turnId, {
        totalTokens: (base?.totalTokens ?? 0) + turn.turnTokens,
        contextTokens: turn.lastContextTokens,
        modelContextWindow: base?.modelContextWindow ?? null,
        outputTokens: (base?.outputTokens ?? 0) + turn.turnOutputTokens,
        ...(base?.reasoningOutputTokens !== undefined ? { reasoningOutputTokens: base.reasoningOutputTokens } : {}),
      });
    }
  }

  private handleResult(turn: ActiveTurn, record: ClaudeThreadRecord, result: SDKResultMessage): void {
    this.recordUsage(turn, record, result);
    if (turn.kind === "turn" && !turn.interruptRequested && (result.queued_turn_count ?? 0) > 0) return;
    if (turn.interruptRequested) {
      this.completeTurn(turn, "interrupted");
      return;
    }
    const failed = result.subtype !== "success" || result.is_error || turn.compactError !== undefined;
    if (!failed) {
      this.completeTurn(turn, "completed");
      return;
    }
    const resultText = result.subtype === "success" ? result.result : result.errors.join("；");
    this.completeTurn(turn, "failed", {
      message: turn.compactError ?? (resultText || turn.lastError?.message || "Claude Code 未返回具体原因"),
      ...(turn.lastError?.claudeErrorType
        ? { claudeErrorType: turn.lastError.claudeErrorType }
        : result.subtype !== "success" ? { claudeErrorType: result.subtype } : {}),
      httpStatusCode: (result.subtype === "success" ? result.api_error_status : undefined) ?? turn.lastError?.httpStatusCode ?? null,
    });
  }

  private recordUsage(turn: ActiveTurn, record: ClaudeThreadRecord, result: SDKResultMessage): void {
    // modelUsage is cumulative for the session, including turns from earlier processes.
    const entries = Object.entries(result.modelUsage ?? {});
    let totalTokens = 0;
    let outputTokens = 0;
    let thinkingTokens: number | undefined;
    for (const [, usage] of entries) {
      totalTokens += nonNegativeInteger(usage.inputTokens) + nonNegativeInteger(usage.outputTokens)
        + nonNegativeInteger(usage.cacheReadInputTokens) + nonNegativeInteger(usage.cacheCreationInputTokens);
      outputTokens += nonNegativeInteger(usage.outputTokens);
      if (usage.thinkingTokens !== undefined) thinkingTokens = (thinkingTokens ?? 0) + nonNegativeInteger(usage.thinkingTokens);
    }
    const mainUsage = (turn.mainModel ? result.modelUsage?.[turn.mainModel] : undefined)
      ?? entries.map(([, usage]) => usage).sort((left, right) => right.contextWindow - left.contextWindow)[0];
    const previous = record.usage;
    const usage: ThreadTokenUsageSummary = {
      // Startup failures report zeroed totals; keep the last known values then.
      totalTokens: totalTokens > 0 ? totalTokens : previous?.totalTokens ?? 0,
      contextTokens: turn.lastContextTokens ?? previous?.contextTokens ?? 0,
      modelContextWindow: mainUsage && mainUsage.contextWindow > 0 ? mainUsage.contextWindow : previous?.modelContextWindow ?? null,
      outputTokens: totalTokens > 0 ? outputTokens : previous?.outputTokens ?? 0,
      ...(thinkingTokens !== undefined ? { reasoningOutputTokens: thinkingTokens }
        : previous?.reasoningOutputTokens !== undefined ? { reasoningOutputTokens: previous.reasoningOutputTokens } : {}),
    };
    turn.turnTokens = 0;
    turn.turnOutputTokens = 0;
    const current = this.threads.get(turn.threadId);
    if (current) {
      record.usage = usage;
      this.threads.set(turn.threadId, { ...current, usage });
    }
    this.emitTokenUsage(turn.threadId, turn.turnId, usage);
  }

  private emitTokenUsage(threadId: string, turnId: string | undefined, usage: ThreadTokenUsageSummary): void {
    this.notification("thread/tokenUsage/updated", {
      threadId,
      ...(turnId ? { turnId } : {}),
      tokenUsage: {
        total: {
          totalTokens: usage.totalTokens,
          ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
          ...(usage.reasoningOutputTokens !== undefined ? { reasoningOutputTokens: usage.reasoningOutputTokens } : {}),
        },
        last: { totalTokens: usage.contextTokens },
        modelContextWindow: usage.modelContextWindow,
      },
    });
  }

  private completeTurn(turn: ActiveTurn, status: "completed" | "failed" | "interrupted", error?: TurnError): void {
    if (turn.completed) return;
    turn.completed = true;
    if (turn.interruptTimer) clearTimeout(turn.interruptTimer);
    turn.input.close();
    this.cancelInteractions(turn);
    if (this.activeTurns.get(turn.threadId) === turn) this.activeTurns.delete(turn.threadId);
    if (this.closed) return;
    this.notification("turn/completed", {
      threadId: turn.threadId,
      turn: { id: turn.turnId, status, ...(error ? { error } : {}) },
    });
  }

  private cancelInteractions(turn: ActiveTurn): void {
    for (const [id, pending] of [...this.pendingInteractions]) {
      if (pending.turnId !== turn.turnId) continue;
      this.pendingInteractions.delete(id);
      pending.resolve(null);
      this.notification("serverRequest/resolved", { threadId: turn.threadId, requestId: id });
    }
  }

  private waitForInteraction(turn: ActiveTurn, method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (turn.completed || turn.interruptRequested || signal.aborted) return Promise.resolve(null);
    const id = `claude-${randomUUID()}`;
    return new Promise((resolve) => {
      this.pendingInteractions.set(id, { resolve, threadId: turn.threadId, turnId: turn.turnId });
      signal.addEventListener("abort", () => {
        if (!this.pendingInteractions.delete(id)) return;
        resolve(null);
        this.notification("serverRequest/resolved", { threadId: turn.threadId, requestId: id });
      }, { once: true });
      this.emit("serverRequest", {
        id,
        method,
        params: { threadId: turn.threadId, turnId: turn.turnId, ...params },
      } satisfies AppServerRequest);
    });
  }

  private async canUseTool(
    turn: ActiveTurn,
    toolName: string,
    input: Record<string, unknown>,
    context: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const approvalKey = sessionApprovalKey(toolName, input);
    const approvals = this.sessionApprovals.get(turn.threadId);
    if (approvalKey && approvals?.has(approvalKey)) return { behavior: "allow", updatedInput: input };
    const { method, params } = approvalRequest(toolName, input, {
      toolUseID: context.toolUseID,
      ...(context.decisionReason ? { decisionReason: context.decisionReason } : {}),
      ...(context.blockedPath ? { blockedPath: context.blockedPath } : {}),
    });
    const response = await this.waitForInteraction(turn, method, params, context.signal);
    const decision = permissionFromResponse(method, input, response);
    if (decision.rememberForSession && approvalKey) {
      const remembered = this.sessionApprovals.get(turn.threadId) ?? new Set<string>();
      remembered.add(approvalKey);
      this.sessionApprovals.set(turn.threadId, remembered);
    }
    return decision.result;
  }

  private async elicit(turn: ActiveTurn, request: ElicitationRequest, signal: AbortSignal) {
    const response = await this.waitForInteraction(turn, "mcpServer/elicitation/request", {
      serverName: request.serverName,
      message: request.message,
      mode: request.mode ?? "form",
      ...(request.url ? { url: request.url } : {}),
    }, signal);
    if (!isRecord(response) || response.action !== "accept") return { action: "decline" as const };
    type ElicitContent = Exclude<Awaited<ReturnType<NonNullable<Options["onElicitation"]>>>, null>["content"];
    return { action: "accept" as const, ...(isRecord(response.content) ? { content: response.content as ElicitContent } : {}) };
  }

  private async listModels(timeoutMs: number): Promise<Record<string, unknown>[]> {
    const models = await this.withIdleQuery("model list", timeoutMs, (query) => query.supportedModels());
    return models.map(modelCatalogEntry);
  }

  /** The account and the data behind `/usage`: plan rate-limit windows when the login has them. */
  private readUsage(timeoutMs: number) {
    return this.withIdleQuery("usage read", timeoutMs, async (query) => ({
      account: await query.accountInfo(),
      usage: await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
    }));
  }

  /** Runs control requests on a Claude Code process that never receives a prompt, so no turn is billed. */
  private async withIdleQuery<T>(label: string, timeoutMs: number, read: (query: Query) => Promise<T>): Promise<T> {
    const input = new MessageQueue();
    const query = this.sdk!.query({
      prompt: input,
      options: {
        cwd: this.dataDirectory,
        pathToClaudeCodeExecutable: this.executablePath!,
        settingSources: ["user"],
        persistSession: false,
        stderr: (data) => this.emit("stderr", data),
      },
    });
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        read(query),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Claude Code ${label} timed out`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      input.close();
      query.close();
    }
  }
}

/** Shape Claude Code's model list like Codex `model/list` entries for parseModelCatalog. */
export function modelCatalogEntry(model: ModelInfo): Record<string, unknown> {
  return {
    id: model.value,
    displayName: model.displayName,
    isDefault: model.value === "default",
    supportedReasoningEfforts: (model.supportedEffortLevels ?? []).map((reasoningEffort) => ({ reasoningEffort })),
    supportsFastMode: model.supportsFastMode === true,
    ...(model.supportsFastMode ? { fastServiceTier: "fast" } : {}),
  };
}
