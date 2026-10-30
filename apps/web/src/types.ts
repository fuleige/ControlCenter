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
  supportsFastMode?: boolean;
  defaultReasoningEffort?: ReasoningEffort;
  supportedReasoningEfforts: Array<{
    reasoningEffort: ReasoningEffort;
    description?: string;
  }>;
}

export interface NodeRecord {
  id: string;
  /** Shared by the Codex and Claude entries started from one Agent data directory. */
  machineId: string;
  name: string;
  reportedName: string;
  platform: string;
  arch: string;
  agentVersion: string;
  runtime: "codex" | "claude";
  /** Version string reported by the runtime's CLI. */
  codexVersion: string;
  permissionMode: "workspace-write" | "danger-full-access";
  maxConcurrentRuns: number;
  activeRuns: number;
  status: "online" | "offline";
  accessMode?: "enrolled" | "revoked" | "legacy";
  lastSeenAt: string;
  workspaces: Workspace[];
  models: ModelDescriptor[];
  capabilities?: string[];
}

/** A node's stored plan-quota read, as the Control Plane serves it to the quota dialog. */
export interface NodeQuota {
  nodeId: string;
  runtime: NodeRecord["runtime"];
  online: boolean;
  /** The node's Agent can answer quota reads. */
  supported: boolean;
  /** The last successful report, in the runtime's own shape; see node-quota.ts. */
  report: NodeQuotaReport | null;
  succeededAt: string | null;
  attemptedAt: string | null;
  /** Why the most recent read failed; null when it succeeded. */
  error: string | null;
  refreshWaitMs: number;
  /** The node's Agent can redeem reset credits; only Codex has them. */
  resetSupported: boolean;
  /** A reset is running on this node, possibly started from another browser. */
  resetting: boolean;
  lastReset: NodeQuotaReset | null;
}

export interface NodeQuotaReset {
  creditId: string;
  /** How the credit was named when it was picked; redeemed credits leave the list. */
  creditLabel: string | null;
  requestedAt: string;
  finishedAt: string | null;
  /** The runtime's outcome; null while running or when the result is unknown. */
  outcome: string | null;
  error: string | null;
}

export type NodeQuotaReport =
  | { runtime: "codex"; account: unknown; rateLimits: unknown }
  | { runtime: "claude"; account: unknown; usage: unknown };

export interface ConversationAttentionUpdate {
  changed: boolean;
  conversationId: string | null; // null means all conversations were read.
  unread: boolean;
  unreadAt: string | null;
  manualUnreadAt: string | null;
  unreadCount: number;
  nodeUnreadCounts: Record<string, number>;
  revision: number;
}

export interface Conversation {
  id: string;
  nodeId: string;
  workspaceId: string;
  title: string;
  model: string | null;
  effort: ReasoningEffort | null;
  fastMode?: boolean;
  clientRequestId: string | null;
  remoteThreadId: string | null;
  status: "creating" | "ready" | "error";
  error: string | null;
  pinnedAt: string | null;
  unread: boolean;
  unreadAt: string | null;
  latestRunStatus: Run["status"] | null;
  tokenUsage: ConversationTokenUsage | null;
  compaction?: ConversationCompaction | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceFileDescriptor {
  id: string;
  conversationId: string;
  name: string;
  path: string;
  mediaType: string;
  size: number;
  expiresAt: string;
  contentUrl: string;
}

export interface ConversationOpenedFile {
  id: string;
  conversationId: string;
  path: string;
  name: string;
  mediaType: string;
  size: number;
  openCount: number;
  firstOpenedAt: string;
  lastOpenedAt: string;
}

export type RunErrorCode =
  | "context_window_exceeded"
  | "session_budget_exceeded"
  | "usage_limit_exceeded"
  | "rate_limit_exceeded"
  | "authentication_failed"
  | "service_unavailable"
  | "stream_interrupted"
  | "sandbox_failed"
  | "policy_blocked"
  | "invalid_request"
  | "active_turn_busy"
  | "internal_error"
  | "unknown";

export interface ConversationCompaction {
  id: string;
  status: "queued" | "dispatching" | "running" | "recovering" | "completed" | "failed";
  beforeContextTokens: number | null;
  afterContextTokens: number | null;
  errorCode: RunErrorCode | null;
  error: string | null;
  errorDismissedAt?: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  recoveryDeadlineAt: string | null;
}

export interface ConversationTokenUsage {
  totalTokens: number;
  contextTokens: number;
  modelContextWindow: number | null;
  updatedAt: string;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface MessageOutputStats {
  estimatedTokens: number;
  elapsedMs: number;
  averageTokensPerSecond: number | null;
  recentTokensPerSecond: number | null;
}

export interface Run {
  id: string;
  conversationId: string;
  prompt: string;
  model: string | null;
  effort: ReasoningEffort | null;
  fastMode?: boolean;
  clientRequestId: string | null;
  remoteTurnId: string | null;
  status: "queued" | "dispatching" | "running" | "waiting_approval" | "recovering" | "completed" | "failed" | "interrupted";
  progressPhase: "analyzing" | "working" | "verifying" | "waiting_user" | "finalizing" | "compacting" | "retrying" | null;
  progressLabel: string | null;
  progressUpdatedAt: string | null;
  recoveryDeadlineAt: string | null;
  error: string | null;
  errorCode?: RunErrorCode | null;
  errorDismissedAt: string | null;
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
  outputStats?: MessageOutputStats;
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
  messagePage: {
    hasMore: boolean;
    before: string | null;
  };
  attachments: AttachmentRecord[];
  approvals: Approval[];
}

/** New-conversation defaults; the unprefixed pair predates Claude and applies to Codex. */
export interface GlobalSettings {
  defaultModel: string | null;
  defaultEffort: ReasoningEffort | null;
  claudeDefaultModel: string | null;
  claudeDefaultEffort: ReasoningEffort | null;
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

export interface AgentPackageInfo {
  target?: string;
  packages?: AgentPackageInfo[];
  available: boolean;
  version: string;
  fileName: string | null;
  size: number | null;
  sha256: string | null;
  builtAt: string | null;
}

export interface AgentPackageDownloadLink {
  url: string;
  expiresAt: string;
  fileName: string;
}

export interface TaskCenterEntry {
  id: string;
  notificationId: string | null;
  nodeId: string;
  nodeName: string;
  conversationId: string;
  conversationTitle: string;
  runId: string | null;
  status: Run["status"] | "waiting_user" | Conversation["status"];
  progressLabel: string | null;
  replyPreview: string | null;
  unread: boolean;
  manualUnread: boolean;
  manualUnreadAt: string | null;
  attentionAt: string;
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
