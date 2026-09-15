import type {
  Approval,
  AgentPackageInfo,
  AttachmentRecord,
  Conversation,
  ConversationDetail,
  GlobalSettings,
  EnrollmentToken,
  NodeRecord,
  ReasoningEffort,
  Run,
  TaskCenterEntry,
  TaskCenterPolicy,
  Workspace,
} from "./types";

const configuredApiUrl = (import.meta.env.VITE_API_URL as string | undefined)?.trim();

// Leave the URL relative by default so local development and reverse-proxy
// deployments do not require the browser to reach the control-plane port.
export const API_URL = configuredApiUrl?.replace(/\/$/, "") ?? "";

export interface AuthSession {
  authenticated: boolean;
  expiresAt?: string;
}

export type ApiErrorKind = "network" | "http" | "invalid-response";

interface ApiErrorOptions {
  kind: ApiErrorKind;
  method: string;
  path: string;
  status?: number;
  requestId?: string | null;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly method: string;
  readonly path: string;
  readonly requestId: string | null;

  constructor(message: string, options: ApiErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
    this.kind = options.kind;
    this.status = options.status ?? null;
    this.method = options.method;
    this.path = options.path;
    this.requestId = options.requestId ?? null;
  }
}

type ApiResponseBody<T> = T & { error?: unknown; requestId?: unknown };

function requestMethod(init?: RequestInit): string {
  return (init?.method ?? "GET").toUpperCase();
}

function responseRequestId(response: Response, body?: { requestId?: unknown }): string | null {
  const fromHeader = response.headers.get("X-Request-Id");
  if (fromHeader) return fromHeader;
  return typeof body?.requestId === "string" && body.requestId ? body.requestId : null;
}

async function responseBody<T>(response: Response, method: string, path: string): Promise<ApiResponseBody<T>> {
  if (response.status === 204) return undefined as unknown as T & { error?: string };
  const text = await response.text();
  if (!text) {
    if (!response.ok) return undefined as unknown as ApiResponseBody<T>;
    throw new ApiError("控制中心返回了空响应", {
      kind: "invalid-response",
      status: response.status,
      method,
      path,
      requestId: responseRequestId(response),
    });
  }
  try {
    return JSON.parse(text) as ApiResponseBody<T>;
  } catch (cause) {
    if (!response.ok) {
      const contentType = response.headers.get("Content-Type") ?? "";
      const plainText = contentType.includes("text/plain") && text.length <= 500 ? text.trim() : undefined;
      return { ...(plainText ? { error: plainText } : {}) } as ApiResponseBody<T>;
    }
    throw new ApiError("控制中心返回的响应不是有效 JSON", {
      kind: "invalid-response",
      status: response.status,
      method,
      path,
      requestId: responseRequestId(response),
      cause,
    });
  }
}

function fallbackHttpMessage(status: number): string {
  if (status === 400) return "请求参数无效";
  if (status === 401) return "登录状态已失效";
  if (status === 403) return "当前请求没有访问权限";
  if (status === 404) return "请求的资源不存在或已被删除";
  if (status === 409) return "当前状态不允许执行该操作";
  if (status === 413) return "提交的内容过大";
  if (status === 422) return "提交的内容无法处理";
  if (status === 429) return "请求过于频繁，请稍后再试";
  if (status >= 500) return "控制中心服务异常";
  return "控制中心拒绝了请求";
}

function apiErrorMessage(body: { error?: unknown } | undefined, status: number): string {
  return typeof body?.error === "string" && body.error.trim() ? body.error.trim() : fallbackHttpMessage(status);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const method = requestMethod(init);
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, headers, credentials: "include" });
  } catch (cause) {
    throw new ApiError(cause instanceof Error && cause.message ? cause.message : "网络请求失败", {
      kind: "network",
      method,
      path,
      cause,
    });
  }
  const body = await responseBody<T>(response, method, path);
  if (response.status === 401 && path !== "/api/auth/login" && path !== "/api/auth/session") {
    window.dispatchEvent(new CustomEvent("controller-center:unauthorized"));
  }
  if (!response.ok) throw new ApiError(apiErrorMessage(body, response.status), {
    kind: "http",
    status: response.status,
    method,
    path,
    requestId: responseRequestId(response, body),
  });
  return body as T;
}

