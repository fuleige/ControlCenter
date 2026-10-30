import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type {
  AgentQuotaMessage,
  AgentQuotaResetMessage,
  AgentWorkspaceFileMessage,
  AgentWorkspaceValidationMessage,
  ControlCommandMessage,
  ControlToAgentMessage,
  ManagedWorkspaceDescriptor,
} from "@controller-center/protocol";

interface AgentConnection {
  socket: WebSocket;
  bootId: string;
  capabilities: ReadonlySet<string>;
}

interface PendingWorkspaceValidation {
  nodeId: string;
  timer: NodeJS.Timeout;
  resolve: (result: AgentWorkspaceValidationMessage) => void;
  reject: (error: Error) => void;
}

interface PendingWorkspaceFileRead {
  nodeId: string;
  timer: NodeJS.Timeout;
  resolve: (result: AgentWorkspaceFileMessage) => void;
  reject: (error: Error) => void;
}

type AgentReply = AgentQuotaMessage | AgentQuotaResetMessage;

interface PendingAgentRequest {
  nodeId: string;
  replyType: AgentReply["type"];
  timer: NodeJS.Timeout;
  resolve: (result: AgentReply) => void;
  reject: (error: Error) => void;
}

export class AgentConnections {
  onDisconnect: ((nodeId: string) => void) | null = null;

  isCurrent(nodeId: string, socket: WebSocket): boolean { return this.connections.get(nodeId)?.socket === socket; }
  private readonly connections = new Map<string, AgentConnection>();
  private readonly workspaceValidations = new Map<string, PendingWorkspaceValidation>();
  private readonly workspaceFileReads = new Map<string, PendingWorkspaceFileRead>();
  private readonly agentRequests = new Map<string, PendingAgentRequest>();

