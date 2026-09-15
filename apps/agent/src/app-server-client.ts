import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { isRecord, type RunErrorCode } from "@controller-center/protocol";

export interface ClassifiedAppServerError {
  code: RunErrorCode;
  message: string;
  retryMessage: string;
  rawMessage: string;
  willRetry: boolean;
  httpStatusCode: number | null;
}

export class AppServerRpcError extends Error {
  readonly code: number | null;
  readonly data: unknown;

  constructor(message: string, code: number | null, data: unknown) {
    super(message);
    this.name = "AppServerRpcError";
    this.code = code;
    this.data = data;
  }
}

function oneLineMessage(value: unknown, fallback = "Codex 执行失败"): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return fallback;
  return text.length > 260 ? `${text.slice(0, 260)}…` : text;
}

function errorInfoName(value: unknown): { name: string; httpStatusCode: number | null } {
  if (typeof value === "string") return { name: value, httpStatusCode: null };
  if (!isRecord(value)) return { name: "other", httpStatusCode: null };
  const [name, details] = Object.entries(value)[0] ?? ["other", null];
  const status = isRecord(details) && typeof details.httpStatusCode === "number"
    ? details.httpStatusCode
    : null;
  return { name, httpStatusCode: status };
}

function normalizedErrorName(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toLocaleLowerCase();
}

function withRawMessage(summary: string, raw: string): string {
  if (!raw || normalizedErrorName(raw) === normalizedErrorName(summary)) return summary;
  return `${summary}：${raw}`;
}

/** Convert App Server error notifications into stable product-facing categories. */
export function classifyAppServerError(input: unknown): ClassifiedAppServerError {
  const envelope = isRecord(input) ? input : {};
  const error = isRecord(envelope.error) ? envelope.error : envelope;
  const rawMessage = oneLineMessage(error.message);
  const info = errorInfoName(error.codexErrorInfo);
  const name = normalizedErrorName(info.name);
  const willRetry = envelope.willRetry === true;
  let code: RunErrorCode = "unknown";
  let summary = "Codex 执行失败";
  let retryMessage = "Codex 暂时出错，正在自动重试";

  if (name === "contextwindowexceeded") {
    code = "context_window_exceeded";
    summary = "当前上下文已超出模型限制，请先压缩上下文后再继续";
    retryMessage = "上下文空间不足，Codex 正在尝试恢复";
  } else if (name === "sessionbudgetexceeded") {
    code = "session_budget_exceeded";
    summary = "当前会话已达到执行预算限制";
    retryMessage = "会话预算暂时受限，Codex 正在重试";
  } else if (name === "usagelimitexceeded") {
    code = "usage_limit_exceeded";
    summary = "Codex 使用额度已耗尽，请等待额度恢复后重试";
    retryMessage = "Codex 使用额度暂时受限，正在重试";
  } else if (name === "ratelimitexceeded") {
    code = "rate_limit_exceeded";
    summary = "Codex 请求频率受限，请稍后重试";
    retryMessage = "Codex 请求频率受限，正在自动重试";
  } else if (name === "unauthorized") {
    code = "authentication_failed";
    summary = "节点上的 Codex 登录已失效，请在节点重新登录";
    retryMessage = "Codex 登录状态异常，正在尝试恢复";
  } else if (name === "serveroverloaded" || name === "httpconnectionfailed") {
    code = info.httpStatusCode === 401 || info.httpStatusCode === 403
      ? "authentication_failed"
      : "service_unavailable";
    summary = code === "authentication_failed"
      ? "节点上的 Codex 登录或访问权限已失效"
      : "暂时无法连接 Codex 服务，请稍后重试";
    retryMessage = "Codex 服务暂时不可用，正在自动重试";
  } else if (["responsestreamconnectionfailed", "responsestreamdisconnected", "responsetoomanyfailedattempts"].includes(name)) {
    code = "stream_interrupted";
    summary = "Codex 响应流连接中断，请稍后重试";
    retryMessage = "Codex 响应连接中断，正在自动重试";
  } else if (name === "sandboxerror") {
    code = "sandbox_failed";
    summary = "Codex 沙箱执行失败，请检查节点权限和工作空间";
    retryMessage = "Codex 沙箱暂时异常，正在自动重试";
  } else if (["cyberpolicy", "misalignmentpolicyviolation"].includes(name)) {
    code = "policy_blocked";
    summary = "该请求被 Codex 安全策略阻止";
    retryMessage = "Codex 正在重新检查请求";
  } else if (["badrequest", "threadrollbackfailed"].includes(name)) {
    code = "invalid_request";
    summary = "Codex 无法处理当前请求";
    retryMessage = "Codex 正在重新尝试当前请求";
  } else if (name === "activeturnnotsteerable") {
    code = "active_turn_busy";
    summary = "当前会话正在压缩或执行其他专用操作，暂时不能追加指令";
    retryMessage = "当前会话暂时忙碌，Codex 正在等待继续";
  } else if (name === "internalservererror") {
    code = "internal_error";
    summary = "Codex 内部服务异常，请稍后重试";
    retryMessage = "Codex 内部服务异常，正在自动重试";
  }

  return {
    code,
    message: withRawMessage(summary, rawMessage),
    retryMessage,
    rawMessage,
    willRetry,
    httpStatusCode: info.httpStatusCode,
  };
}