export function formatErrorMessage(reason: unknown, operation: string): string {
  const prefix = `${operation}失败`;
  if (!(reason instanceof ApiError)) {
    const detail = reason instanceof Error ? reason.message : String(reason);
    return `${prefix}：${detail || "发生未知错误"}`;
  }

  const request = `${reason.method} ${reason.path}`;
  const diagnostic = reason.requestId
    ? `${request} · 请求 ID ${reason.requestId}`
    : request;
  if (reason.kind === "network") {
    return `${prefix}：无法连接控制中心，请检查当前网络、HTTPS 域名或反向代理（${diagnostic}）`;
  }
  if (reason.kind === "invalid-response") {
    return `${prefix}：${reason.message}，请检查反向代理是否返回了错误页面（${diagnostic}）`;
  }
  if (reason.status === 401) {
    return `${prefix}：登录状态已失效，请重新登录（${diagnostic}）`;
  }
  return `${prefix}：${reason.message}（HTTP ${reason.status ?? "未知"} · ${diagnostic}）`;
}

export function getAuthSession(): Promise<AuthSession> {
  return api<AuthSession>("/api/auth/session");
}

export function loginAdmin(token: string): Promise<AuthSession> {
  return api<AuthSession>("/api/auth/login", { method: "POST", body: JSON.stringify({ token }) });
}

export async function logoutAdmin(): Promise<void> {
  await api<void>("/api/auth/logout", { method: "POST" });
}

export function streamUrl(after?: number): string {
  const url = new URL(`${API_URL}/api/stream`, window.location.origin);
  if (after && after > 0) url.searchParams.set("after", String(after));
  return url.toString();
}

export async function listNodes(): Promise<NodeRecord[]> {
  return (await api<{ data: NodeRecord[] }>("/api/nodes")).data;
}

export async function updateNodeName(nodeId: string, name: string): Promise<NodeRecord> {
  return (await api<{ node: NodeRecord }>(`/api/nodes/${nodeId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  })).node;
}

export async function revokeNodeAccess(nodeId: string): Promise<void> {
  await api(`/api/nodes/${encodeURIComponent(nodeId)}/access/revoke`, { method: "POST" });
}

export async function listNodeWorkspaces(nodeId: string, includeArchived = true): Promise<Workspace[]> {
  return (await api<{ data: Workspace[] }>(`/api/nodes/${encodeURIComponent(nodeId)}/workspaces?includeArchived=${includeArchived}`)).data;
}

export async function createNodeWorkspace(nodeId: string, input: { name?: string; path: string }): Promise<Workspace> {
  return (await api<{ workspace: Workspace }>(`/api/nodes/${encodeURIComponent(nodeId)}/workspaces`, {
    method: "POST",
    body: JSON.stringify(input),
  })).workspace;
}

export async function updateNodeWorkspace(
  nodeId: string,
  workspaceId: string,
  input: { name?: string; path?: string; archived?: boolean; confirmMigration?: boolean },
): Promise<Workspace> {
  return (await api<{ workspace: Workspace }>(`/api/nodes/${encodeURIComponent(nodeId)}/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  })).workspace;
}

export async function validateNodeWorkspace(nodeId: string, workspaceId: string): Promise<Workspace> {
  return (await api<{ workspace: Workspace }>(`/api/nodes/${encodeURIComponent(nodeId)}/workspaces/${encodeURIComponent(workspaceId)}/validate`, {
    method: "POST",
  })).workspace;
}

