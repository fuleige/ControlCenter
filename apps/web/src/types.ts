export interface Workspace {
  id: string;
  nodeId: string;
  name: string;
  path: string;
  source: "default" | "config" | "web" | "history";
  isDefault: boolean;
  status: "valid" | "invalid" | "offline" | "archived";
  validationError: string | null;
  lastValidatedAt: string | null;
  archivedAt: string | null;
  conversationCount: number;
  createdAt: string;
  updatedAt: string;
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelDescriptor {
  id: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort?: ReasoningEffort;
  supportedReasoningEfforts: Array<{
    reasoningEffort: ReasoningEffort;
    description?: string;
  }>;
}

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
  accessMode?: "enrolled" | "revoked" | "legacy";
  lastSeenAt: string;
  workspaces: Workspace[];
  models: ModelDescriptor[];
}

export interface Conversation {
  id: string;
  nodeId: string;
  workspaceId: string;
  title: string;
  model: string | null;
  effort: ReasoningEffort | null;
  clientRequestId: string | null;
  remoteThreadId: string | null;
  status: "creating" | "ready" | "error";
  error: string | null;
  pinnedAt: string | null;
  latestRunStatus: Run["status"] | null;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  conversationId: string;
  prompt: string;
  model: string | null;
  effort: ReasoningEffort | null;
  clientRequestId: string | null;
  remoteTurnId: string | null;
  status: "queued" | "dispatching" | "running" | "waiting_approval" | "recovering" | "completed" | "failed" | "interrupted";
  progressPhase: "analyzing" | "working" | "verifying" | "waiting_user" | "finalizing" | null;
  progressLabel: string | null;
  progressUpdatedAt: string | null;
  recoveryDeadlineAt: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Message {
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

export interface Approval {
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

export interface ConversationDetail {
  conversation: Conversation;
  runs: Run[];
  messages: Message[];
  attachments: AttachmentRecord[];
  approvals: Approval[];
}

export interface GlobalSettings {
  defaultModel: string | null;
  defaultEffort: ReasoningEffort | null;
}

export interface EnrollmentToken {
  id: string;
  token: string | null;
  status: "pending" | "used" | "revoked" | "expired";
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  nodeId: string | null;
}

export interface TaskCenterEntry {
  id: string;
  nodeId: string;
  nodeName: string;
  conversationId: string;
  conversationTitle: string;
  runId: string | null;
  status: Run["status"] | "completed" | "failed" | "waiting_user";
  progressLabel: string | null;
  replyPreview: string | null;
  unread: boolean;
  occurredAt: string;
}

export interface TaskCenterPolicy {
  limit: number;
  replyPreviewCharacters: number;
  readRetentionDays: number;
  unreadRetentionDays: number;
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
  expiresAt: string;
  createdAt: string;
}