export interface ThreadTokenUsageSummary {
  totalTokens: number;
  contextTokens: number;
  modelContextWindow: number | null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Parse the stable subset of Codex's thread/tokenUsage/updated payload used by the UI. */
export function parseThreadTokenUsage(params: unknown): ThreadTokenUsageSummary | null {
  if (!isRecord(params) || !isRecord(params.tokenUsage)) return null;
  const total = params.tokenUsage.total;
  const last = params.tokenUsage.last;
  if (!isRecord(total) || !isRecord(last)) return null;
  const totalTokens = nonNegativeInteger(total.totalTokens);
  const contextTokens = nonNegativeInteger(last.totalTokens);
  const rawContextWindow = params.tokenUsage.modelContextWindow;
  const modelContextWindow = rawContextWindow === null
    ? null
    : nonNegativeInteger(rawContextWindow);
  if (totalTokens === null || contextTokens === null || modelContextWindow === null && rawContextWindow !== null) return null;
  return {
    totalTokens,
    contextTokens,
    modelContextWindow: modelContextWindow && modelContextWindow > 0 ? modelContextWindow : null,
  };
}

export type RpcRequestId = string | number;

interface RpcPending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface AppServerNotification {
  method: string;
  params: unknown;
}

export interface AppServerRequest extends AppServerNotification {
  id: RpcRequestId;
}

export type AppServerApprovalPolicy = "on-request" | "never";
export type ThreadSandboxMode = "workspace-write" | "danger-full-access";
export type TurnSandboxPolicy =
  | { type: "dangerFullAccess" }
  | {
    type: "workspaceWrite";
    writableRoots: string[];
    networkAccess: boolean;
    excludeTmpdirEnvVar: boolean;
    excludeSlashTmp: boolean;
  };

export function threadStartSecurity(yolo: boolean): {
  approvalPolicy: AppServerApprovalPolicy;
  sandbox: ThreadSandboxMode;
} {
  return yolo
    ? { approvalPolicy: "never", sandbox: "danger-full-access" }
    : { approvalPolicy: "on-request", sandbox: "workspace-write" };
}

export function turnSandboxPolicy(yolo: boolean, workspacePath: string, networkAccess: boolean): TurnSandboxPolicy {
  return yolo
    ? { type: "dangerFullAccess" }
    : {
      type: "workspaceWrite",
      writableRoots: [workspacePath],
      networkAccess,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
}

export function appServerArguments(yolo: boolean): string[] {
  return yolo ? ["--yolo", "app-server", "--stdio"] : ["app-server", "--stdio"];
}

export class AppServerClient extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<RpcRequestId, RpcPending>();
  private starting: Promise<void> | null = null;

  constructor(private readonly codexBinary: string, private readonly yolo = false) {
    super();
  }

  async start(): Promise<void> {
    if (this.process) return;
    if (this.starting) return this.starting;
    this.starting = this.startInternal();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startInternal(): Promise<void> {
    const child = spawn(this.codexBinary, appServerArguments(this.yolo), {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.process = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.onLine(line));
    child.stderr.on("data", (chunk: Buffer) => this.emit("stderr", chunk.toString()));
    // A binary that exits during initialization can close stdin before the
    // child "exit" event is observed. Always consume the stream error so an
    // EPIPE cannot terminate the Agent process.
    child.stdin.on("error", (error) => this.emit("clientError", error));
    child.on("error", (error) => this.emit("clientError", error));
    child.on("exit", (code, signal) => {
      if (this.process !== child) return;
      this.process = null;
      const error = new Error(`codex app-server exited (${code ?? signal ?? "unknown"})`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
      this.emit("exit", error);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "controller_center_agent",
        title: "Controller Center Agent",
        version: "0.3.7",
      },
    });
    this.notify("initialized", {});
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("clientError", new Error(`Invalid JSON from app-server: ${line.slice(0, 200)}`));
      return;
    }
    if (!isRecord(message)) return;

    if (typeof message.method === "string") {
      const notification = { method: message.method, params: message.params ?? {} };
      if (typeof message.id === "string" || typeof message.id === "number") {
        this.emit("serverRequest", { ...notification, id: message.id } satisfies AppServerRequest);
      } else {
        this.emit("notification", notification satisfies AppServerNotification);
      }
      return;
    }

    if (typeof message.id !== "string" && typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (isRecord(message.error)) {
      pending.reject(new AppServerRpcError(
        String(message.error.message ?? "Unknown app-server error"),
        typeof message.error.code === "number" ? message.error.code : null,
        message.error.data,
      ));
    } else {
      pending.resolve(message.result);
    }
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.process) return Promise.reject(new Error("codex app-server is not running"));
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout });
      this.write({ method, id, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  respond(id: RpcRequestId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RpcRequestId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private write(message: unknown): void {
    if (!this.process) throw new Error("codex app-server is not running");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    const child = this.process;
    this.process = null;
    child?.kill("SIGTERM");
  }
}