export async function deleteNodeWorkspace(nodeId: string, workspaceId: string): Promise<void> {
  await api<void>(`/api/nodes/${encodeURIComponent(nodeId)}/workspaces/${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
}

export async function listConversations(options: {
  nodeId?: string;
  query?: string;
  status?: "active" | "failed";
  limit?: number;
  cursor?: string;
  includeTotal?: boolean;
} = {}): Promise<{ data: Conversation[]; total: number; nextCursor: string | null }> {
  const parameters = new URLSearchParams();
  if (options.nodeId) parameters.set("nodeId", options.nodeId);
  if (options.query?.trim()) parameters.set("q", options.query.trim());
  if (options.status) parameters.set("status", options.status);
  if (options.limit) parameters.set("limit", String(options.limit));
  if (options.cursor) parameters.set("cursor", options.cursor);
  if (options.includeTotal === false) parameters.set("includeTotal", "false");
  const suffix = parameters.size ? `?${parameters}` : "";
  const result = await api<{ data: Conversation[]; total?: number; nextCursor?: string | null }>(`/api/conversations${suffix}`);
  return {
    data: result.data,
    total: result.total ?? result.data.length,
    nextCursor: result.nextCursor ?? null,
  };
}

export async function getConversation(id: string, options: { beforeMessage?: string; messageLimit?: number } = {}): Promise<ConversationDetail> {
  const parameters = new URLSearchParams();
  if (options.beforeMessage) parameters.set("beforeMessage", options.beforeMessage);
  if (options.messageLimit) parameters.set("messageLimit", String(options.messageLimit));
  const suffix = parameters.size ? `?${parameters}` : "";
  const result = await api<ConversationDetail>(`/api/conversations/${encodeURIComponent(id)}${suffix}`);
  return {
    ...result,
    // Allows the Web and Control Plane to be restarted independently during a rolling deployment.
    messagePage: result.messagePage ?? { hasMore: false, before: null },
  };
}

export async function createConversation(input: {
  nodeId: string;
  workspaceId: string;
  title: string;
  model?: string;
}): Promise<Conversation> {
  const result = await api<{ conversation: Conversation }>("/api/conversations", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.conversation;
}

export async function startConversation(input: {
  nodeId: string;
  workspaceId: string;
  prompt: string;
  clientRequestId: string;
  model?: string;
  effort?: ReasoningEffort;
  attachmentIds?: string[];
}): Promise<{ conversation: Conversation; run: Run; deduplicated: boolean }> {
  return api<{ conversation: Conversation; run: Run; deduplicated: boolean }>("/api/conversations/start", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function deleteConversation(conversationId: string): Promise<void> {
  await api<void>(`/api/conversations/${conversationId}`, { method: "DELETE" });
}

export async function updateConversation(
  conversationId: string,
  input: { title?: string; pinned?: boolean },
): Promise<Conversation> {
  return (await api<{ conversation: Conversation }>(`/api/conversations/${conversationId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  })).conversation;
}

export async function startRun(
  conversationId: string,
  prompt: string,
  options: { model?: string; effort?: ReasoningEffort; clientRequestId: string; attachmentIds?: string[] },
): Promise<Run> {
  return (await api<{ run: Run }>(`/api/conversations/${conversationId}/runs`, {
    method: "POST",
    body: JSON.stringify({ prompt, ...options }),
  })).run;
}

export async function steerRun(
  runId: string,
  prompt: string,
  options: { clientRequestId: string; attachmentIds?: string[] },
): Promise<void> {
  await api(`/api/runs/${runId}/steer`, {
    method: "POST",
    body: JSON.stringify({ prompt, ...options }),
  });
}

export async function interruptRun(runId: string): Promise<void> {
  await api(`/api/runs/${runId}/interrupt`, { method: "POST" });
}

export async function resolveApproval(approvalId: string, response: unknown): Promise<void> {
  await api(`/api/approvals/${approvalId}/resolve`, {
    method: "POST",
    body: JSON.stringify({ response }),
  });
}

export async function listPendingApprovals(): Promise<Approval[]> {
  return (await api<{ data: Approval[] }>("/api/approvals?status=pending")).data;
}

export async function getSettings(): Promise<GlobalSettings> {
  return (await api<{ settings: GlobalSettings }>("/api/settings")).settings;
}

export async function updateSettings(input: Partial<GlobalSettings>): Promise<GlobalSettings> {
  return (await api<{ settings: GlobalSettings }>("/api/settings", {
    method: "PATCH",
    body: JSON.stringify(input),
  })).settings;
}

export async function listEnrollmentTokens(): Promise<{ data: EnrollmentToken[]; lifetimeSeconds: number }> {
  return api<{ data: EnrollmentToken[]; lifetimeSeconds: number }>("/api/enrollment-tokens");
}

export async function createEnrollmentToken(): Promise<{ enrollment: EnrollmentToken; token: string }> {
  return api<{ enrollment: EnrollmentToken; token: string }>("/api/enrollment-tokens", { method: "POST" });
}