  private rejectWorkspaceValidations(nodeId: string, message: string): void {
    for (const [requestId, pending] of this.workspaceValidations) {
      if (pending.nodeId !== nodeId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.workspaceValidations.delete(requestId);
    }
  }

  private rejectWorkspaceFileReads(nodeId: string, message: string): void {
    for (const [requestId, pending] of this.workspaceFileReads) {
      if (pending.nodeId !== nodeId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.workspaceFileReads.delete(requestId);
    }
  }

  private rejectAgentRequests(nodeId: string, message: string): void {
    for (const [requestId, pending] of this.agentRequests) {
      if (pending.nodeId !== nodeId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.agentRequests.delete(requestId);
    }
  }

  private rejectPendingRequests(nodeId: string, message: string): void {
    this.rejectWorkspaceValidations(nodeId, message);
    this.rejectWorkspaceFileReads(nodeId, message);
    this.rejectAgentRequests(nodeId, message);
  }

  set(nodeId: string, bootId: string, socket: WebSocket, capabilities: readonly string[] = []): void {
    const previous = this.connections.get(nodeId);
    if (previous && previous.socket !== socket) {
      this.onDisconnect?.(nodeId);
      this.rejectPendingRequests(nodeId, "节点连接已被新的会话替换");
      previous.socket.close(4001, "Replaced by a newer session");
    }
    this.connections.set(nodeId, { socket, bootId, capabilities: new Set(capabilities) });
  }

  remove(nodeId: string, socket: WebSocket): boolean {
    const connection = this.connections.get(nodeId);
    if (!connection || connection.socket !== socket) return false;
    this.connections.delete(nodeId);
    this.onDisconnect?.(nodeId);
    this.rejectPendingRequests(nodeId, "节点已离线");
    return true;
  }

  has(nodeId: string): boolean {
    const connection = this.connections.get(nodeId);
    return Boolean(connection && connection.socket.readyState === connection.socket.OPEN);
  }

  hasCapability(nodeId: string, capability: string): boolean {
    const connection = this.connections.get(nodeId);
    return Boolean(connection
      && connection.socket.readyState === connection.socket.OPEN
      && connection.capabilities.has(capability));
  }

  close(nodeId: string, code = 4000, reason = "Connection expired"): void {
    const connection = this.connections.get(nodeId);
    if (!connection) return;
    this.connections.delete(nodeId);
    this.onDisconnect?.(nodeId);
    this.rejectPendingRequests(nodeId, "节点连接已关闭");
    connection.socket.close(code, reason);
  }

  closeAll(): void {
    for (const [nodeId, connection] of this.connections) {
      this.connections.delete(nodeId);
      this.onDisconnect?.(nodeId);
      this.rejectPendingRequests(nodeId, "控制中心正在关闭");
      connection.socket.terminate();
    }
  }

  send(nodeId: string, message: ControlToAgentMessage): boolean {
    const connection = this.connections.get(nodeId);
    if (!connection || connection.socket.readyState !== connection.socket.OPEN) return false;
    connection.socket.send(JSON.stringify(message));
    return true;
  }

  sendCommand(nodeId: string, message: ControlCommandMessage): boolean {
    return this.send(nodeId, message);
  }

  syncWorkspaces(nodeId: string, workspaces: ManagedWorkspaceDescriptor[]): boolean {
    return this.send(nodeId, { type: "control.workspaceSync", workspaces });
  }

  validateWorkspace(nodeId: string, path: string, timeoutMs = 10_000): Promise<AgentWorkspaceValidationMessage> {
    if (!this.has(nodeId)) return Promise.reject(new Error("节点当前离线"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.workspaceValidations.delete(requestId);
        reject(new Error("节点验证工作空间超时"));
      }, timeoutMs);
      this.workspaceValidations.set(requestId, { nodeId, timer, resolve, reject });
      if (!this.send(nodeId, { type: "control.workspaceValidate", requestId, path })) {
        clearTimeout(timer);
        this.workspaceValidations.delete(requestId);
        reject(new Error("节点当前离线"));
      }
    });
  }

  resolveWorkspaceValidation(nodeId: string, message: AgentWorkspaceValidationMessage): boolean {
    const pending = this.workspaceValidations.get(message.requestId);
    if (!pending || pending.nodeId !== nodeId) return false;
    clearTimeout(pending.timer);
    this.workspaceValidations.delete(message.requestId);
    pending.resolve(message);
    return true;
  }

  readWorkspaceFile(
    nodeId: string,
    workspaceId: string,
    requestedPath: string,
    basePath: string | undefined,
    maxBytes: number,
    timeoutMs = 15_000,
  ): Promise<AgentWorkspaceFileMessage> {
    if (!this.has(nodeId)) return Promise.reject(new Error("节点当前离线"));
    const activeReads = [...this.workspaceFileReads.values()].filter((pending) => pending.nodeId === nodeId).length;
    if (activeReads >= 4) return Promise.reject(new Error("节点文件读取请求过多，请稍后再试"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.workspaceFileReads.delete(requestId);
        reject(new Error("节点读取文件超时"));
      }, timeoutMs);
      this.workspaceFileReads.set(requestId, { nodeId, timer, resolve, reject });
      if (!this.send(nodeId, {
        type: "control.workspaceFileRead",
        requestId,
        workspaceId,
        path: requestedPath,
        ...(basePath ? { basePath } : {}),
        maxBytes,
      })) {
        clearTimeout(timer);
        this.workspaceFileReads.delete(requestId);
        reject(new Error("节点当前离线"));
      }
    });
  }

  /** Sends a request whose answer the Agent tags with the same requestId. */
  private requestAgent<T extends AgentReply>(
    nodeId: string,
    message: (requestId: string) => ControlToAgentMessage,
    replyType: T["type"],
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    if (!this.has(nodeId)) return Promise.reject(new Error("节点当前离线"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.agentRequests.delete(requestId);
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      this.agentRequests.set(requestId, { nodeId, replyType, timer, resolve: resolve as (result: AgentReply) => void, reject });
      if (!this.send(nodeId, message(requestId))) {
        clearTimeout(timer);
        this.agentRequests.delete(requestId);
        reject(new Error("节点当前离线"));
      }
    });
  }

  readQuota(nodeId: string, timeoutMs: number): Promise<AgentQuotaMessage> {
    return this.requestAgent(nodeId, (requestId) => ({ type: "control.quotaRead", requestId }), "agent.quota", timeoutMs,
      `节点未在 ${Math.round(timeoutMs / 1000)} 秒内返回额度信息`);
  }

  resetQuota(nodeId: string, idempotencyKey: string, creditId: string, timeoutMs: number): Promise<AgentQuotaResetMessage> {
    return this.requestAgent(nodeId, (requestId) => ({ type: "control.quotaReset", requestId, idempotencyKey, creditId }), "agent.quotaReset",
      timeoutMs, `节点未在 ${Math.round(timeoutMs / 1000)} 秒内返回重置结果，结果未知`);
  }

  resolveAgentReply(nodeId: string, message: AgentReply): boolean {
    const pending = this.agentRequests.get(message.requestId);
    if (!pending || pending.nodeId !== nodeId || pending.replyType !== message.type) return false;
    clearTimeout(pending.timer);
    this.agentRequests.delete(message.requestId);
    pending.resolve(message);
    return true;
  }

  resolveWorkspaceFileRead(nodeId: string, message: AgentWorkspaceFileMessage): boolean {
    const pending = this.workspaceFileReads.get(message.requestId);
    if (!pending || pending.nodeId !== nodeId) return false;
    clearTimeout(pending.timer);
    this.workspaceFileReads.delete(message.requestId);
    pending.resolve(message);
    return true;
  }
}
