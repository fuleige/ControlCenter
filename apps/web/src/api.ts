import type {
  Approval,
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

async function responseBody<T>(response: Response): Promise<T & { error?: string }> {
  if (response.status === 204) return undefined as unknown as T & { error?: string };
  const text = await response.text();
  if (!text) return undefined as unknown as T & { error?: string };
  try { return JSON.parse(text) as T & { error?: string }; }
  catch { return { error: text } as T & { error?: string }; }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API_URL}${path}`, { ...init, headers, credentials: "include" });
  const body = await responseBody<T>(response);
  if (response.status === 401 && !path.startsWith("/api/auth/")) {
    window.dispatchEvent(new CustomEvent("controller-center:unauthorized"));
  }
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body as T;
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

export async function getConversation(id: string): Promise<ConversationDetail> {
  return api<ConversationDetail>(`/api/conversations/${id}`);
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
  const response = await fetch(`${API_URL}${path}`, { method: "PUT", headers, body, credentials: "include" });
  const result = await responseBody<T>(response);
  if (response.status === 401) window.dispatchEvent(new CustomEvent("controller-center:unauthorized"));
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result;
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