export async function getEnrollmentToken(id: string): Promise<EnrollmentToken> {
  return (await api<{ enrollment: EnrollmentToken }>(`/api/enrollment-tokens/${encodeURIComponent(id)}`)).enrollment;
}

export async function revokeEnrollmentToken(id: string): Promise<void> {
  await api<void>(`/api/enrollment-tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function getAgentPackageInfo(): Promise<AgentPackageInfo> {
  return (await api<{ package: AgentPackageInfo }>("/api/agent-package")).package;
}

export async function downloadAgentPackage(fileName: string): Promise<void> {
  const path = "/api/agent-package/download";
  const method = "GET";
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { credentials: "include" });
  } catch (cause) {
    throw new ApiError(cause instanceof Error && cause.message ? cause.message : "网络请求失败", {
      kind: "network",
      method,
      path,
      cause,
    });
  }
  if (!response.ok) {
    const body = await responseBody<Record<string, never>>(response, method, path);
    if (response.status === 401) window.dispatchEvent(new CustomEvent("controller-center:unauthorized"));
    throw new ApiError(apiErrorMessage(body, response.status), {
      kind: "http",
      status: response.status,
      method,
      path,
      requestId: responseRequestId(response, body),
    });
  }
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

export async function getTaskCenter(): Promise<{ entries: TaskCenterEntry[]; unreadCount: number; policy: TaskCenterPolicy }> {
  const result = await api<{ data: TaskCenterEntry[]; unreadCount: number; policy?: TaskCenterPolicy }>("/api/task-center");
  return {
    entries: result.data,
    unreadCount: result.unreadCount,
    policy: result.policy ?? { limit: 200, replyPreviewCharacters: 120, readRetentionDays: 30, unreadRetentionDays: 90 },
  };
}

export async function markConversationRead(conversationId: string): Promise<void> {
  await api<void>(`/api/conversations/${conversationId}/read`, { method: "POST" });
}

export async function markAllNotificationsRead(): Promise<void> {
  await api<void>("/api/notifications/read-all", { method: "POST" });
}

export async function retryRun(runId: string): Promise<Run> {
  return (await api<{ run: Run }>(`/api/runs/${runId}/retry`, { method: "POST" })).run;
}

export async function updatePresence(sessionId: string, conversationId: string | null, visible: boolean): Promise<void> {
  await api<void>("/api/ui/presence", {
    method: "POST",
    body: JSON.stringify({ sessionId, conversationId, visible }),
  });
}

export async function createAttachmentUpload(input: {
  file: File;
  messageClientId: string;
  conversationId?: string;
}): Promise<AttachmentRecord> {
  return (await api<{ attachment: AttachmentRecord }>("/api/attachments", {
    method: "POST",
    body: JSON.stringify({
      name: input.file.name,
      mediaType: input.file.type || "application/octet-stream",
      size: input.file.size,
      messageClientId: input.messageClientId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    }),
  })).attachment;
}

async function binaryRequest<T>(path: string, body: Blob): Promise<T> {
  const headers = new Headers({ "Content-Type": "application/octet-stream" });
  return api<T>(path, { method: "PUT", headers, body });
}

export async function uploadAttachmentContent(
  file: File,
  initial: AttachmentRecord,
  onProgress: (receivedSize: number) => void,
): Promise<AttachmentRecord> {
  let attachment = initial;
  if (attachment.status === "ready" || attachment.status === "consumed") return attachment;
  attachment = (await api<{ attachment: AttachmentRecord }>(`/api/attachments/${attachment.id}`)).attachment;
  let offset = attachment.receivedSize;
  const chunkSize = 1024 * 1024;
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size));
    const result = await binaryRequest<{ receivedSize: number }>(`/api/attachments/${attachment.id}/chunks/${offset}`, chunk);
    offset = result.receivedSize;
    onProgress(offset);
  }
  let sha256: string | undefined;
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  }
  return (await api<{ attachment: AttachmentRecord }>(`/api/attachments/${attachment.id}/finalize`, {
    method: "POST",
    body: JSON.stringify({ ...(sha256 ? { sha256 } : {}) }),
  })).attachment;
}

export async function deleteAttachmentUpload(attachmentId: string): Promise<void> {
  await api<void>(`/api/attachments/${attachmentId}`, { method: "DELETE" });
}
