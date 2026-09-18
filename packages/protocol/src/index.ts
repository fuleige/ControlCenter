export const CONTROL_PROTOCOL_VERSION = 5 as const;
export const WORKSPACE_FILE_READ_CAPABILITY = "workspace_file_read_v1" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type WorkspaceSource = "default" | "config" | "web" | "history";
export type WorkspaceStatus = "valid" | "invalid" | "offline" | "archived";

export interface WorkspaceDescriptor {
  id: string;
  name: string;
  path: string;
  source: WorkspaceSource;
  isDefault: boolean;
}

export interface ManagedWorkspaceDescriptor {
  id: string;
  name: string;
  path: string;
  source: "web" | "history";
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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

export type ConversationCompactionStatus =
  | "queued"
  | "dispatching"
  | "running"
  | "recovering"
  | "completed"
  | "failed";

export interface ConversationCompaction {
  id: string;
  status: ConversationCompactionStatus;
  beforeContextTokens: number | null;
  afterContextTokens: number | null;
  errorCode: RunErrorCode | null;
  error: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  recoveryDeadlineAt: string | null;
}

export interface ModelReasoningEffort {
  reasoningEffort: ReasoningEffort;
  description?: string;
}

export interface ModelDescriptor {
  id: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort?: ReasoningEffort;
  supportedReasoningEfforts: ModelReasoningEffort[];
}

export interface NodeDescriptor {
  id: string;
  name: string;
  platform: string;
  arch: string;
  agentVersion: string;
  codexVersion: string;
  permissionMode?: "workspace-write" | "danger-full-access";
  maxConcurrentRuns: number;
  workspaces: WorkspaceDescriptor[];
  models?: ModelDescriptor[];
  /** Optional features supported without requiring a protocol-version bump. */
  capabilities?: string[];
}

export interface AgentHelloMessage {
  type: "agent.hello";
  protocolVersion: typeof CONTROL_PROTOCOL_VERSION;
  bootId: string;
  node: NodeDescriptor;
}

export interface AgentHeartbeatMessage {
  type: "agent.heartbeat";
  bootId: string;
  activeRuns: number;
  sentAt: string;
}

export interface AgentCommandAckMessage {
  type: "agent.commandAck";
  commandId: string;
  status: "accepted" | "completed" | "failed";
  error?: string;
}

export interface AgentWorkspaceValidationMessage {
  type: "agent.workspaceValidation";
  requestId: string;
  valid: boolean;
  canonicalPath?: string;
  suggestedName?: string;
  error?: string;
}

export type WorkspaceFileReadErrorCode =
  | "not_found"
  | "not_file"
  | "forbidden"
  | "too_large"
  | "read_failed";

export interface AgentWorkspaceFileMessage {
  type: "agent.workspaceFile";
  requestId: string;
  ok: boolean;
  path?: string;
  name?: string;
  mediaType?: string;
  size?: number;
  contentBase64?: string;
  errorCode?: WorkspaceFileReadErrorCode;
  error?: string;
}

export interface ConversationBoundPayload {
  type: "conversation.bound";
  commandId: string;
  conversationId: string;
  threadId: string;
}

export interface RunStartedPayload {
  type: "run.started";
  commandId: string;
  conversationId: string;
  runId: string;
  threadId: string;
  turnId: string;
  startedAt: string;
}

export interface RunFinishedPayload {
  type: "run.finished";
  conversationId: string;
  runId: string;
  threadId: string;
  turnId: string;
  status: "completed" | "failed" | "interrupted";
  errorCode?: RunErrorCode;
  error?: string;
  finishedAt: string;
}

export type RunProgressPhase = "analyzing" | "working" | "compacting" | "retrying" | "verifying" | "waiting_user" | "finalizing";

export interface RunProgressPayload {
  type: "run.progress";
  conversationId: string;
  runId: string;
  phase: RunProgressPhase;
  label: string;
  occurredAt: string;
}

export interface MessageSnapshotPayload {
  type: "message.snapshot";
  messageId: string;
  conversationId: string;
  runId: string;
  role: "assistant";
  revision: number;
  content: string;
  complete: boolean;
  occurredAt: string;
}

export interface ConversationTokenUsage {
  /** Cumulative tokens consumed by every model call in this conversation. */
  totalTokens: number;
  /** Tokens present in the most recent model call, used for context occupancy. */
  contextTokens: number;
  /** Effective model context-window size reported by Codex, when available. */
  modelContextWindow: number | null;
  updatedAt: string;
}

export interface ConversationTokenUsagePayload extends ConversationTokenUsage {
  type: "conversation.tokenUsage";
  conversationId: string;
  threadId: string;
  turnId?: string;
}

export interface ConversationCompactionPayload {
  type: "conversation.compaction";
  compactionId: string;
  conversationId: string;
  threadId: string;
  status: "running" | "completed" | "failed";
  beforeContextTokens?: number;
  afterContextTokens?: number;
  errorCode?: RunErrorCode;
  error?: string;
  occurredAt: string;
}

export interface InteractionRequestedPayload {
  type: "interaction.requested";
  approvalId: string;
  conversationId: string;
  runId?: string;
  threadId: string;
  turnId?: string;
  method: string;
  requestId: string;
  summary: string;
  risk?: string;
  details: JsonValue;
  requestedAt: string;
}

export interface InteractionResolvedPayload {
  type: "interaction.resolved";
  approvalId: string;
  response: JsonValue;
  resolvedAt: string;
}

export interface AgentStateReportPayload {
  type: "agent.stateReport";
  activeRuns: Array<{
    conversationId: string;
    runId: string;
    threadId: string;
    turnId: string;
    workspaceId: string;
  }>;
  activeCompactions: Array<{
    compactionId: string;
    conversationId: string;
    threadId: string;
  }>;
  reportedAt: string;
}

export interface AgentErrorPayload {
  type: "agent.error";
  commandId?: string;
  conversationId?: string;
  runId?: string;
  compactionId?: string;
  errorCode?: RunErrorCode;
  message: string;
  occurredAt: string;
}

export type DurableAgentPayload =
  | ConversationBoundPayload
  | RunStartedPayload
  | RunProgressPayload
  | MessageSnapshotPayload
  | ConversationTokenUsagePayload
  | ConversationCompactionPayload
  | RunFinishedPayload
  | InteractionRequestedPayload
  | InteractionResolvedPayload
  | AgentStateReportPayload
  | AgentErrorPayload;

export interface AttachmentDescriptor {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  downloadToken: string;
}

export interface AgentDurableMessage {
  type: "agent.message";
  bootId: string;
  sequence: number;
  payload: DurableAgentPayload;
}

export type AgentToControlMessage =
  | AgentHelloMessage
  | AgentHeartbeatMessage
  | AgentCommandAckMessage
  | AgentWorkspaceValidationMessage
  | AgentWorkspaceFileMessage
  | AgentDurableMessage;

export interface CreateConversationCommand {
  type: "conversation.create";
  conversationId: string;
  workspaceId: string;
  title: string;
  model?: string;
}

export interface StartConversationCommand {
  type: "conversation.start";
  conversationId: string;
  workspaceId: string;
  title: string;
  runId: string;
  prompt: string;
  model?: string;
  effort?: ReasoningEffort;
  attachments?: AttachmentDescriptor[];
}

export interface DeleteConversationCommand {
  type: "conversation.delete";
  conversationId: string;
  threadId: string;
}

export interface StartRunCommand {
  type: "run.start";
  conversationId: string;
  runId: string;
  workspaceId: string;
  threadId: string;
  prompt: string;
  model?: string;
  effort?: ReasoningEffort;
  attachments?: AttachmentDescriptor[];
}

export interface SteerRunCommand {
  type: "run.steer";
  conversationId: string;
  runId: string;
  threadId: string;
  turnId: string;
  prompt: string;
  attachments?: AttachmentDescriptor[];
}

export interface InterruptRunCommand {
  type: "run.interrupt";
  conversationId: string;
  runId: string;
  threadId: string;
  turnId: string;
}

export interface CompactConversationCommand {
  type: "conversation.compact";
  compactionId: string;
  conversationId: string;
  threadId: string;
}

export interface ResolveApprovalCommand {
  type: "approval.resolve";
  approvalId: string;
  response: JsonValue;
}

export type ControlCommand =
  | CreateConversationCommand
  | StartConversationCommand
  | DeleteConversationCommand
  | StartRunCommand
  | SteerRunCommand
  | InterruptRunCommand
  | CompactConversationCommand
  | ResolveApprovalCommand;

export interface ControlCommandMessage {
  type: "control.command";
  commandId: string;
  command: ControlCommand;
  createdAt: string;
}

export interface ControlWelcomeMessage {
  type: "control.welcome";
  protocolVersion: typeof CONTROL_PROTOCOL_VERSION;
  nodeId: string;
  connectedAt: string;
  heartbeatIntervalMs: number;
  /** Legacy conversations that need a one-time local token-usage backfill. */
  tokenUsageBackfill?: Array<{
    conversationId: string;
    threadId: string;
  }>;
}

export interface ControlDeliveryAckMessage {
  type: "control.deliveryAck";
  bootId: string;
  sequence: number;
}

export interface ControlErrorMessage {
  type: "control.error";
  code: string;
  message: string;
}

export interface ControlWorkspaceValidateMessage {
  type: "control.workspaceValidate";
  requestId: string;
  path: string;
}

export interface ControlWorkspaceFileReadMessage {
  type: "control.workspaceFileRead";
  requestId: string;
  workspaceId: string;
  path: string;
  /** Canonical path of a previously opened file, used for nested relative links. */
  basePath?: string;
  maxBytes: number;
}

export interface ControlWorkspaceSyncMessage {
  type: "control.workspaceSync";
  workspaces: ManagedWorkspaceDescriptor[];
}

export type ControlToAgentMessage =
  | ControlCommandMessage
  | ControlWelcomeMessage
  | ControlDeliveryAckMessage
  | ControlWorkspaceValidateMessage
  | ControlWorkspaceFileReadMessage
  | ControlWorkspaceSyncMessage
  | ControlErrorMessage;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAgentMessage(input: string): AgentToControlMessage {
  const value: unknown = JSON.parse(input);
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Invalid agent message envelope");
  }
  if (
    value.type !== "agent.hello" &&
    value.type !== "agent.heartbeat" &&
    value.type !== "agent.commandAck" &&
    value.type !== "agent.workspaceValidation" &&
    value.type !== "agent.workspaceFile" &&
    value.type !== "agent.message"
  ) {
    throw new Error(`Unsupported agent message type: ${value.type}`);
  }
  return value as unknown as AgentToControlMessage;
}

export function parseControlMessage(input: string): ControlToAgentMessage {
  const value: unknown = JSON.parse(input);
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Invalid control message envelope");
  }
  if (
    value.type !== "control.command" &&
    value.type !== "control.welcome" &&
    value.type !== "control.deliveryAck" &&
    value.type !== "control.workspaceValidate" &&
    value.type !== "control.workspaceFileRead" &&
    value.type !== "control.workspaceSync" &&
    value.type !== "control.error"
  ) {
    throw new Error(`Unsupported control message type: ${value.type}`);
  }
  return value as unknown as ControlToAgentMessage;
}

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
