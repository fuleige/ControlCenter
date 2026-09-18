import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type FormEvent,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  ApiError,
  compactConversation,
  deleteConversation,
  deleteConversationOpenedFile,
  dismissRunError,
  createEnrollmentToken,
  createNodeWorkspace,
  deleteNodeWorkspace,
  createAttachmentUpload,
  deleteAttachmentUpload,
  downloadAgentPackage,
  fetchWorkspaceFileContent,
  getConversation,
  getWorkspaceFile,
  getAuthSession,
  getAgentPackageInfo,
  getSettings,
  getTaskCenter,
  interruptRun,
  isWorkspaceConcurrencyConflict,
  listConversations,
  listConversationOpenedFiles,
  listEnrollmentTokens,
  listNodes,
  listNodeWorkspaces,
  listPendingApprovals,
  markAllNotificationsRead,
  markConversationRead,
  loginAdmin,
  logoutAdmin,
  openWorkspaceFile,
  retryRun,
  resolveApproval,
  revokeNodeAccess,
  revokeEnrollmentToken,
  startConversation,
  startRun,
  steerRun,
  streamUrl,
  updateConversation,
  updateNodeName,
  updateNodeWorkspace,
  updatePresence,
  updateSettings,
  uploadAttachmentContent,
  validateNodeWorkspace,
  formatErrorMessage,
} from "./api";
import type {
  Approval,
  AgentPackageInfo,
  AttachmentRecord,
  Conversation,
  ConversationCompaction,
  ConversationDetail,
  ConversationOpenedFile,
  ConversationTokenUsage,
  EnrollmentToken,
  GlobalSettings,
  Message,
  NodeRecord,
  ReasoningEffort,
  Run,
  TaskCenterEntry,
  TaskCenterPolicy,
  Workspace,
  WorkspaceFileDescriptor,
} from "./types";

type MobilePane = "nodes" | "conversations" | "chat";
type JsonRecord = Record<string, unknown>;
type BackgroundIssueSource = "nodes" | "conversations" | "detail" | "approvals" | "settings" | "tasks";

interface BackgroundIssue {
  source: BackgroundIssueSource;
  message: string;
  occurredAt: number;
}

const selectedNodeStorageKey = "controller-center:selected-node";
const selectedConversationStorageKey = "controller-center:selected-conversation";
const nodeConversationStorageKeyPrefix = "controller-center:selected-conversation-by-node:";
const draftRequestStorageKey = "controller-center:draft-request";
const nodesCollapsedStorageKey = "controller-center:nodes-collapsed";
const historyCollapsedStorageKey = "controller-center:history-collapsed";
const streamRevisionStorageKey = "controller-center:stream-revision";
const browserSessionStorageKey = "controller-center:browser-session";
const enrollmentRefreshIntervalMs = 10_000;
const connectedSafetySyncIntervalMs = 60_000;
const disconnectedFallbackSyncIntervalMs = 10_000;
const presenceHeartbeatIntervalMs = 25_000;
const conversationPageSize = 50;
export const conversationCacheLimit = 300;
const recentMessagePageSize = 60;
export const messageHistoryCacheLimit = 500;
const timelineBottomThreshold = 96;

function isTimelineAwayFromBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight >= timelineBottomThreshold;
}

function storedValue(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function storeValue(key: string, value: string | null): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in private or embedded browser contexts.
  }
}

function sessionStoredValue(key: string): string | null {
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}

function sessionStoreValue(key: string, value: string | null): void {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in private or embedded browser contexts.
  }
}

function storedBoolean(key: string): boolean {
  return storedValue(key) === "true";
}

function nodeConversationStorageKey(nodeId: string): string {
  return `${nodeConversationStorageKeyPrefix}${encodeURIComponent(nodeId)}`;
}

function newDraftRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface TimelineEntry {
  id: string;
  at: string;
  kind: "user" | "agent";
  title?: string;
  content: string;
  attachmentIds: string[];
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function relativeTime(value: string): string {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 30) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return formatDate(value);
}

function compactTokenCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  if (value < 1_000) return Math.round(value).toLocaleString("zh-CN");
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`;
}

function ConversationUsageBar({
  usage,
  draft,
  compaction,
  disabled,
  recommended,
  onRequestCompact,
}: {
  usage: ConversationTokenUsage | null;
  draft: boolean;
  compaction: ConversationCompaction | null;
  disabled: boolean;
  recommended: boolean;
  onRequestCompact: () => void;
}) {
  if (draft) return null;
  const contextWindow = usage?.modelContextWindow ?? null;
  const contextPercent = usage && contextWindow
    ? Math.max(0, Math.round(usage.contextTokens / contextWindow * 100))
    : null;
  const exact = (value: number | null | undefined) => value === null || value === undefined ? "尚未获取" : `${value.toLocaleString("zh-CN")} Token`;
  const active = Boolean(compaction && ["queued", "dispatching", "running", "recovering"].includes(compaction.status));
  const label = compaction?.status === "queued"
    ? "等待节点"
    : compaction?.status === "dispatching"
      ? "正在启动"
      : compaction?.status === "running"
        ? "正在压缩"
        : compaction?.status === "recovering"
          ? "正在恢复"
          : compaction?.status === "failed"
            ? "重试压缩"
            : "压缩";
  return (
    <section className={`conversation-usage ${usage ? "" : "pending"}`} aria-label="当前会话 Token 使用情况">
      <span title={exact(usage?.totalTokens)}><small>总计</small><strong>{compactTokenCount(usage?.totalTokens)}</strong></span>
      <span title={exact(contextWindow)}><small>窗口</small><strong>{compactTokenCount(contextWindow)}</strong></span>
      <span title={usage && contextWindow ? `${usage.contextTokens.toLocaleString("zh-CN")} / ${contextWindow.toLocaleString("zh-CN")} Token` : "尚未获取"}>
        <small>占用</small><strong>{contextPercent === null ? "--" : `${contextPercent}%`}</strong>
      </span>
      <button
        type="button"
        className={`compact-button ${recommended ? "recommended" : ""} ${compaction?.status === "failed" ? "failed" : ""}`}
        disabled={disabled || active}
        title={active ? "上下文压缩正在进行" : "概括当前有效上下文以释放空间"}
        onClick={onRequestCompact}
      >
        {active && <i aria-hidden="true" />}{label}
      </button>
    </section>
  );
}

const statusText: Record<string, string> = {
  draft: "草稿",
  creating: "正在创建",
  ready: "就绪",
  error: "异常",
  queued: "排队中",
  dispatching: "正在投递",
  running: "执行中",
  waiting_approval: "等待审批",
  waiting_user: "等待操作",
  recovering: "恢复中",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
};

export function buildTimeline(detail: ConversationDetail | null): TimelineEntry[] {
  if (!detail) return [];
  return detail.messages
    .map((message): TimelineEntry => ({
      id: message.id,
      at: message.createdAt,
      kind: message.role === "assistant" ? "agent" : "user",
      content: message.content,
      attachmentIds: message.attachmentIds,
    }))
    .filter((entry) => entry.content.trim())
    .sort((left, right) => left.at.localeCompare(right.at));
}

function compareMessages(left: Message, right: Message): number {
  const timeOrder = left.createdAt.localeCompare(right.createdAt);
  if (timeOrder !== 0) return timeOrder;
  const roleOrder = (left.role === "user" ? 0 : 1) - (right.role === "user" ? 0 : 1);
  return roleOrder || left.id.localeCompare(right.id);
}

export function limitConversationCache(conversations: Conversation[]): Conversation[] {
  return conversations.slice(0, conversationCacheLimit);
}

export function boundedConversationDetail(
  detail: ConversationDetail,
  keep: "latest" | "oldest" = "latest",
  limit = messageHistoryCacheLimit,
): ConversationDetail {
  const sortedMessages = [...detail.messages].sort(compareMessages);
  const messages = sortedMessages.length <= limit
    ? sortedMessages
    : keep === "latest"
      ? sortedMessages.slice(-limit)
      : sortedMessages.slice(0, limit);
  const referencedAttachments = new Set(messages.flatMap((message) => message.attachmentIds));
  return {
    ...detail,
    messages,
    attachments: detail.attachments.filter((attachment) => referencedAttachments.has(attachment.id)),
  };
}

export function mergedConversationDetail(
  current: ConversationDetail | null,
  incoming: ConversationDetail,
  pageMode: "preserve" | "older" = "preserve",
): ConversationDetail {
  if (!current || current.conversation.id !== incoming.conversation.id) {
    return boundedConversationDetail(incoming, pageMode === "older" ? "oldest" : "latest");
  }
  const messages = new Map(current.messages.map((message) => [message.id, message]));
  for (const message of incoming.messages) {
    const existing = messages.get(message.id);
    if (!existing || message.revision >= existing.revision) messages.set(message.id, message);
  }
  const allMessages = [...messages.values()].sort(compareMessages);
  const mergedMessages = allMessages.length <= messageHistoryCacheLimit
    ? allMessages
    : pageMode === "older"
      ? allMessages.slice(0, messageHistoryCacheLimit)
      : allMessages.slice(-messageHistoryCacheLimit);
  const referencedAttachments = new Set(mergedMessages.flatMap((message) => message.attachmentIds));
  const attachments = new Map(current.attachments.map((attachment) => [attachment.id, attachment]));
  for (const attachment of incoming.attachments) attachments.set(attachment.id, attachment);
  return {
    ...incoming,
    messages: mergedMessages,
    attachments: [...attachments.values()].filter((attachment) => referencedAttachments.has(attachment.id)),
    messagePage: pageMode === "older" ? incoming.messagePage : current.messagePage,
  };
}

const animatedStatuses = new Set(["creating", "queued", "dispatching", "running", "recovering"]);

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`status status-${status}`}>
      {animatedStatuses.has(status) && <i className="status-spinner" aria-hidden="true" />}
      {statusText[status] ?? status}
    </span>
  );
}

function WorkspaceConcurrencyDialog({
  workspace,
  detail,
  busy,
  onCancel,
  onConfirm,
}: {
  workspace?: Pick<Workspace, "name" | "path"> | null;
  detail?: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="compact-confirm-backdrop" role="presentation">
      <section className="compact-confirm workspace-concurrency-confirm" role="dialog" aria-modal="true" aria-labelledby="workspace-concurrency-title">
        <span className="compact-confirm-icon" aria-hidden="true">!</span>
        <div>
          <h2 id="workspace-concurrency-title">当前工作区已有任务</h2>
          <p>{workspace
            ? <>“{workspace.name}”中已有任务正在运行或排队。继续后，多个任务可能同时修改 <code>{workspace.path}</code> 下的文件。</>
            : detail ?? "当前工作区已有任务正在运行或排队，继续后多个任务可能同时修改同一批文件。"}</p>
          <p className="compact-confirm-note">并发修改可能导致文件覆盖、补丁冲突或测试结果互相影响，请确认这些风险可以接受。</p>
          <div className="compact-confirm-actions">
            <button type="button" autoFocus disabled={busy} onClick={onCancel}>取消</button>
            <button className="primary-button" type="button" disabled={busy} onClick={onConfirm}>
              {busy ? "正在启动…" : "仍然继续"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function PencilIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 13.7V16h2.3L15 7.3 12.7 5 4 13.7Zm12.8-8.3a.8.8 0 0 0 0-1.1l-1.1-1.1a.8.8 0 0 0-1.1 0l-1.1 1.1 2.3 2.3 1-1.2Z" /></svg>;
}

function TrashIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 3.5h7l.7 1.5H17v1.5H3V5h2.8l.7-1.5ZM5 8h10l-.7 8.5H5.7L5 8Zm3 1.5v5h1.3v-5H8Zm2.7 0v5H12v-5h-1.3Z" /></svg>;
}

function BellIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5a4.2 4.2 0 0 0-4.2 4.2v2.1c0 1.1-.4 2.2-1.2 3l-.8.8v1.2h12.4v-1.2l-.8-.8a4.2 4.2 0 0 1-1.2-3V6.7A4.2 4.2 0 0 0 10 2.5Zm-1.7 12.7h3.4a1.7 1.7 0 0 1-3.4 0Z" /></svg>;
}

function SearchIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8.7 3a5.7 5.7 0 1 0 3.5 10.2l3.9 3.9 1-1-3.9-3.9A5.7 5.7 0 0 0 8.7 3Zm0 1.5a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4Z" /></svg>;
}

function HistoryIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4.5h12V6H4V4.5Zm0 4.75h12v1.5H4v-1.5ZM4 14h8v1.5H4V14Z" /></svg>;
}

function FilesIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.2 2.5h7.1l4.5 4.4v9.4c0 .7-.6 1.2-1.2 1.2H4.2c-.7 0-1.2-.6-1.2-1.2V3.7c0-.7.5-1.2 1.2-1.2Zm6.4 1.6H4.7v11.8h9.5V7.6h-3.6V4.1Zm1.6.7V6h1.3l-1.3-1.2ZM6.4 9h5.9v1.4H6.4V9Zm0 3h5.9v1.4H6.4V12Z" /></svg>;
}

function SettingsIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m16.4 11.2 1.1.9-1.5 2.6-1.4-.5c-.5.4-1 .7-1.6.9l-.3 1.4h-3l-.3-1.4c-.6-.2-1.1-.5-1.6-.9l-1.4.5-1.5-2.6 1.1-.9a6.5 6.5 0 0 1 0-1.9l-1.1-.9 1.5-2.6 1.4.5c.5-.4 1-.7 1.6-.9l.3-1.4h3l.3 1.4c.6.2 1.1.5 1.6.9l1.4-.5 1.5 2.6-1.1.9a6.5 6.5 0 0 1 0 1.9ZM11.2 8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Z" /></svg>;
}

function NodesIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 2.8h12a1.7 1.7 0 0 1 1.7 1.7v3A1.7 1.7 0 0 1 16 9.2H4a1.7 1.7 0 0 1-1.7-1.7v-3A1.7 1.7 0 0 1 4 2.8Zm0 1.5a.2.2 0 0 0-.2.2v3c0 .1.1.2.2.2h12a.2.2 0 0 0 .2-.2v-3a.2.2 0 0 0-.2-.2H4Zm0 6.5h12a1.7 1.7 0 0 1 1.7 1.7v3a1.7 1.7 0 0 1-1.7 1.7H4a1.7 1.7 0 0 1-1.7-1.7v-3A1.7 1.7 0 0 1 4 10.8Zm0 1.5a.2.2 0 0 0-.2.2v3c0 .1.1.2.2.2h12a.2.2 0 0 0 .2-.2v-3a.2.2 0 0 0-.2-.2H4Zm1.2-6.8h1.6V7H5.2V5.5Zm0 8h1.6V15H5.2v-1.5Z" /></svg>;
}

function PinIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12.8 3.2 4 4-1.4 1.4-1-.3-2.6 2.6.5 2-1 1-2.1-2.1-4.6 4.6-1-1 4.6-4.6-2.1-2.1 1-1 2 .5 2.6-2.6-.3-1 1.4-1.4Z" /></svg>;
}

function nodeShortLabel(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const characters = Array.from(trimmed);
  if (/^[\p{Script=Han}]/u.test(trimmed)) return characters[0] ?? "?";
  return characters.slice(0, 2).join("").toUpperCase();
}

function reactNodeText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(reactNodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(value)) return reactNodeText(value.props.children);
  return "";
}

export function normalizeMathMarkdown(source: string): string {
  let fence: { marker: string; length: number } | null = null;
  return source.split("\n").map((line) => {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] ?? "`";
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (fence.marker === marker && fenceMatch[1].length >= fence.length) fence = null;
      return line;
    }
    if (fence) return line;

    let normalized = "";
    let inlineCodeTicks = 0;
    for (let index = 0; index < line.length;) {
      if (line[index] === "`") {
        let count = 1;
        while (line[index + count] === "`") count += 1;
        normalized += line.slice(index, index + count);
        if (inlineCodeTicks === 0) inlineCodeTicks = count;
        else if (inlineCodeTicks === count) inlineCodeTicks = 0;
        index += count;
        continue;
      }
      if (inlineCodeTicks === 0 && line[index] === "\\") {
        const delimiter = line[index + 1];
        if (delimiter === "(" || delimiter === ")") {
          normalized += "$";
          index += 2;
          continue;
        }
        if (delimiter === "[" || delimiter === "]") {
          normalized += "$$";
          index += 2;
          continue;
        }
      }
      normalized += line[index];
      index += 1;
    }
    return normalized;
  }).join("\n");
}

async function copyToClipboard(value: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Remote HTTP pages can deny the Clipboard API, so keep a DOM fallback.
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("浏览器不允许复制");
}

export function previewLineNumberText(source: string): string {
  const content = source.replace(/(?:\r\n|\n|\r)$/u, "");
  const lineCount = content ? content.split(/\r\n|\n|\r/u).length : 1;
  if (lineCount > 100_000) return "";
  return Array.from({ length: lineCount }, (_, index) => String(index + 1)).join("\n");
}

function CopyableCodeBlock({
  children,
  node: _node,
  showLineNumbers = false,
  highlightedLine = null,
  lineAnchorPrefix,
  ...props
}: ComponentPropsWithoutRef<"pre"> & {
  node?: unknown;
  showLineNumbers?: boolean;
  highlightedLine?: number | null;
  lineAnchorPrefix?: string;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const code = reactNodeText(children).replace(/\n$/, "");
  const lineNumbers = showLineNumbers ? previewLineNumberText(code) : "";
  const lineNumberValues = lineNumbers ? lineNumbers.split("\n") : [];
  const hasHighlightedLine = highlightedLine !== null && highlightedLine >= 1 && highlightedLine <= lineNumberValues.length;
  const codeElement = Children.toArray(children).find((child) => isValidElement(child));
  const className = isValidElement<{ className?: string }>(codeElement) ? codeElement.props.className ?? "" : "";
  const language = /(?:^|\s)language-([^\s]+)/.exec(className)?.[1] ?? "代码";

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  return (
    <div className="code-block">
      <div className="code-block-toolbar">
        <span>{language}</span>
        <button
          type="button"
          onClick={() => {
            void copyToClipboard(code)
              .then(() => setCopyState("copied"))
              .catch(() => setCopyState("failed"));
          }}
          aria-label="复制代码"
        >
          {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制"}
        </button>
      </div>
      <div className={`code-block-scroll ${lineNumbers ? "with-line-numbers" : ""}`}>
        {lineNumbers && <pre className="code-line-numbers" aria-hidden="true">{hasHighlightedLine ? <>
          {lineNumberValues.slice(0, highlightedLine - 1).join("\n")}{highlightedLine > 1 ? "\n" : ""}
          <span id={lineAnchorPrefix ? `${lineAnchorPrefix}-${highlightedLine}` : undefined} className="code-line-number-target">{highlightedLine}</span>
          {highlightedLine < lineNumberValues.length ? `\n${lineNumberValues.slice(highlightedLine).join("\n")}` : ""}
        </> : lineNumbers}</pre>}
        <pre {...props} className={[props.className, "code-block-content"].filter(Boolean).join(" ")}>{children}</pre>
      </div>
    </div>
  );
}

const markdownIdPrefix = "cc-md-";
const markdownSanitizeSchema = {
  ...defaultSchema,
  clobberPrefix: markdownIdPrefix,
  tagNames: [...new Set([...(defaultSchema.tagNames ?? []), "details", "summary"])],
  attributes: {
    ...defaultSchema.attributes,
    details: [...(defaultSchema.attributes?.details ?? []), "open"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...new Set([...(defaultSchema.protocols?.href ?? []), "file", "ftp", "http", "https", "mailto", "ssh", "tel", "ws", "wss"])],
    src: [...new Set([...(defaultSchema.protocols?.src ?? []), "file", "http", "https"])],
  },
};

let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;
let mermaidConfigured = false;
let mermaidRenderSequence = 0;

function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/gu, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSvg(null);
    setError(null);
    mermaidModulePromise ??= import("mermaid");
    void mermaidModulePromise
      .then(async ({ default: mermaid }) => {
        if (!mermaidConfigured) {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: "neutral",
            suppressErrorRendering: true,
          });
          mermaidConfigured = true;
        }
        const renderId = `cc-mermaid-${reactId}-${++mermaidRenderSequence}`;
        return mermaid.render(renderId, source);
      })
      .then((result) => {
        if (active) setSvg(result.svg);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "Mermaid 图表渲染失败");
      });
    return () => { active = false; };
  }, [reactId, source]);

  if (error) return <div className="mermaid-error"><strong>Mermaid 图表渲染失败</strong><span>{error}</span><pre>{source}</pre></div>;
  if (!svg) return <div className="mermaid-loading"><span className="loading-spinner" />正在渲染 Mermaid 图表…</div>;
  return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function MarkdownPre({
  children,
  node: _node,
  showLineNumbers = false,
  highlightedLine = null,
  lineAnchorPrefix,
  ...props
}: ComponentPropsWithoutRef<"pre"> & {
  node?: unknown;
  showLineNumbers?: boolean;
  highlightedLine?: number | null;
  lineAnchorPrefix?: string;
}) {
  const codeElement = Children.toArray(children).find((child) => isValidElement<{ className?: string; children?: ReactNode }>(child));
  const className = isValidElement<{ className?: string }>(codeElement) ? codeElement.props.className ?? "" : "";
  if (/(?:^|\s)language-mermaid(?:\s|$)/u.test(className)) {
    return <MermaidDiagram source={reactNodeText(codeElement).replace(/\n$/u, "")} />;
  }
  return <CopyableCodeBlock
    {...props}
    showLineNumbers={showLineNumbers}
    highlightedLine={highlightedLine}
    lineAnchorPrefix={lineAnchorPrefix}
  >{children}</CopyableCodeBlock>;
}

const embeddedResourceFileLimit = 50;
const embeddedResourceByteLimit = 32 * 1024 * 1024;
const embeddedResourceConcurrency = 4;

interface LoadedEmbeddedResource {
  file: WorkspaceFileDescriptor;
  blob: Blob;
  objectUrl: string;
}

class EmbeddedWorkspaceResourceLoader {
  private readonly pending = new Map<string, Promise<LoadedEmbeddedResource>>();
  private readonly objectUrls = new Set<string>();
  private readonly queue: Array<() => void> = [];
  private active = 0;
  private totalBytes = 0;
  private disposed = false;

  constructor(private readonly conversationId: string) {}

  load(path: string, baseFileId?: string): Promise<LoadedEmbeddedResource> {
    if (this.disposed) return Promise.reject(new Error("文档预览已经关闭"));
    const key = `${baseFileId ?? ""}\0${path}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    if (this.pending.size >= embeddedResourceFileLimit) {
      return Promise.reject(new Error(`单个文档最多自动加载 ${embeddedResourceFileLimit} 个关联文件`));
    }
    const request = this.schedule(async () => {
      if (this.disposed) throw new Error("文档预览已经关闭");
      const file = await openWorkspaceFile(this.conversationId, path, baseFileId, { recordHistory: false });
      if (this.totalBytes + file.size > embeddedResourceByteLimit) {
        throw new Error("文档关联文件合计超过 32 MiB，已停止自动加载");
      }
      this.totalBytes += file.size;
      let blob: Blob;
      try {
        blob = await fetchWorkspaceFileContent(file);
      } catch (error) {
        this.totalBytes -= file.size;
        throw error;
      }
      const objectUrl = URL.createObjectURL(blob);
      if (this.disposed) {
        URL.revokeObjectURL(objectUrl);
        throw new Error("文档预览已经关闭");
      }
      this.objectUrls.add(objectUrl);
      return { file, blob, objectUrl };
    }).catch((error) => {
      this.pending.delete(key);
      throw error;
    });
    this.pending.set(key, request);
    return request;
  }

  dispose(): void {
    this.disposed = true;
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.clear();
    this.pending.clear();
  }

  private schedule<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active += 1;
        void work().then(resolve, reject).finally(() => {
          this.active -= 1;
          this.queue.shift()?.();
        });
      };
      if (this.active < embeddedResourceConcurrency) start();
      else this.queue.push(start);
    });
  }
}

function LocalMarkdownImage({
  src,
  alt,
  baseFileId,
  loadResource,
  onOpen,
}: {
  src: string;
  alt: string;
  baseFileId?: string;
  loadResource: (path: string, baseFileId?: string) => Promise<LoadedEmbeddedResource>;
  onOpen?: (path: string, baseFileId?: string) => void;
}) {
  const [resource, setResource] = useState<LoadedEmbeddedResource | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setResource(null);
    setError(null);
    void loadResource(src, baseFileId)
      .then((value) => { if (active) setResource(value); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "图片读取失败"); });
    return () => { active = false; };
  }, [baseFileId, loadResource, src]);

  if (error) return <button className="local-image-error" type="button" title={error} onClick={() => onOpen?.(src, baseFileId)}>图片加载失败：{alt || src}</button>;
  if (!resource) return <span className="local-image-loading"><span className="loading-spinner" />正在读取图片…</span>;
  return <button className="local-image-preview" type="button" title="在新标签页打开图片" onClick={() => onOpen?.(src, baseFileId)}>
    <img src={resource.objectUrl} alt={alt} loading="lazy" />
  </button>;
}

const uriSchemePattern = /^([a-z][a-z\d+.-]*):/iu;
const unsafeUriSchemes = new Set(["javascript", "data", "vbscript"]);

export interface WorkspaceFileReference {
  path: string;
  line: number | null;
  column: number | null;
}

function looksLikeWorkspaceFilePath(value: string): boolean {
  const path = value.trim();
  if (!path || path.includes("\n")) return false;
  if (/^file:/iu.test(path) || /^[a-z]:[\\/]/iu.test(path) || path.startsWith("\\\\")) return true;
  if (path.startsWith("/") || path.startsWith("./") || path.startsWith("../")) return true;
  if (path.includes("/") || path.includes("\\")) return true;
  return /(?:^|[\\/])(?:[^\\/]+\.[\p{L}][\p{L}\d]{0,15}|Dockerfile|Makefile|Jenkinsfile|Procfile|Gemfile|Rakefile)$/iu.test(path);
}

function strongInlineWorkspaceFilePath(value: string): boolean {
  const path = value.trim();
  return /^file:/iu.test(path)
    || /^[a-z]:[\\/]/iu.test(path)
    || path.startsWith("\\\\")
    || path.startsWith("/")
    || path.startsWith("./")
    || path.startsWith("../")
    || /(?:^|[\\/])(?:[^\\/]+\.[\p{L}][\p{L}\d]{0,15}|Dockerfile|Makefile|Jenkinsfile|Procfile|Gemfile|Rakefile)$/iu.test(path);
}

export function parseWorkspaceFileReference(value: string): WorkspaceFileReference {
  const original = value.trim();
  const candidate = original.replace(/[,.，。;；!！?？、]+$/u, "");
  const location = /^(.*?)(?:#L([1-9]\d*)(?:C([1-9]\d*))?(?:-L[1-9]\d*(?:C[1-9]\d*)?)?|:([1-9]\d*)(?::([1-9]\d*))?)$/iu.exec(candidate);
  const referencedPath = location?.[1] ?? "";
  const externalScheme = uriSchemePattern.exec(referencedPath)?.[1]?.toLowerCase();
  if (!location
    || !looksLikeWorkspaceFilePath(referencedPath)
    || externalScheme && externalScheme !== "file" && !/^[a-z]:[\\/]/iu.test(referencedPath)) {
    return { path: original, line: null, column: null };
  }
  const line = Number(location[2] ?? location[4]);
  const columnValue = location[3] ?? location[5];
  const column = columnValue ? Number(columnValue) : null;
  if (!Number.isSafeInteger(line) || line < 1 || column !== null && (!Number.isSafeInteger(column) || column < 1)) {
    return { path: original, line: null, column: null };
  }
  return { path: referencedPath, line, column };
}

export function isLocalWorkspaceHref(value: string): boolean {
  const href = value.trim();
  if (!href || href.startsWith("#") || href.startsWith("//")) return false;
  if (/^[a-z]:[\\/]/iu.test(href) || href.startsWith("\\\\")) return true;
  const scheme = uriSchemePattern.exec(href)?.[1]?.toLowerCase();
  return scheme ? scheme === "file" : true;
}

function isUnsafeHref(value: string): boolean {
  const scheme = uriSchemePattern.exec(value.trim())?.[1]?.toLowerCase();
  return Boolean(scheme && unsafeUriSchemes.has(scheme));
}

function safeMarkdownUrl(value: string): string {
  return isUnsafeHref(value) ? "" : value;
}

interface MarkdownAstNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownAstNode[];
  data?: { hProperties?: Record<string, unknown> };
  position?: {
    start?: { line?: number };
    end?: { line?: number };
  };
}

function fileReferenceNodes(value: string): MarkdownAstNode[] | null {
  const pattern = /(^|[^\p{L}\p{N}_./\\-])((?:(?:\.{0,2}[\\/]|[A-Za-z]:[\\/]|[\\/])?[^\s`"'<>()[\]{},，。；;！!?？、:：]+(?:[\\/][^\s`"'<>()[\]{},，。；;！!?？、:：]+)+|[\p{L}\p{N}_@.+~-]+\.[\p{L}][\p{L}\p{N}]{0,15})(?::[1-9]\d*(?::[1-9]\d*)?|#L[1-9]\d*(?:C[1-9]\d*)?))/giu;
  const nodes: MarkdownAstNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    const prefix = match[1] ?? "";
    const reference = match[2] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    const parsed = parseWorkspaceFileReference(reference);
    if (!parsed.line || !isLocalWorkspaceHref(parsed.path)) continue;
    if (start > offset) nodes.push({ type: "text", value: value.slice(offset, start) });
    nodes.push({
      type: "link",
      url: reference.includes("/") || reference.includes("\\") ? reference : `./${reference}`,
      children: [{ type: "text", value: reference }],
    });
    offset = start + reference.length;
  }
  if (!nodes.length) return null;
  if (offset < value.length) nodes.push({ type: "text", value: value.slice(offset) });
  return nodes;
}

function remarkWorkspaceFileReferences() {
  const protectedTypes = new Set(["code", "definition", "html", "image", "imageReference", "link", "linkReference"]);
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (node.type === "link" && node.url) {
        const parsed = parseWorkspaceFileReference(node.url);
        if (parsed.line && !node.url.includes("/") && !node.url.includes("\\")) node.url = `./${node.url}`;
      }
      if (!node.children || protectedTypes.has(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === "text" && child.value) return fileReferenceNodes(child.value) ?? [child];
        visit(child);
        return [child];
      });
    };
    visit(tree);
  };
}

function remarkRenderedSourceLine(options?: { line?: number | null }) {
  const line = options?.line;
  const blockTypes = new Set(["blockquote", "code", "heading", "list", "listItem", "paragraph", "table", "tableRow", "thematicBreak"]);
  return (tree: MarkdownAstNode) => {
    if (!line || line < 1) return;
    let best: { node: MarkdownAstNode; contains: boolean; distance: number; span: number } | null = null;
    const visit = (node: MarkdownAstNode) => {
      const start = node.position?.start?.line;
      const end = node.position?.end?.line;
      if (blockTypes.has(node.type) && start && end) {
        const contains = start <= line && line <= end;
        const distance = contains ? 0 : Math.min(Math.abs(line - start), Math.abs(line - end));
        const span = end - start;
        if (!best
          || contains && !best.contains
          || contains === best.contains && distance < best.distance
          || contains === best.contains && distance === best.distance && span < best.span) {
          best = { node, contains, distance, span };
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
    const target = (best as { node: MarkdownAstNode } | null)?.node;
    if (!target) return;
    target.data ??= {};
    target.data.hProperties = {
      ...target.data.hProperties,
      id: "workspace-markdown-source-target",
    };
  };
}

interface MarkdownContentProps {
  children: string;
  baseFileId?: string;
  onOpenLocalPath?: (path: string, baseFileId?: string) => void;
  loadEmbeddedResource?: (path: string, baseFileId?: string) => Promise<LoadedEmbeddedResource>;
  showCodeLineNumbers?: boolean;
  highlightedLine?: number | null;
  lineAnchorPrefix?: string;
  renderedSourceLine?: number | null;
}

function MarkdownContent({
  children,
  baseFileId,
  onOpenLocalPath,
  loadEmbeddedResource,
  showCodeLineNumbers = false,
  highlightedLine = null,
  lineAnchorPrefix,
  renderedSourceLine = null,
}: MarkdownContentProps) {
  const markdown = useMemo(() => normalizeMathMarkdown(children), [children]);
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          remarkMath,
          remarkWorkspaceFileReferences,
          [remarkRenderedSourceLine, { line: renderedSourceLine }],
        ]}
        rehypePlugins={[
          rehypeRaw,
          rehypeSlug,
          [rehypeSanitize, markdownSanitizeSchema],
          [rehypeKatex, { strict: false, throwOnError: false }],
          rehypeHighlight,
        ]}
        urlTransform={safeMarkdownUrl}
        components={{
          pre: showCodeLineNumbers
            ? (props) => <MarkdownPre {...props} showLineNumbers highlightedLine={highlightedLine} lineAnchorPrefix={lineAnchorPrefix} />
            : MarkdownPre,
          a: ({ href = "", children: linkChildren, node: _node, ...props }) => {
            if (!href || isUnsafeHref(href)) return <span>{linkChildren}</span>;
            if (href.startsWith("#")) return <a {...props} href={`#${markdownIdPrefix}${href.slice(1)}`}>{linkChildren}</a>;
            if (isLocalWorkspaceHref(href) && onOpenLocalPath) {
              return <a
                {...props}
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                onClick={(event) => {
                  event.preventDefault();
                  onOpenLocalPath(href, baseFileId);
                }}
              >{linkChildren}</a>;
            }
            return <a {...props} href={href} target="_blank" rel="noreferrer noopener">{linkChildren}</a>;
          },
          code: ({ className, children: codeChildren, node: _node, ...props }) => {
            const reference = reactNodeText(codeChildren).trim();
            const parsed = parseWorkspaceFileReference(reference);
            const isInlineReference = !className
              && !reference.includes("\n")
              && isLocalWorkspaceHref(parsed.path)
              && (parsed.line !== null || strongInlineWorkspaceFilePath(parsed.path));
            if (isInlineReference && onOpenLocalPath) {
              const location = parsed.line ? `，第 ${parsed.line} 行${parsed.column ? `第 ${parsed.column} 列` : ""}` : "";
              return <a
                className="local-file-reference"
                href={reference}
                title={`打开 Agent 文件${location}`}
                onClick={(event) => {
                  event.preventDefault();
                  onOpenLocalPath(reference, baseFileId);
                }}
              ><code {...props}>{codeChildren}</code></a>;
            }
            return <code {...props} className={className}>{codeChildren}</code>;
          },
          img: ({ src = "", alt = "", node: _node, ...props }) => {
            if (!src || isUnsafeHref(src)) return <span className="local-image-unavailable">图片地址不可用</span>;
            if (isLocalWorkspaceHref(src) && loadEmbeddedResource) {
              return <LocalMarkdownImage
                src={src}
                alt={alt}
                baseFileId={baseFileId}
                loadResource={loadEmbeddedResource}
                onOpen={onOpenLocalPath}
              />;
            }
            if (isLocalWorkspaceHref(src) && onOpenLocalPath) {
              return <button
                className="local-image-button"
                type="button"
                title={src}
                onClick={() => onOpenLocalPath(src, baseFileId)}
              >查看 Agent 图片：{alt || src}</button>;
            }
            return <img {...props} src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" />;
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

export function parseDelimitedPreview(source: string, delimiter: "," | "\t"): { rows: string[][]; truncated: boolean } {
  const input = source.replace(/^\uFEFF/u, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let truncated = false;
  const pushRow = () => {
    row.push(cell);
    rows.push(row.slice(0, 100));
    if (row.length > 100) truncated = true;
    row = [];
    cell = "";
  };
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      pushRow();
      if (rows.length >= 1_001) {
        truncated = index < input.length - 1;
        break;
      }
    } else {
      cell += character;
    }
  }
  if (rows.length < 1_001 && (cell || row.length > 0)) pushRow();
  return { rows, truncated };
}

const sourceLanguageByExtension: Record<string, string> = {
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  py: "python", pyw: "python",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript",
  go: "go", rs: "rust", java: "java",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hxx: "cpp",
  cs: "csharp", rb: "ruby", php: "php", pl: "perl", pm: "perl", lua: "lua",
  swift: "swift", kt: "kotlin", kts: "kotlin", scala: "scala", sql: "sql", r: "r", dart: "dart",
  css: "css", json: "json", yaml: "yaml", yml: "yaml", xml: "xml", toml: "ini", ini: "ini",
  conf: "ini", env: "ini", properties: "ini", gradle: "groovy", graphql: "graphql", gql: "graphql",
  proto: "protobuf", tf: "hcl", tfvars: "hcl", diff: "diff", patch: "diff",
  vue: "html", svelte: "html",
};

const sourceLanguageByName: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  "cmakelists.txt": "cmake",
  jenkinsfile: "groovy",
  procfile: "bash",
  gemfile: "ruby",
  rakefile: "ruby",
  ".gitignore": "plaintext",
  ".dockerignore": "plaintext",
  ".editorconfig": "ini",
};

function sourceLanguage(file: WorkspaceFileDescriptor): string | null {
  const lowerName = file.name.toLowerCase();
  const named = sourceLanguageByName[lowerName];
  if (named) return named;
  const extension = lowerName.match(/\.([^.]+)$/u)?.[1] ?? "";
  return sourceLanguageByExtension[extension] ?? null;
}

function fencedSource(content: string, language: string): string {
  const longestTildes = Math.max(3, ...(content.match(/~+/gu) ?? []).map((value) => value.length));
  const fence = "~".repeat(longestTildes + 1);
  return `${fence}${language}\n${content}${content.endsWith("\n") ? "" : "\n"}${fence}`;
}

function workspaceFilePreviewPath(fileId: string, location?: Pick<WorkspaceFileReference, "line" | "column">): string {
  const parameters = new URLSearchParams();
  if (location?.line) parameters.set("line", String(location.line));
  if (location?.column) parameters.set("column", String(location.column));
  const suffix = parameters.size ? `?${parameters}` : "";
  return `/workspace-files/${encodeURIComponent(fileId)}${suffix}`;
}

function workspaceFileOpeningPath(conversationId: string, path: string, baseFileId?: string): string {
  const parameters = new URLSearchParams({ conversationId, path });
  if (baseFileId) parameters.set("baseFileId", baseFileId);
  return `/workspace-files/opening?${parameters}`;
}

function openWorkspaceFileTab(conversationId: string, path: string, baseFileId?: string): boolean {
  const openingUrl = new URL(workspaceFileOpeningPath(conversationId, path, baseFileId), window.location.origin).toString();
  const previewWindow = window.open(openingUrl, "_blank");
  if (!previewWindow) return false;
  previewWindow.opener = null;
  return true;
}

interface WorkspaceFileOpenFailure {
  title: string;
  message: string;
  path: string;
  hint?: string;
}

function workspaceFileDisplayName(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/u, "");
  const name = trimmed.split(/[\\/]/u).at(-1) || trimmed || "目标文件";
  try { return decodeURIComponent(name); } catch { return name; }
}

function describeWorkspaceFileOpenFailure(reason: unknown, filePath: string): WorkspaceFileOpenFailure {
  const name = workspaceFileDisplayName(filePath);
  const code = reason instanceof ApiError ? reason.code : null;
  if (code === "not_found") return {
    title: "文件不存在",
    message: `Agent 上未找到“${name}”。`,
    path: filePath,
    hint: "请确认文件名、相对路径及字母大小写是否正确。",
  };
  if (code === "too_large") return {
    title: "文件过大",
    message: `“${name}”超过当前 8 MB 的在线预览上限。`,
    path: filePath,
    hint: "请缩小文件后重试，或在 Agent 所在机器上直接查看。",
  };
  if (code === "forbidden") return {
    title: "无权读取文件",
    message: `Agent 无法读取“${name}”。`,
    path: filePath,
    hint: reason instanceof Error ? reason.message : "请检查文件权限和路径范围。",
  };
  if (code === "not_file") return {
    title: "目标不是文件",
    message: `“${name}”指向的不是普通文件。`,
    path: filePath,
    hint: "请选择具体文件，而不是目录或设备。",
  };
  if (code === "agent_offline") return {
    title: "Agent 当前离线",
    message: `暂时无法读取“${name}”。`,
    path: filePath,
    hint: "请等待对应节点恢复在线后重试。",
  };
  if (code === "agent_upgrade_required") return {
    title: "Agent 需要升级",
    message: `当前 Agent 版本不支持预览“${name}”。`,
    path: filePath,
    hint: "请升级并重启 Agent 后重试。",
  };
  if (code === "base_file_expired") return {
    title: "原文件预览已失效",
    message: `无法确定“${name}”的相对路径。`,
    path: filePath,
    hint: "请从对话中重新打开原文件，再点击其中的链接。",
  };
  if (code === "invalid_file_path") return {
    title: "文件路径无效",
    message: `无法识别“${name}”的文件路径。`,
    path: filePath,
  };
  if (code === "workspace_file_rate_limited") return {
    title: "文件打开过于频繁",
    message: `暂时无法打开“${name}”。`,
    path: filePath,
    hint: "请稍后再试。",
  };
  return {
    title: "文件读取失败",
    message: reason instanceof Error && reason.message ? reason.message : `无法读取“${name}”。`,
    path: filePath,
    hint: "请确认 Agent 在线、文件路径正确且当前用户拥有读取权限。",
  };
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("文件编码失败"));
    reader.onerror = () => reject(reader.error ?? new Error("文件编码失败"));
    reader.readAsDataURL(blob);
  });
}

async function embeddedResourceDataUrl(
  path: string,
  baseFileId: string,
  loader: EmbeddedWorkspaceResourceLoader,
  cssDepth = 0,
): Promise<string> {
  const resource = await loader.load(path, baseFileId);
  const mediaType = resource.file.mediaType.split(";", 1)[0]?.toLowerCase();
  if (mediaType === "text/css" && cssDepth < 4) {
    const rewritten = await rewriteCssEmbeddedUrls(await resource.blob.text(), resource.file.id, loader, cssDepth + 1);
    return blobDataUrl(new Blob([rewritten], { type: "text/css;charset=utf-8" }));
  }
  return blobDataUrl(resource.blob);
}

export async function rewriteCssEmbeddedUrls(
  source: string,
  baseFileId: string,
  loader: EmbeddedWorkspaceResourceLoader,
  cssDepth = 0,
): Promise<string> {
  const matches = [...source.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/giu)];
  if (!matches.length) return source;
  let result = "";
  let offset = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    const reference = match[2]?.trim() ?? "";
    result += source.slice(offset, index);
    if (!reference || !isLocalWorkspaceHref(reference) || isUnsafeHref(reference)) {
      result += match[0];
    } else {
      try {
        const dataUrl = await embeddedResourceDataUrl(reference, baseFileId, loader, cssDepth);
        result += `url("${dataUrl}")`;
      } catch {
        result += match[0];
      }
    }
    offset = index + match[0].length;
  }
  return result + source.slice(offset);
}

async function prepareHtmlPreviewDocument(
  source: string,
  file: WorkspaceFileDescriptor,
  loader: EmbeddedWorkspaceResourceLoader,
): Promise<string> {
  const document = new DOMParser().parseFromString(source, "text/html");
  document.querySelectorAll("base, meta[http-equiv='content-security-policy' i]").forEach((element) => element.remove());

  const localDataUrl = (path: string, baseFileId = file.id) => embeddedResourceDataUrl(path, baseFileId, loader);
  const rewriteAttribute = async (element: Element, attribute: string, baseFileId = file.id) => {
    const value = element.getAttribute(attribute)?.trim() ?? "";
    if (!value || !isLocalWorkspaceHref(value) || isUnsafeHref(value)) return;
    try {
      element.setAttribute(attribute, await localDataUrl(value, baseFileId));
    } catch (reason) {
      element.removeAttribute(attribute);
      element.setAttribute("data-controller-center-resource-error", reason instanceof Error ? reason.message : "资源读取失败");
    }
  };

  const directResources: Array<[Element, string]> = [];
  document.querySelectorAll("img[src], input[type='image'][src], source[src], video[src], video[poster], audio[src], track[src]").forEach((element) => {
    for (const attribute of ["src", "poster"]) if (element.hasAttribute(attribute)) directResources.push([element, attribute]);
  });
  await Promise.all(directResources.map(([element, attribute]) => rewriteAttribute(element, attribute)));

  await Promise.all([...document.querySelectorAll("img[srcset], source[srcset]")].map(async (element) => {
    const candidates = (element.getAttribute("srcset") ?? "").split(",").map((candidate) => candidate.trim()).filter(Boolean);
    const rewritten = await Promise.all(candidates.map(async (candidate) => {
      const match = /^(\S+)(\s+.+)?$/u.exec(candidate);
      const reference = match?.[1] ?? "";
      if (!reference || !isLocalWorkspaceHref(reference) || isUnsafeHref(reference)) return candidate;
      try { return `${await localDataUrl(reference)}${match?.[2] ?? ""}`; } catch { return ""; }
    }));
    const usable = rewritten.filter(Boolean).join(", ");
    if (usable) element.setAttribute("srcset", usable);
    else element.removeAttribute("srcset");
  }));

  await Promise.all([...document.querySelectorAll("style")].map(async (element) => {
    element.textContent = await rewriteCssEmbeddedUrls(element.textContent ?? "", file.id, loader);
  }));
  await Promise.all([...document.querySelectorAll<HTMLElement>("[style]")].map(async (element) => {
    element.setAttribute("style", await rewriteCssEmbeddedUrls(element.getAttribute("style") ?? "", file.id, loader));
  }));

  await Promise.all([...document.querySelectorAll<HTMLLinkElement>("link[rel~='stylesheet'][href]")].map(async (link) => {
    const href = link.getAttribute("href")?.trim() ?? "";
    if (!href || !isLocalWorkspaceHref(href) || isUnsafeHref(href)) return;
    try {
      const stylesheet = await loader.load(href, file.id);
      const style = document.createElement("style");
      style.textContent = await rewriteCssEmbeddedUrls(await stylesheet.blob.text(), stylesheet.file.id, loader, 1);
      link.replaceWith(style);
    } catch (reason) {
      link.replaceWith(document.createComment(`本地样式读取失败：${reason instanceof Error ? reason.message : href}`));
    }
  }));

  await Promise.all([...document.querySelectorAll<HTMLScriptElement>("script[src]")].map(async (script) => {
    const src = script.getAttribute("src")?.trim() ?? "";
    if (!src || !isLocalWorkspaceHref(src) || isUnsafeHref(src)) return;
    try {
      const resource = await loader.load(src, file.id);
      script.removeAttribute("src");
      script.removeAttribute("integrity");
      script.removeAttribute("crossorigin");
      script.textContent = `${await resource.blob.text()}\n//# sourceURL=${resource.file.name.replace(/[\r\n]/gu, "_")}`;
    } catch (reason) {
      script.removeAttribute("src");
      script.textContent = `console.error(${JSON.stringify(`本地脚本读取失败：${reason instanceof Error ? reason.message : src}`)});`;
    }
  }));

  for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = anchor.getAttribute("href")?.trim() ?? "";
    if (!href || isUnsafeHref(href)) {
      anchor.removeAttribute("href");
      continue;
    }
    if (href.startsWith("#")) continue;
    anchor.target = "_blank";
    anchor.rel = "noreferrer noopener";
    if (isLocalWorkspaceHref(href)) {
      anchor.href = new URL(workspaceFileOpeningPath(file.conversationId, href, file.id), window.location.origin).toString();
    }
  }

  const securityPolicy = document.createElement("meta");
  securityPolicy.httpEquiv = "Content-Security-Policy";
  securityPolicy.content = [
    "default-src 'none'",
    "img-src data: blob: https: http:",
    "style-src 'unsafe-inline' data: https: http:",
    "font-src data: https: http:",
    "script-src 'unsafe-inline' data: blob: https: http:",
    "connect-src https: http: wss: ws:",
    "media-src data: blob: https: http:",
    "frame-src data: blob: https: http:",
    "worker-src data: blob:",
    "form-action https: http:",
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
  document.head.prepend(securityPolicy);
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

function WorkspaceFileLoadingCard() {
  return (
    <section className="workspace-file-loading-card" role="status" aria-live="polite">
      <div className="workspace-file-loader" aria-hidden="true"><span /></div>
      <span className="workspace-file-loading-label">AGENT 文件预览</span>
      <h1>正在读取文件</h1>
      <p>正在通过当前会话连接对应 Agent，并准备安全的只读预览。</p>
      <small>文件不会写入控制中心数据库</small>
    </section>
  );
}

function WorkspaceFileOpeningPage() {
  const parameters = useMemo(() => new URLSearchParams(window.location.search), []);
  const openingStarted = useRef(false);
  const [failure, setFailure] = useState<WorkspaceFileOpenFailure | null>(() => parameters.get("state") === "error" ? {
    title: "文件读取失败",
    message: "未能读取目标文件。",
    path: parameters.get("path")?.trim() ?? "",
    hint: "请确认 Agent 在线和文件路径正确后重试。",
  } : null);

  useEffect(() => {
    const conversationId = parameters.get("conversationId")?.trim() ?? "";
    const reference = parseWorkspaceFileReference(parameters.get("path")?.trim() ?? "");
    const baseFileId = parameters.get("baseFileId")?.trim() || undefined;
    if (failure || openingStarted.current) return;
    if (!conversationId || !reference.path) {
      openingStarted.current = true;
      setFailure({
        title: "文件预览地址无效",
        message: "打开链接中缺少会话或文件路径信息。",
        path: reference.path,
      });
      return;
    }
    openingStarted.current = true;
    void openWorkspaceFile(conversationId, reference.path, baseFileId)
      .then((descriptor) => window.location.replace(workspaceFilePreviewPath(descriptor.id, reference)))
      .catch((reason) => setFailure(describeWorkspaceFileOpenFailure(reason, reference.path)));
  }, [failure, parameters]);

  return (
    <main className="workspace-file-transition-page">
      {failure ? <section className="workspace-file-loading-card workspace-file-loading-failed" role="alert">
        <div className="workspace-file-failed-mark" aria-hidden="true">!</div>
        <span className="workspace-file-loading-label">AGENT 文件预览</span>
        <h1>{failure.title}</h1>
        <p>{failure.message}</p>
        {failure.path && <code className="workspace-file-failure-path" title={failure.path}>{failure.path}</code>}
        {failure.hint && <small className="workspace-file-failure-hint">{failure.hint}</small>}
        <button type="button" onClick={() => window.close()}>关闭标签页</button>
      </section> : <WorkspaceFileLoadingCard />}
    </main>
  );
}

function WorkspaceFilePage({ fileId }: { fileId: string }) {
  const requestedLocation = useMemo(() => {
    const parameters = new URLSearchParams(window.location.search);
    const line = Number(parameters.get("line"));
    const column = Number(parameters.get("column"));
    return {
      line: Number.isSafeInteger(line) && line > 0 ? line : null,
      column: Number.isSafeInteger(column) && column > 0 ? column : null,
    };
  }, []);
  const [file, setFile] = useState<WorkspaceFileDescriptor | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [preparedHtml, setPreparedHtml] = useState<string | null>(null);
  const [htmlError, setHtmlError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkOpenError, setLinkOpenError] = useState<string | null>(null);
  const embeddedResourceLoader = useMemo(
    () => file ? new EmbeddedWorkspaceResourceLoader(file.conversationId) : null,
    [file],
  );

  useEffect(() => () => embeddedResourceLoader?.dispose(), [embeddedResourceLoader]);

  const loadEmbeddedResource = useCallback((path: string, baseFileId?: string) => {
    if (!embeddedResourceLoader) return Promise.reject(new Error("文档资源加载器尚未就绪"));
    return embeddedResourceLoader.load(path, baseFileId);
  }, [embeddedResourceLoader]);

  useEffect(() => {
    let active = true;
    let createdObjectUrl: string | null = null;
    setFile(null);
    setObjectUrl(null);
    setTextContent(null);
    setPreparedHtml(null);
    setHtmlError(null);
    setError(null);
    void getWorkspaceFile(fileId)
      .then(async (descriptor) => {
        const blob = await fetchWorkspaceFileContent(descriptor);
        if (!active) return;
        createdObjectUrl = URL.createObjectURL(blob);
        const mediaType = descriptor.mediaType.split(";", 1)[0]!.toLowerCase();
        const isText = mediaType.startsWith("text/")
          || ["application/json", "application/xml", "application/yaml", "application/toml"].includes(mediaType);
        setFile(descriptor);
        setObjectUrl(createdObjectUrl);
        if (isText) setTextContent(await blob.text());
      })
      .catch((reason) => {
        if (active) setError(formatErrorMessage(reason, "打开 Agent 文件"));
      });
    return () => {
      active = false;
      if (createdObjectUrl) URL.revokeObjectURL(createdObjectUrl);
    };
  }, [fileId]);

  const openNestedFile = useCallback((nestedPath: string, baseFileId?: string) => {
    if (!file) return;
    if (!openWorkspaceFileTab(file.conversationId, nestedPath, baseFileId)) {
      setLinkOpenError("浏览器阻止了文件预览标签页，请允许本站打开新窗口后重试");
      return;
    }
    setLinkOpenError(null);
  }, [file]);

  const mediaType = file?.mediaType.split(";", 1)[0]?.toLowerCase() ?? "";
  const extension = file?.name.match(/\.([^.]+)$/u)?.[1]?.toLowerCase() ?? "";
  const isMarkdown = mediaType === "text/markdown" || ["md", "markdown"].includes(extension);
  const isHtml = mediaType === "text/html" || ["html", "htm"].includes(extension);
  const isCsv = mediaType === "text/csv" || extension === "csv";
  const isTsv = mediaType === "text/tab-separated-values" || extension === "tsv";
  const language = file ? sourceLanguage(file) : null;
  const table = textContent !== null && (isCsv || isTsv)
    ? parseDelimitedPreview(textContent, isTsv ? "\t" : ",")
    : null;
  let visibleText = textContent;
  if (mediaType === "application/json" && textContent !== null) {
    try { visibleText = JSON.stringify(JSON.parse(textContent), null, 2); } catch { /* Keep the original invalid JSON visible. */ }
  }
  const sourcePreview = visibleText !== null && !isMarkdown && !isHtml && !isCsv && !isTsv;
  const sourcePreviewText = requestedLocation.line && textContent !== null ? textContent : visibleText;

  useEffect(() => {
    if (!file || !isHtml || textContent === null || !embeddedResourceLoader) {
      setPreparedHtml(null);
      setHtmlError(null);
      return;
    }
    let active = true;
    setPreparedHtml(null);
    setHtmlError(null);
    void prepareHtmlPreviewDocument(textContent, file, embeddedResourceLoader)
      .then((value) => { if (active) setPreparedHtml(value); })
      .catch((reason) => { if (active) setHtmlError(reason instanceof Error ? reason.message : "HTML 页面准备失败"); });
    return () => { active = false; };
  }, [embeddedResourceLoader, file, isHtml, textContent]);

  useEffect(() => {
    if (!requestedLocation.line || !isMarkdown && !sourcePreview) return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const target = isMarkdown
          ? document.querySelector<HTMLElement>('.workspace-file-preview [id$="workspace-markdown-source-target"]')
          : document.getElementById(`workspace-source-line-${requestedLocation.line}`);
        target?.scrollIntoView({ block: "center" });
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [isMarkdown, requestedLocation.line, sourcePreview, textContent]);

  const previewLayout = !file || error
    ? "status"
    : isMarkdown ? "document"
      : isHtml ? "html"
        : mediaType === "application/pdf" ? "media"
        : table ? "data"
          : mediaType.startsWith("image/") ? "image"
            : visibleText !== null ? "source"
              : "status";
  const previewKind = isMarkdown ? "Markdown"
    : isHtml ? "HTML"
      : isCsv ? "CSV"
        : isTsv ? "TSV"
          : mediaType === "application/pdf" ? "PDF"
            : mediaType.startsWith("image/") ? "图片"
              : language ? language.toUpperCase()
                : "文件";
  const previewBadge = isMarkdown ? "MD"
    : isHtml ? "HTML"
      : isCsv ? "CSV"
        : isTsv ? "TSV"
          : mediaType === "application/pdf" ? "PDF"
            : extension ? extension.slice(0, 4).toUpperCase()
              : "FILE";
  const fileSize = file ? `${(file.size / 1024).toFixed(file.size < 1024 ? 2 : 1)} KB` : "";

  return (
    <main className="workspace-file-page">
      <section className={`workspace-file-viewer ${isHtml ? "workspace-file-viewer-html" : ""}`} aria-label="Agent 文件预览">
        <header>
          <div className="workspace-file-brand">
            <span aria-hidden="true">A</span>
            <div>
              <strong>{isHtml && file ? file.name : "AGENT"}</strong>
              <small title={isHtml && file ? file.path : undefined}>{isHtml && file ? file.path : "文件预览"}</small>
            </div>
          </div>
          <div className="workspace-file-actions">
            {file && objectUrl && <a className="workspace-file-download" href={objectUrl} download={file.name}>下载</a>}
            <a className="workspace-file-home" href="/">控制中心</a>
            <button type="button" onClick={() => window.close()} aria-label="关闭文件预览">×</button>
          </div>
        </header>
        <div className={`workspace-file-body ${isHtml ? "workspace-file-body-html" : ""}`}>
          <div className={`workspace-file-content workspace-file-content-${previewLayout}`}>
            {file && !isHtml && <header className="workspace-file-meta">
              <span className="workspace-file-type-badge" aria-hidden="true">{previewBadge}</span>
              <div className="workspace-file-meta-copy">
                <h1 id="workspace-file-title">{file.name}</h1>
                <code title={file.path}>{file.path}</code>
              </div>
              <div className="workspace-file-facts" aria-label="文件信息">
                <span>{previewKind}</span>
                <span>{fileSize}</span>
                {requestedLocation.line && <span className="workspace-file-location">引用第 {requestedLocation.line} 行{requestedLocation.column ? ` · 第 ${requestedLocation.column} 列` : ""}</span>}
                <span>只读</span>
              </div>
            </header>}
            <div className="workspace-file-preview">
              {!file && !error && <WorkspaceFileLoadingCard />}
              {error && <div className="workspace-file-error" role="alert">{error}</div>}
              {htmlError && <div className="workspace-file-error" role="alert">{htmlError}</div>}
              {linkOpenError && <div className="workspace-file-link-error" role="alert">{linkOpenError}<button type="button" aria-label="关闭提示" onClick={() => setLinkOpenError(null)}>×</button></div>}
              {file && objectUrl && mediaType.startsWith("image/") && <img className="workspace-file-image" src={objectUrl} alt={file.name} />}
              {file && isMarkdown && textContent !== null && <MarkdownContent
                baseFileId={file.id}
                onOpenLocalPath={openNestedFile}
                loadEmbeddedResource={loadEmbeddedResource}
                renderedSourceLine={requestedLocation.line}
              >{textContent}</MarkdownContent>}
              {file && isHtml && textContent !== null && !preparedHtml && !htmlError && <WorkspaceFileLoadingCard />}
              {file && isHtml && preparedHtml && <iframe
                className="workspace-file-html"
                sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"
                referrerPolicy="no-referrer"
                srcDoc={preparedHtml}
                title={file.name}
              />}
              {file && table && <div className="workspace-file-table-wrap">
                <div className="workspace-file-table-summary"><strong>{Math.max(0, table.rows.length - 1)}</strong> 条记录 <span>·</span> <strong>{table.rows[0]?.length ?? 0}</strong> 个字段</div>
                <table className="workspace-file-table">
                  {table.rows[0] && <thead><tr><th className="workspace-file-row-number" title="记录序号">#</th>{table.rows[0].map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead>}
                  <tbody>{table.rows.slice(1).map((row, rowIndex) => <tr key={rowIndex}><th className="workspace-file-row-number" scope="row">{rowIndex + 1}</th>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
                </table>
                {table.truncated && <p>预览仅展示前 1000 条记录、100 列；可下载查看完整文件。</p>}
              </div>}
              {file && objectUrl && mediaType === "application/pdf" && <iframe className="workspace-file-pdf" src={objectUrl} title={file.name} />}
              {file && sourcePreviewText !== null && language && sourcePreview && <MarkdownContent
                showCodeLineNumbers
                highlightedLine={requestedLocation.line}
                lineAnchorPrefix="workspace-source-line"
              >{fencedSource(sourcePreviewText, language)}</MarkdownContent>}
              {file && sourcePreviewText !== null && !language && sourcePreview && <MarkdownContent
                showCodeLineNumbers
                highlightedLine={requestedLocation.line}
                lineAnchorPrefix="workspace-source-line"
              >{fencedSource(sourcePreviewText, "plaintext")}</MarkdownContent>}
              {file && objectUrl && textContent === null && !mediaType.startsWith("image/") && mediaType !== "application/pdf" && <div className="workspace-file-state">该文件类型暂不支持直接预览，请下载后查看。</div>}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function NodePanel({
  nodes,
  selectedId,
  onSelect,
  onRenamed,
  collapsed,
  onToggleCollapsed,
  taskEntries,
  unreadCount,
  taskCenterActive,
  onOpenSwitcher,
  onOpenTasks,
  onOpenSettings,
}: {
  nodes: NodeRecord[];
  selectedId: string | null;
  onSelect: (node: NodeRecord) => void;
  onRenamed: (node: NodeRecord) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  taskEntries: TaskCenterEntry[];
  unreadCount: number;
  taskCenterActive: boolean;
  onOpenSwitcher: () => void;
  onOpenTasks: () => void;
  onOpenSettings: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveName(event: FormEvent, node: NodeRecord) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await updateNodeName(node.id, draftName);
      onRenamed(updated);
      setEditingId(null);
    } catch (reason) {
      setError(formatErrorMessage(reason, "重命名节点"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="pane nodes-pane">
      <div className="brand">
        <div className="brand-mark">CC</div>
        <div className="brand-copy"><strong>Controller Center</strong><span>Codex 节点控制台</span></div>
      </div>
      <button
        className="sidebar-toggle node-toggle"
        type="button"
        onClick={onToggleCollapsed}
        aria-label={collapsed ? "展开节点栏" : "折叠节点栏"}
        title={collapsed ? "展开节点栏" : "折叠节点栏"}
      >
        {collapsed ? "›" : "‹"}
      </button>
      <div className="pane-heading"><span>节点</span><small>{nodes.filter((node) => node.status === "online").length} 在线</small></div>
      <div className="node-list">
        {nodes.map((node) => {
          const nodeAttention = taskEntries.filter((entry) => entry.nodeId === node.id && entry.unread).length;
          return (
          <div className="node-entry" key={node.id}>
            <div className="node-row">
              <button className={`node-card ${selectedId === node.id ? "selected" : ""}`} onClick={() => onSelect(node)}>
                <span className={`node-identity ${node.permissionMode === "danger-full-access" ? "full-access" : ""}`} title={`${node.name}${node.permissionMode === "danger-full-access" ? " · 全权限" : ""}`}>{nodeShortLabel(node.name)}{nodeAttention > 0 && <i>{nodeAttention > 9 ? "9+" : nodeAttention}</i>}</span>
                <span className={`presence ${node.status}`} />
                <span className="node-main">
                  <span className="node-title"><strong>{node.name}</strong>{node.permissionMode === "danger-full-access" && <em className="node-permission-badge" title="此节点启动时启用了 --yolo，不经过审批或 Codex 沙箱">全权限</em>}</span>
                  <small>{node.platform} · {node.arch}</small>
                </span>
                <span className="node-load">{node.activeRuns}/{node.maxConcurrentRuns}</span>
              </button>
              <button
                className="row-action"
                title="修改节点名称"
                aria-label={`修改 ${node.name} 的名称`}
                onClick={() => {
                  setEditingId(node.id);
                  setDraftName(node.name);
                  setError(null);
                }}
              >
                <PencilIcon />
              </button>
            </div>
            {editingId === node.id && (
              <form className="node-rename" onSubmit={(event) => void saveName(event, node)}>
                <div className="node-rename-head">
                  <div><strong>重命名节点</strong><span>仅修改控制中心里的显示名称</span></div>
                  <button type="button" onClick={() => setEditingId(null)} aria-label="关闭重命名">×</button>
                </div>
                <label className="node-rename-field">
                  <span>显示名称</span>
                  <input
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    placeholder={node.reportedName}
                    aria-label="节点显示名称"
                    maxLength={64}
                    autoFocus
                  />
                </label>
                <div className="node-rename-source">本机名称：{node.reportedName}</div>
                {error && <span className="form-error">{error}</span>}
                <div className="node-rename-actions">
                  <button type="button" className="rename-cancel" onClick={() => setEditingId(null)}>取消</button>
                  <button className="rename-save" disabled={busy || !draftName.trim()}>{busy ? "保存中…" : "保存"}</button>
                </div>
              </form>
            )}
          </div>
        )})}
        {nodes.length === 0 && <div className="empty compact">还没有 Agent 注册到控制中心。</div>}
      </div>
      <div className="node-footer">
        <button type="button" onClick={onOpenSwitcher} title="快速切换节点或会话"><SearchIcon /><span>快速切换</span><kbd>⌘K</kbd></button>
        <button className={taskCenterActive ? "active" : ""} type="button" onClick={onOpenTasks} title="全局任务中心"><BellIcon /><span>任务中心</span>{unreadCount > 0 && <b>{unreadCount > 99 ? "99+" : unreadCount}</b>}</button>
        <button type="button" onClick={onOpenSettings} title="设置"><SettingsIcon /><span>设置</span></button>
        <p className="agent-hint">节点凭据与 Codex 登录信息始终保留在本机。</p>
      </div>
    </aside>
  );
}

function ConversationPanel({
  node,
  conversations,
  pendingApprovals,
  selectedId,
  onSelect,
  onNew,
  onDelete,
  onUpdate,
  onBack,
  collapsed,
  onToggleCollapsed,
  query,
  onQueryChange,
  filter,
  onFilterChange,
  total,
  loading,
  hasMore,
  cacheLimited,
  onLoadMore,
}: {
  node: NodeRecord | null;
  conversations: Conversation[];
  pendingApprovals: Approval[];
  selectedId: string | null;
  onSelect: (conversation: Conversation) => void;
  onNew: () => void;
  onDelete: (conversation: Conversation) => Promise<void>;
  onUpdate: (conversation: Conversation, input: { title?: string; pinned?: boolean }) => Promise<void>;
  onBack: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  filter: "all" | "active" | "failed";
  onFilterChange: (filter: "all" | "active" | "failed") => void;
  total: number;
  loading: boolean;
  hasMore: boolean;
  cacheLimited: boolean;
  onLoadMore: () => void;
}) {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");

  useEffect(() => {
    setError(null);
  }, [node?.id]);

  async function remove(conversation: Conversation) {
    if (!window.confirm(`确定删除“${conversation.title}”吗？此操作会同时删除节点上的 Codex 会话。`)) return;
    setDeletingId(conversation.id);
    setError(null);
    try {
      await onDelete(conversation);
    } catch (reason) {
      setError(formatErrorMessage(reason, "删除会话"));
    } finally {
      setDeletingId(null);
    }
  }

  async function saveTitle(conversation: Conversation) {
    const title = titleDraft.trim();
    if (!title) return;
    setError(null);
    try {
      await onUpdate(conversation, { title });
      setEditingId(null);
    } catch (reason) {
      setError(formatErrorMessage(reason, "重命名会话"));
    }
  }

  async function togglePinned(conversation: Conversation): Promise<void> {
    setError(null);
    try {
      await onUpdate(conversation, { pinned: !conversation.pinnedAt });
    } catch (reason) {
      setError(formatErrorMessage(reason, conversation.pinnedAt ? "取消置顶会话" : "置顶会话"));
    }
  }

  return (
    <aside className="pane conversations-pane">
      <div className="mobile-pane-title">
        <button className="icon-button" onClick={onBack} aria-label="返回节点">‹</button>
        <span>历史会话</span>
      </div>
      <button
        className="sidebar-toggle history-toggle"
        type="button"
        onClick={onToggleCollapsed}
        aria-label={collapsed ? "展开历史会话" : "折叠历史会话"}
        title={collapsed ? "展开历史会话" : "折叠历史会话"}
      >
        {collapsed ? "›" : "‹"}
      </button>
      <div className="pane-heading">
        <div><span>{node?.name ?? "选择节点"}</span>{node && <small>{total} 个{query || filter !== "all" ? "匹配" : "历史"}会话</small>}</div>
        <span className="history-rail-label" aria-hidden="true">历史会话</span>
        <button className={`new-button ${node && !selectedId ? "active" : ""}`} disabled={!node} onClick={onNew} aria-label="新建会话" title="新建会话">＋</button>
      </div>
      {node && <div className="conversation-tools">
        <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="按会话名称搜索" aria-label="搜索会话" />
        <div className="conversation-filters" role="group" aria-label="会话筛选">
          <button className={filter === "all" ? "active" : ""} onClick={() => onFilterChange("all")}>全部</button>
          <button className={filter === "active" ? "active" : ""} onClick={() => onFilterChange("active")}>进行中</button>
          <button className={filter === "failed" ? "active" : ""} onClick={() => onFilterChange("failed")}>失败</button>
        </div>
      </div>}
      <div className="conversation-list">
        {conversations.map((conversation) => {
          const approvalCount = pendingApprovals.filter((approval) => approval.conversationId === conversation.id).length;
          return (
            <div className="conversation-row" key={conversation.id}>
              {editingId === conversation.id ? (
                <form className="conversation-rename" onSubmit={(event) => { event.preventDefault(); void saveTitle(conversation); }}>
                  <input value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} maxLength={80} autoFocus aria-label="会话标题" />
                  <button className="primary-button" disabled={!titleDraft.trim()}>保存</button>
                  <button type="button" onClick={() => setEditingId(null)}>取消</button>
                </form>
              ) : <>
              <button
                className={`conversation-card ${selectedId === conversation.id ? "selected" : ""}`}
                onClick={() => onSelect(conversation)}
              >
                <span className="conversation-title">{conversation.pinnedAt && <i title="已置顶">◆</i>}{conversation.title}</span>
                <span className="conversation-meta">
                  <StatusBadge status={conversation.latestRunStatus ?? conversation.status} /> {relativeTime(conversation.updatedAt)}
                  {approvalCount > 0 && <span className="approval-pill">{approvalCount} 项审批</span>}
                </span>
              </button>
              <div className="conversation-actions">
                <button className={`row-action ${conversation.pinnedAt ? "active" : ""}`} title={conversation.pinnedAt ? "取消置顶" : "置顶"} aria-label={conversation.pinnedAt ? `取消置顶 ${conversation.title}` : `置顶 ${conversation.title}`} onClick={() => void togglePinned(conversation)}><PinIcon /></button>
                <button className="row-action" title="重命名会话" aria-label={`重命名 ${conversation.title}`} onClick={() => { setEditingId(conversation.id); setTitleDraft(conversation.title); }}><PencilIcon /></button>
              <button
                className="row-action danger"
                disabled={deletingId === conversation.id}
                title="删除会话"
                aria-label={`删除 ${conversation.title}`}
                onClick={() => void remove(conversation)}
              >
                {deletingId === conversation.id ? "…" : <TrashIcon />}
              </button>
              </div>
              </>}
            </div>
          );
        })}
        {node && hasMore && <button type="button" className="load-more-conversations" disabled={loading} onClick={onLoadMore}>{loading ? "加载中…" : "加载更多会话"}</button>}
        {node && cacheLimited && (
          <div className="conversation-cache-hint">当前浏览器最多保留最近 {conversationCacheLimit} 个会话，请按名称搜索更早的会话。</div>
        )}
        {error && <div className="list-error">{error}</div>}
        {node && loading && conversations.length === 0 && <div className="empty compact">正在读取会话…</div>}
        {node && !loading && total === 0 && !query && filter === "all" && <div className="empty compact">还没有历史会话。发送第一条消息后，会话会自动出现在这里。</div>}
        {node && !loading && total === 0 && (Boolean(query) || filter !== "all") && <div className="empty compact">没有符合条件的会话。</div>}
        {!node && <div className="empty compact">请先从左侧选择一个节点。</div>}
      </div>
    </aside>
  );
}

function UserInputApproval({ approval, onResolve }: { approval: Approval; onResolve: (response: unknown) => Promise<void> }) {
  const details = record(approval.details);
  const questions = Array.isArray(details?.questions) ? details.questions : [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      const response = Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, { answers: [value] }]));
      void onResolve({ answers: response });
    }}>
      {questions.map((question, index) => {
        const item = record(question);
        const id = stringValue(item?.id) ?? String(index);
        const options = Array.isArray(item?.options) ? item.options : [];
        return (
          <label className="question" key={id}>
            <strong>{String(item?.header ?? "Codex 需要输入")}</strong>
            <span>{String(item?.question ?? "")}</span>
            {options.length > 0 ? (
              <select value={answers[id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [id]: event.target.value }))} required>
                <option value="">请选择</option>
                {options.map((option, optionIndex) => {
                  const value = record(option);
                  const label = String(value?.label ?? optionIndex);
                  return <option key={label} value={label}>{label} — {String(value?.description ?? "")}</option>;
                })}
              </select>
            ) : (
              <input
                type={item?.isSecret ? "password" : "text"}
                value={answers[id] ?? ""}
                onChange={(event) => setAnswers((current) => ({ ...current, [id]: event.target.value }))}
                required
              />
            )}
          </label>
        );
      })}
      <button className="primary-button">提交回答</button>
    </form>
  );
}

function ApprovalCard({ approval, onDone }: { approval: Approval; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (response: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await resolveApproval(approval.id, response);
      onDone();
    } catch (reason) {
      setError(formatErrorMessage(reason, "处理确认请求"));
    } finally {
      setBusy(false);
    }
  };
  const decisionResponse = (decision: "accept" | "acceptForSession" | "decline") => {
    const details = record(approval.details);
    if (approval.method === "item/permissions/requestApproval") {
      return {
        permissions: decision === "decline" ? {} : details?.permissions ?? {},
        scope: decision === "acceptForSession" ? "session" : "turn",
      };
    }
    if (approval.method === "mcpServer/elicitation/request") {
      return { action: decision === "decline" ? "decline" : "accept", content: null, _meta: null };
    }
    return { decision };
  };
  const elicitationUrl = approval.method === "mcpServer/elicitation/request" ? stringValue(record(approval.details)?.url) : null;
  return (
    <section className="approval-card">
      <div className="approval-head"><span>需要你的确认</span></div>
      <strong className="approval-summary">{approval.summary}</strong>
      {approval.risk && <p className="approval-risk">{approval.risk}</p>}
      {elicitationUrl && <a className="approval-link" href={elicitationUrl} target="_blank" rel="noreferrer">打开请求页面</a>}
      {approval.method === "item/tool/requestUserInput" ? (
        <UserInputApproval approval={approval} onResolve={resolve} />
      ) : (
        <div className="approval-actions">
          <button disabled={busy} className="primary-button" onClick={() => void resolve(decisionResponse("accept"))}>允许一次</button>
          {(approval.method === "item/commandExecution/requestApproval" || approval.method === "item/fileChange/requestApproval" || approval.method === "item/permissions/requestApproval") && <button disabled={busy} onClick={() => void resolve(decisionResponse("acceptForSession"))}>本会话允许</button>}
          <button disabled={busy} className="danger-button" onClick={() => void resolve(decisionResponse("decline"))}>拒绝</button>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}

function TimelineCard({
  entry,
  attachments,
  onOpenLocalPath,
}: {
  entry: TimelineEntry;
  attachments: AttachmentRecord[];
  onOpenLocalPath?: (path: string, baseFileId?: string) => void;
}) {
  const linkedAttachments = attachments.filter((attachment) => entry.attachmentIds.includes(attachment.id));
  return (
    <article className={`timeline-card timeline-${entry.kind}`} title={formatDate(entry.at)}>
      {linkedAttachments.length > 0 && <div className="message-attachments">{linkedAttachments.map((attachment) => <span key={attachment.id}>{attachment.mediaType.startsWith("image/") ? "图片" : "文件"} · {attachment.name}</span>)}</div>}
      <MarkdownContent onOpenLocalPath={onOpenLocalPath}>{entry.content}</MarkdownContent>
    </article>
  );
}

function EmptyConversationGraphic() {
  return (
    <div className="empty-visual" aria-hidden="true">
      <svg viewBox="0 0 112 112" role="presentation">
        <circle cx="56" cy="56" r="54" className="empty-visual-halo" />
        <rect x="25" y="29" width="62" height="49" rx="14" className="empty-visual-card" />
        <path d="M42 78l-8 10 18-10" className="empty-visual-card" />
        <circle cx="43" cy="53.5" r="3.5" className="empty-visual-dot" />
        <circle cx="56" cy="53.5" r="3.5" className="empty-visual-dot" />
        <circle cx="69" cy="53.5" r="3.5" className="empty-visual-dot" />
        <path d="M76 21v12M70 27h12" className="empty-visual-spark" />
      </svg>
    </div>
  );
}

const effortLabels: Record<ReasoningEffort, string> = {
  none: "none · 无",
  minimal: "minimal · 极简",
  low: "low · 低",
  medium: "medium · 中",
  high: "high · 高",
  xhigh: "xhigh · 极高",
  max: "max · 最大",
};

const workspaceSourceLabels: Record<Workspace["source"], string> = {
  default: "默认目录",
  config: "启动配置",
  web: "Web 添加",
  history: "历史保留",
};

const workspaceStatusLabels: Record<Workspace["status"], string> = {
  valid: "有效",
  invalid: "失效",
  offline: "节点离线",
  archived: "已停用",
};

function WorkspaceSettings({ nodes, initialNodeId, onChanged }: { nodes: NodeRecord[]; initialNodeId: string | null; onChanged: () => Promise<void> | void }) {
  const [nodeId, setNodeId] = useState(nodes.find((node) => node.id === initialNodeId)?.id ?? nodes[0]?.id ?? "");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPath, setEditPath] = useState("");
  const [confirmation, setConfirmation] = useState<{
    kind: "migration" | "archive" | "delete";
    workspace: Workspace;
    name?: string;
    path?: string;
  } | null>(null);
  const requestRevision = useRef(0);
  const selectedNode = nodes.find((node) => node.id === nodeId) ?? null;

  useEffect(() => {
    if (nodes.length === 0) setNodeId("");
    else if (!nodes.some((node) => node.id === nodeId)) setNodeId(nodes[0]!.id);
  }, [nodeId, nodes]);

  const refresh = useCallback(async () => {
    if (!nodeId) {
      setWorkspaces([]);
      return;
    }
    const revision = ++requestRevision.current;
    setLoading(true);
    try {
      const result = await listNodeWorkspaces(nodeId, true);
      if (revision === requestRevision.current) {
        setWorkspaces(result);
        setError(null);
      }
    } catch (reason) {
      if (revision === requestRevision.current) setError(formatErrorMessage(reason, "读取工作空间"));
    } finally {
      if (revision === requestRevision.current) setLoading(false);
    }
  }, [nodeId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function finishMutation(operation: () => Promise<unknown>, busyKey: string, operationName: string): Promise<boolean> {
    setBusyId(busyKey);
    setError(null);
    try {
      await operation();
      await refresh();
      await onChanged();
      setEditingId(null);
      setConfirmation(null);
      return true;
    } catch (reason) {
      const message = formatErrorMessage(reason, operationName);
      await refresh();
      setError(message);
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function addWorkspace(event: FormEvent) {
    event.preventDefault();
    if (!nodeId || !newPath.trim()) return;
    const added = await finishMutation(
      () => createNodeWorkspace(nodeId, { path: newPath.trim(), ...(newName.trim() ? { name: newName.trim() } : {}) }),
      "add",
      "添加工作空间",
    );
    if (!added) return;
    setNewName("");
    setNewPath("");
    setAdding(false);
  }

  function startEditing(workspace: Workspace) {
    setEditingId(workspace.id);
    setEditName(workspace.name);
    setEditPath(workspace.path);
    setError(null);
  }

  async function saveEditing(workspace: Workspace) {
    const name = editName.trim();
    const workspacePath = editPath.trim();
    if (!name || !workspacePath) return setError("名称和路径不能为空");
    if (workspacePath !== workspace.path) {
      setConfirmation({ kind: "migration", workspace, name, path: workspacePath });
      return;
    }
    if (name === workspace.name) {
      setEditingId(null);
      return;
    }
    await finishMutation(
      () => updateNodeWorkspace(nodeId, workspace.id, {
        ...(name !== workspace.name ? { name } : {}),
        ...(workspacePath !== workspace.path ? { path: workspacePath } : {}),
      }),
      workspace.id,
      "更新工作空间",
    );
  }

  async function confirmAction() {
    if (!confirmation) return;
    const { workspace } = confirmation;
    if (confirmation.kind === "migration") {
      await finishMutation(
        () => updateNodeWorkspace(nodeId, workspace.id, {
          name: confirmation.name,
          path: confirmation.path,
          confirmMigration: true,
        }),
        workspace.id,
        "迁移工作空间路径",
      );
    } else if (confirmation.kind === "archive") {
      await finishMutation(() => updateNodeWorkspace(nodeId, workspace.id, { archived: true }), workspace.id, "停用工作空间");
    } else {
      await finishMutation(() => deleteNodeWorkspace(nodeId, workspace.id), workspace.id, "删除工作空间");
    }
  }

  return <section className="workspace-settings" aria-label="工作空间管理">
    <div className="settings-copy"><h3>工作空间</h3><p>为节点登记可以执行任务的本地目录。路径会交给对应 Agent 验证；默认工作空间固定为 Agent 的启动目录。</p></div>
    <label className="workspace-node-select"><span>管理节点</span><select value={nodeId} disabled={Boolean(busyId)} onChange={(event) => { setNodeId(event.target.value); setAdding(false); setEditingId(null); setConfirmation(null); setError(null); }}>
      {nodes.map((node) => <option key={node.id} value={node.id}>{node.name} · {node.status === "online" ? "在线" : "离线"}</option>)}
    </select></label>
    <div className="workspace-settings-toolbar">
      <div><strong>{selectedNode?.name ?? "没有节点"}</strong><span>{workspaces.filter((workspace) => !workspace.archivedAt && workspace.source !== "history").length} 个新会话可选</span></div>
      <button type="button" className="primary-button" disabled={!selectedNode || selectedNode.status !== "online" || adding} onClick={() => setAdding(true)}>添加工作空间</button>
    </div>
    {adding && <form className="workspace-add-form" onSubmit={(event) => void addWorkspace(event)}>
      <label><span>名称（可选）</span><input value={newName} maxLength={64} onChange={(event) => setNewName(event.target.value)} placeholder="默认使用目录名称" /></label>
      <label><span>该节点上的路径</span><input value={newPath} onChange={(event) => setNewPath(event.target.value)} placeholder="例如 /root/codes/project-a" autoFocus /></label>
      <p>该路径可以位于 Agent 用户有权访问的任意位置。系统不会自动创建目录。</p>
      <div><button type="button" onClick={() => { setAdding(false); setNewName(""); setNewPath(""); }}>取消</button><button className="primary-button" disabled={!newPath.trim() || busyId === "add"}>{busyId === "add" ? "验证中…" : "验证并添加"}</button></div>
    </form>}
    {error && <p className="form-error workspace-settings-error">{error}</p>}
    <div className="workspace-list">
      {loading && workspaces.length === 0 ? <div className="empty compact">正在读取工作空间…</div> : workspaces.map((workspace) => {
        const editable = !workspace.isDefault && workspace.source !== "config" && workspace.status !== "archived";
        const isEditing = editingId === workspace.id;
        return <article className={`workspace-card workspace-${workspace.status}`} key={workspace.id}>
          <div className="workspace-card-main">
            {isEditing ? <div className="workspace-edit-fields">
              <input aria-label="工作空间名称" value={editName} maxLength={64} onChange={(event) => setEditName(event.target.value)} />
              <input aria-label="工作空间路径" value={editPath} onChange={(event) => setEditPath(event.target.value)} />
            </div> : <div className="workspace-card-copy">
              <div><strong>{workspace.name}</strong>{workspace.isDefault ? <b>默认</b> : <span>{workspaceSourceLabels[workspace.source]}</span>}</div>
              <code title={workspace.path}>{workspace.path}</code>
              {workspace.validationError && <small>{workspace.validationError}</small>}
            </div>}
            <div className="workspace-card-meta"><span className={`workspace-status status-${workspace.status}`}>{workspaceStatusLabels[workspace.status]}</span><small>{workspace.conversationCount} 个会话</small></div>
          </div>
          <div className="workspace-card-actions">
            {isEditing ? <>
              <button type="button" onClick={() => setEditingId(null)}>取消</button>
              <button type="button" className="primary-button" disabled={busyId === workspace.id} onClick={() => void saveEditing(workspace)}>保存</button>
            </> : <>
              {!workspace.archivedAt && <button type="button" disabled={busyId === workspace.id || selectedNode?.status !== "online"} onClick={() => void finishMutation(() => validateNodeWorkspace(nodeId, workspace.id), workspace.id, "验证工作空间")}>验证</button>}
              {editable && <button type="button" onClick={() => startEditing(workspace)}>编辑</button>}
              {editable && <button type="button" className="danger-text" onClick={() => setConfirmation({ kind: workspace.conversationCount > 0 ? "archive" : "delete", workspace })}>{workspace.conversationCount > 0 ? "停用" : "删除"}</button>}
              {workspace.archivedAt && workspace.source !== "config" && <button type="button" disabled={busyId === workspace.id || selectedNode?.status !== "online"} onClick={() => void finishMutation(() => updateNodeWorkspace(nodeId, workspace.id, { archived: false }), workspace.id, "恢复工作空间")}>恢复</button>}
            </>}
          </div>
        </article>;
      })}
      {!loading && workspaces.length === 0 && <div className="empty compact">该节点还没有工作空间</div>}
    </div>
    {confirmation && <div className="workspace-confirm" role="alertdialog" aria-label="确认工作空间操作">
      <strong>{confirmation.kind === "migration" ? "确认迁移路径" : confirmation.kind === "archive" ? "确认停用工作空间" : "确认删除工作空间"}</strong>
      <p>{confirmation.kind === "migration"
        ? confirmation.workspace.conversationCount > 0
          ? `这会影响 ${confirmation.workspace.conversationCount} 个历史会话，之后它们将在新路径中继续执行。`
          : `路径将从“${confirmation.workspace.path}”迁移到“${confirmation.path}”。`
        : confirmation.kind === "archive"
          ? `“${confirmation.workspace.name}”已有 ${confirmation.workspace.conversationCount} 个会话。停用后历史仍可查看，但不能继续执行。`
          : `“${confirmation.workspace.name}”尚未绑定会话，删除后不会保留。`}</p>
      <div><button type="button" disabled={Boolean(busyId)} onClick={() => setConfirmation(null)}>取消</button><button type="button" className="danger-button" disabled={Boolean(busyId)} onClick={() => void confirmAction()}>{busyId ? "处理中…" : "确认"}</button></div>
    </div>}
  </section>;
}

const enrollmentStatusLabels: Record<EnrollmentToken["status"], string> = {
  pending: "未注册",
  used: "已注册",
  revoked: "已撤销",
  expired: "已过期",
};

function enrollmentCountdown(expiresAt: string, clock: number): string {
  const remainingSeconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - clock) / 1_000));
  return `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, "0")}`;
}

function formatFileSize(size: number): string {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function EnrollmentSettings({ nodes, onNodesChanged }: { nodes: NodeRecord[]; onNodesChanged: () => Promise<void> | void }) {
  const [entries, setEntries] = useState<EnrollmentToken[]>([]);
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [confirmNodeId, setConfirmNodeId] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [agentPackage, setAgentPackage] = useState<AgentPackageInfo | null>(null);
  const [packageLoading, setPackageLoading] = useState(true);
  const [packageDownloading, setPackageDownloading] = useState(false);
  const [packageError, setPackageError] = useState<string | null>(null);
  const usedIds = useRef(new Set<string>());
  const refreshRevision = useRef(0);

  const refresh = useCallback(async () => {
    const revision = ++refreshRevision.current;
    let result: Awaited<ReturnType<typeof listEnrollmentTokens>>;
    try {
      result = await listEnrollmentTokens();
    } catch (reason) {
      if (revision === refreshRevision.current) setRefreshError(formatErrorMessage(reason, "刷新注册 Token"));
      throw reason;
    }
    if (revision !== refreshRevision.current) return;
    const currentTime = Date.now();
    const visibleEntries = result.data.filter((entry) => Date.parse(entry.expiresAt) > currentTime);
    const nextUsedIds = new Set(visibleEntries.filter((entry) => entry.status === "used").map((entry) => entry.id));
    const hasNewRegistration = [...nextUsedIds].some((id) => !usedIds.current.has(id));
    usedIds.current = nextUsedIds;
    setEntries(visibleEntries);
    setRefreshError(null);
    if (hasNewRegistration) await onNodesChanged();
  }, [onNodesChanged]);

  useEffect(() => {
    const update = () => void refresh().catch(() => undefined);
    update();
    const timer = window.setInterval(update, enrollmentRefreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const currentTime = Date.now();
      setClock(currentTime);
      setEntries((current) => current.filter((entry) => Date.parse(entry.expiresAt) > currentTime));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    void getAgentPackageInfo().then((result) => {
      if (!active) return;
      setAgentPackage(result);
      setPackageError(null);
    }).catch((reason) => {
      if (active) setPackageError(formatErrorMessage(reason, "读取 Agent 安装包"));
    }).finally(() => {
      if (active) setPackageLoading(false);
    });
    return () => { active = false; };
  }, []);

  async function downloadPackage(): Promise<void> {
    if (!agentPackage?.available || !agentPackage.fileName) return;
    setPackageDownloading(true);
    setPackageError(null);
    try {
      await downloadAgentPackage(agentPackage.fileName);
    } catch (reason) {
      setPackageError(formatErrorMessage(reason, "下载 Agent 安装包"));
    } finally {
      setPackageDownloading(false);
    }
  }

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const created = await createEnrollmentToken();
      setClock(Date.now());
      const entry = { ...created.enrollment, token: created.enrollment.token ?? created.token };
      setEntries((current) => [entry, ...current.filter((candidate) => candidate.id !== entry.id)]);
    } catch (reason) {
      setError(formatErrorMessage(reason, "生成注册 Token"));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(entry: EnrollmentToken): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await revokeEnrollmentToken(entry.id);
      await refresh();
    } catch (reason) {
      setError(formatErrorMessage(reason, "撤销注册 Token"));
    } finally {
      setBusy(false);
    }
  }

  async function revokeAccess(node: NodeRecord): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await revokeNodeAccess(node.id);
      setConfirmNodeId(null);
      await onNodesChanged();
    } catch (reason) {
      setError(formatErrorMessage(reason, "撤销节点接入"));
    } finally {
      setBusy(false);
    }
  }

  return <section className="enrollment-settings">
    <div className="settings-copy"><h3>节点接入</h3><p>生成一次性注册 Token，让新 Agent 建立自己的长期身份。有效期 10 分钟，倒计时结束后自动删除清理。</p></div>
    <div className="agent-package-card">
      <div>
        <strong>Agent 客户端安装包</strong>
        {packageLoading
          ? <span>正在读取安装包信息…</span>
          : agentPackage?.available
            ? <><span>v{agentPackage.version} · {agentPackage.size !== null ? formatFileSize(agentPackage.size) : "大小未知"} · Linux / macOS</span><code title={agentPackage.sha256 ?? undefined}>SHA-256 {agentPackage.sha256}</code></>
            : <span>v{agentPackage?.version ?? __APP_VERSION__} 安装包尚未构建，请在服务端执行 npm run package:agent。</span>}
      </div>
      <button type="button" className="primary-button" disabled={packageLoading || packageDownloading || !agentPackage?.available} onClick={() => void downloadPackage()}>{packageDownloading ? "下载中…" : "下载客户端"}</button>
    </div>
    <div className="enrollment-create-card">
      <div><strong>注册新节点</strong><span>在目标机器准备好控制中心 HTTPS 地址，然后粘贴这里生成的 Token。</span></div>
      <button type="button" className="primary-button" disabled={busy} onClick={() => void create()}>{busy ? "生成中…" : "生成注册 Token"}</button>
    </div>
    {(error ?? refreshError ?? packageError) && <p className="form-error workspace-settings-error">{error ?? refreshError ?? packageError}</p>}
    {nodes.length > 0 && <div className="enrollment-nodes">
      <header><strong>已登记节点</strong><span>丢失或停用节点时应立即撤销其长期凭证</span></header>
      {nodes.map((node) => <article key={node.id}>
        <div><strong>{node.name}</strong><small>{node.accessMode === "enrolled" ? "独立凭证" : node.accessMode === "revoked" ? "接入已撤销" : "旧共享凭证"} · {node.status === "online" ? "在线" : "离线"}{node.permissionMode === "danger-full-access" ? " · 全权限" : ""}</small></div>
        {confirmNodeId === node.id ? <div className="enrollment-node-confirm"><span>撤销后 Agent 会立即断开</span><button type="button" onClick={() => setConfirmNodeId(null)}>取消</button><button type="button" className="danger-text" disabled={busy} onClick={() => void revokeAccess(node)}>确认撤销</button></div>
          : <button type="button" disabled={busy || node.accessMode !== "enrolled"} onClick={() => setConfirmNodeId(node.id)}>撤销接入</button>}
      </article>)}
    </div>}
    <div className="enrollment-history">
      <header><strong>注册 Token</strong><span>可在有效期内查看和复制，到期自动删除</span></header>
      {entries.map((entry) => {
        const node = entry.nodeId ? nodes.find((candidate) => candidate.id === entry.nodeId) : null;
        return <article key={entry.id}>
          <div className="enrollment-token-info">
            <div className="enrollment-token-heading">
              <span className={`enrollment-dot enrollment-${entry.status}`} />
              <strong>{enrollmentStatusLabels[entry.status]}</strong>
              <small>{node?.name ?? (entry.nodeId ? "节点已登记" : `生成于 ${formatDate(entry.createdAt)}`)}</small>
              <time>剩余 {enrollmentCountdown(entry.expiresAt, clock)}</time>
            </div>
            {entry.token
              ? <code title={entry.token}>{entry.token}</code>
              : <span className="enrollment-token-unavailable">该 Token 创建于升级前，无法恢复原文，请重新生成</span>}
          </div>
          <div className="enrollment-token-actions">
            {entry.token && <button type="button" className="copy-token" onClick={() => void copyToClipboard(entry.token!).then(() => {
              setCopiedId(entry.id);
              window.setTimeout(() => setCopiedId((current) => current === entry.id ? null : current), 1_500);
            }).catch((reason) => setError(formatErrorMessage(reason, "复制注册 Token")))}>{copiedId === entry.id ? "已复制" : "复制"}</button>}
            {entry.status === "pending" && <button type="button" disabled={busy} onClick={() => void revoke(entry)}>撤销</button>}
          </div>
        </article>;
      })}
      {entries.length === 0 && <div className="empty compact">当前没有有效的注册 Token</div>}
    </div>
  </section>;
}

function SettingsPanel({
  settings,
  nodes,
  onClose,
  onSaved,
  onNodesChanged,
  onLogout,
  selectedNodeId,
}: {
  settings: GlobalSettings;
  nodes: NodeRecord[];
  onClose: () => void;
  onSaved: (settings: GlobalSettings) => void;
  onNodesChanged: () => Promise<void> | void;
  onLogout: () => Promise<void> | void;
  selectedNodeId: string | null;
}) {
  const models = useMemo(() => {
    const catalog = new Map<string, string>();
    for (const node of nodes) for (const model of node.models) catalog.set(model.id, model.displayName);
    return [...catalog].sort((left, right) => left[1].localeCompare(right[1]));
  }, [nodes]);
  const [model, setModel] = useState(settings.defaultModel ?? "");
  const [effort, setEffort] = useState<ReasoningEffort | "">(settings.defaultEffort ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<"defaults" | "workspaces" | "enrollment">("defaults");

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await updateSettings({ defaultModel: model || null, defaultEffort: effort || null }));
      onClose();
    } catch (reason) {
      setError(formatErrorMessage(reason, "保存设置"));
    } finally {
      setBusy(false);
    }
  }

  async function logout(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await onLogout();
    } catch (reason) {
      setError(formatErrorMessage(reason, "退出登录"));
    } finally {
      setBusy(false);
    }
  }

  return <div className="overlay-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-panel" role="dialog" aria-modal="true" aria-label="设置">
      <header><div><span>Controller Center</span><h2>设置</h2></div><button type="button" onClick={onClose} aria-label="关闭设置">×</button></header>
      <div className="settings-layout">
        <nav>
          <button type="button" className={section === "defaults" ? "active" : ""} onClick={() => setSection("defaults")}>对话默认值</button>
          <button type="button" className={section === "workspaces" ? "active" : ""} onClick={() => setSection("workspaces")}>工作空间</button>
          <button type="button" className={section === "enrollment" ? "active" : ""} onClick={() => setSection("enrollment")}>节点接入</button>
          <button type="button" className="settings-logout" disabled={busy} onClick={() => void logout()}>退出登录</button>
          <div className="settings-version"><span>Controller Center</span><strong>v{__APP_VERSION__}</strong></div>
        </nav>
        {section === "defaults" ? <form className="settings-form" onSubmit={(event) => void save(event)}>
          <div className="settings-copy"><h3>对话默认值</h3><p>创建新会话时优先使用这些选项。节点不支持所选模型时，将自动使用该节点的本机默认模型。</p></div>
          <label><span>默认模型</span><select value={model} onChange={(event) => setModel(event.target.value)}><option value="">各节点本机默认</option>{models.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          <label><span>默认思考强度</span><select value={effort} onChange={(event) => setEffort(event.target.value as ReasoningEffort | "")}><option value="">模型默认</option>{Object.entries(effortLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {error && <p className="form-error">{error}</p>}
          <div className="settings-actions"><button type="button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy}>{busy ? "保存中…" : "保存设置"}</button></div>
        </form> : section === "workspaces"
          ? <WorkspaceSettings nodes={nodes} initialNodeId={selectedNodeId} onChanged={onNodesChanged} />
          : <EnrollmentSettings nodes={nodes} onNodesChanged={onNodesChanged} />}
      </div>
    </section>
  </div>;
}

type QuickSwitchResult =
  | { key: string; kind: "node"; node: NodeRecord }
  | { key: string; kind: "conversation"; conversation: Conversation; node: NodeRecord | null };

function QuickSwitcher({ nodes, conversations, loading, error, onClose, onSearch, onNode, onConversation }: {
  nodes: NodeRecord[];
  conversations: Conversation[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onSearch: (query: string) => void;
  onNode: (node: NodeRecord) => void;
  onConversation: (conversation: Conversation) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const hasQuery = query.trim().length > 0;
  const results = useMemo<QuickSwitchResult[]>(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return [];
    const matchingNodes = nodes
      .filter((node) => `${node.name} ${node.reportedName}`.toLocaleLowerCase().includes(keyword))
      .slice(0, 6)
      .map((node): QuickSwitchResult => ({ key: `node:${node.id}`, kind: "node", node }));
    const matchingConversations = conversations
      .map((conversation) => ({ conversation, node: nodes.find((node) => node.id === conversation.nodeId) ?? null }))
      .filter(({ conversation, node }) => `${conversation.title} ${node?.name ?? ""}`.toLocaleLowerCase().includes(keyword))
      .slice(0, 10)
      .map(({ conversation, node }): QuickSwitchResult => ({ key: `conversation:${conversation.id}`, kind: "conversation", conversation, node }));
    return [...matchingNodes, ...matchingConversations];
  }, [conversations, nodes, query]);

  useEffect(() => setActiveIndex(0), [query, results.length]);
  useEffect(() => {
    const timer = window.setTimeout(() => onSearch(query), query.trim() ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [onSearch, query]);

  function activate(result: QuickSwitchResult | undefined): void {
    if (!result) return;
    if (result.kind === "node") onNode(result.node);
    else onConversation(result.conversation);
  }

  return <div className="overlay-backdrop switcher-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="quick-switcher" role="dialog" aria-modal="true" aria-label="快速切换">
      <div className="switcher-search">
        <SearchIcon />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索节点或历史会话…"
          aria-label="搜索节点或历史会话"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              if (results.length > 0) setActiveIndex((current) => Math.min(results.length - 1, current + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((current) => Math.max(0, current - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              activate(results[activeIndex]);
            } else if (event.key === "Escape") onClose();
          }}
        />
        <kbd>ESC</kbd>
      </div>
      <div className="switcher-results">
        {!hasQuery && !loading && !error && <div className="switcher-state">输入节点名称或会话名称开始搜索</div>}
        {loading && results.length === 0 && <div className="switcher-state"><span className="loading-spinner" />正在搜索…</div>}
        {error && <div className="switcher-error">{error}</div>}
        {hasQuery && !loading && !error && results.length === 0 && <div className="switcher-state">没有找到匹配的节点或会话</div>}
        {results.map((result, index) => {
          if (result.kind === "node") return <button
            type="button"
            key={result.key}
            className={activeIndex === index ? "active" : ""}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => activate(result)}
          >
            <span className="switcher-avatar">{nodeShortLabel(result.node.name)}</span>
            <span className="switcher-main"><strong>{result.node.name}</strong><small>节点 · {result.node.workspaces.filter((workspace) => workspace.source !== "history" && !workspace.archivedAt).length} 个工作空间</small></span>
            <span className={`switcher-status ${result.node.status}`}>{result.node.status === "online" ? "在线" : "离线"}</span>
          </button>;
          const workspace = result.node?.workspaces.find((candidate) => candidate.id === result.conversation.workspaceId);
          return <button
            type="button"
            key={result.key}
            className={activeIndex === index ? "active" : ""}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => activate(result)}
          >
            <span className="switcher-avatar conversation">聊</span>
            <span className="switcher-main"><strong>{result.conversation.title}</strong><small>{result.node?.name ?? "未知节点"} · {workspace?.name ?? "工作空间"}</small></span>
            <time>{relativeTime(result.conversation.updatedAt)}</time>
          </button>;
        })}
      </div>
      <footer><span>↑↓ 选择</span><span>Enter 打开</span><span>Esc 关闭</span></footer>
    </section>
  </div>;
}

function TaskCenterPage({ entries, nodes, unreadCount, policy, onBack, onOpen, onMarkAllRead, onRetry }: {
  entries: TaskCenterEntry[];
  nodes: NodeRecord[];
  unreadCount: number;
  policy: TaskCenterPolicy;
  onBack: () => void;
  onOpen: (entry: TaskCenterEntry) => void;
  onMarkAllRead: () => Promise<void>;
  onRetry: (entry: TaskCenterEntry, allowWorkspaceConcurrency: boolean) => Promise<void>;
}) {
  const [filter, setFilter] = useState<"all" | "active" | "attention" | "completed">("all");
  const [nodeId, setNodeId] = useState("all");
  const [query, setQuery] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaceConflict, setWorkspaceConflict] = useState<{ entry: TaskCenterEntry; detail: string } | null>(null);
  const activeCount = entries.filter((entry) => ["queued", "dispatching", "running", "recovering"].includes(entry.status)).length;
  const attentionCount = entries.filter((entry) => entry.unread && ["failed", "waiting_approval", "waiting_user"].includes(entry.status)).length;
  const keyword = query.trim().toLocaleLowerCase();
  const visible = entries.filter((entry) => (nodeId === "all" || entry.nodeId === nodeId)
    && (!keyword || `${entry.conversationTitle} ${entry.nodeName}`.toLocaleLowerCase().includes(keyword))
    && (filter === "all"
      || filter === "active" && ["queued", "dispatching", "running", "recovering"].includes(entry.status)
      || filter === "attention" && ["failed", "waiting_approval", "waiting_user"].includes(entry.status)
      || filter === "completed" && entry.status === "completed"));

  async function runAction(key: string, operation: string, action: () => Promise<void>): Promise<void> {
    setBusyAction(key);
    setError(null);
    try { await action(); }
    catch (reason) { setError(formatErrorMessage(reason, operation)); }
    finally { setBusyAction(null); }
  }

  async function requestRetry(entry: TaskCenterEntry, allowWorkspaceConcurrency = false): Promise<void> {
    const key = `retry:${entry.id}`;
    setBusyAction(key);
    setError(null);
    try {
      await onRetry(entry, allowWorkspaceConcurrency);
      setWorkspaceConflict(null);
    } catch (reason) {
      if (!allowWorkspaceConcurrency && isWorkspaceConcurrencyConflict(reason)) {
        setWorkspaceConflict({ entry, detail: reason.message });
      } else {
        setError(formatErrorMessage(reason, "重新执行任务"));
      }
    } finally {
      setBusyAction(null);
    }
  }

  return <main className="task-center-page" aria-label="全局任务中心">
    <header className="task-center-page-header">
      <button type="button" onClick={onBack} aria-label="返回工作台">‹</button>
      <div><span>跨节点任务调度</span><h1>任务中心</h1><p>从这里查看所有节点的运行进度、未读结果和等待操作。</p></div>
      <div className="task-center-header-meta">{unreadCount > 0 ? `${unreadCount} 条未读` : "全部已读"}</div>
    </header>
    <div className="task-center-page-body">
      <section className="task-center-summary" aria-label="任务概览">
        <div><span>进行中</span><strong>{activeCount}</strong></div>
        <div><span>需要关注</span><strong>{attentionCount}</strong></div>
        <div><span>未读消息</span><strong>{unreadCount}</strong></div>
      </section>
      <section className="task-center-content">
        <div className="task-center-tools">
          <label className="task-search"><SearchIcon /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按会话名称或节点名称搜索" aria-label="搜索全局任务" /></label>
          <select value={nodeId} onChange={(event) => setNodeId(event.target.value)} aria-label="按节点筛选">
            <option value="all">全部节点</option>
            {nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
          </select>
          <button type="button" disabled={unreadCount === 0 || busyAction !== null} onClick={() => void runAction("read-all", "标记全部通知为已读", onMarkAllRead)}>{busyAction === "read-all" ? "处理中…" : "全部标为已读"}</button>
        </div>
        <div className="task-center-filters" role="group" aria-label="按状态筛选">
          {([['all', '全部'], ['active', '进行中'], ['attention', '需要关注'], ['completed', '已完成']] as const).map(([value, label]) => <button type="button" key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>)}
        </div>
        {error && <div className="task-center-error">{error}</div>}
        <div className="task-center-list">
        {visible.map((entry) => <div key={entry.id} className={`task-center-item ${entry.unread ? "unread" : ""}`}>
          <button type="button" className="task-center-open" onClick={() => onOpen(entry)}>
            <i className={`task-state-dot task-state-${entry.status}`} />
            <span className="task-center-main">
              <strong>{entry.conversationTitle}</strong>
              <span className="task-reply-preview">{entry.replyPreview ? `Codex：${entry.replyPreview}` : entry.progressLabel ?? statusText[entry.status] ?? entry.status}</span>
              <small>{entry.nodeName} · {entry.progressLabel ?? statusText[entry.status] ?? entry.status}</small>
            </span>
            <span className="task-center-side"><StatusBadge status={entry.status} /><time>{relativeTime(entry.occurredAt)}</time></span>
          </button>
          {entry.runId && ["failed", "interrupted"].includes(entry.status) && <button
            type="button"
            className="task-retry"
            disabled={busyAction !== null}
            onClick={() => void requestRetry(entry)}
          >{busyAction === `retry:${entry.id}` ? "正在重试…" : "重新执行"}</button>}
        </div>)}
        {visible.length === 0 && <div className="empty"><strong>这里暂时没有任务</strong><span>运行中的任务和需要你关注的结果会显示在这里。</span></div>}
        </div>
        <footer className="task-center-policy">
          最多展示最近 {policy.limit} 条；回复摘要最多 {policy.replyPreviewCharacters} 个字符。已读通知保留 {policy.readRetentionDays} 天，未读通知保留 {policy.unreadRetentionDays} 天。清理通知不会删除会话历史。
        </footer>
      </section>
    </div>
    {workspaceConflict && <WorkspaceConcurrencyDialog
      detail={workspaceConflict.detail}
      busy={busyAction === `retry:${workspaceConflict.entry.id}`}
      onCancel={() => setWorkspaceConflict(null)}
      onConfirm={() => void requestRetry(workspaceConflict.entry, true)}
    />}
  </main>;
}

interface PendingUpload {
  localId: string;
  file: File;
  attachment: AttachmentRecord | null;
  progress: number;
  status: "uploading" | "ready" | "failed";
  error: string | null;
  previewUrl: string | null;
}

function openedFileTypeLabel(file: ConversationOpenedFile): string {
  const extension = file.name.match(/\.([^.]+)$/u)?.[1]?.toUpperCase();
  if (extension && extension.length <= 6) return extension;
  const mediaType = file.mediaType.split(";", 1)[0]?.toLowerCase() ?? "";
  if (mediaType.startsWith("image/")) return "IMG";
  if (mediaType === "application/pdf") return "PDF";
  return "FILE";
}

function ConversationFileHistoryPanel({
  files,
  loading,
  error,
  deletingId,
  onClose,
  onAdd,
  onOpen,
  onDelete,
}: {
  files: ConversationOpenedFile[];
  loading: boolean;
  error: string | null;
  deletingId: string | null;
  onClose: () => void;
  onAdd: (path: string) => Promise<void>;
  onOpen: (file: ConversationOpenedFile) => void;
  onDelete: (file: ConversationOpenedFile) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [path, setPath] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  async function submitFilePath(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const requestedPath = path.trim();
    if (!requestedPath) {
      setAddError("请输入 Agent 上的文件路径");
      return;
    }
    if (!isLocalWorkspaceHref(requestedPath)) {
      setAddError("请输入 Agent 本地文件路径，而不是网页地址");
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      await onAdd(requestedPath);
      setPath("");
      setAddOpen(false);
    } catch (reason) {
      setAddError(formatErrorMessage(reason, "添加 Agent 文件"));
    } finally {
      setAdding(false);
    }
  }

  return <aside className="conversation-files-panel" aria-label="本会话文件">
    <header>
      <div><span>本会话文件</span><strong>{files.length} 个历史文件</strong></div>
      <div className="conversation-files-header-actions">
        <button
          className={addOpen ? "conversation-files-add-toggle active" : "conversation-files-add-toggle"}
          type="button"
          aria-expanded={addOpen}
          onClick={() => {
            setAddOpen((current) => !current);
            setAddError(null);
          }}
        ><span aria-hidden="true">＋</span>添加</button>
        <button className="conversation-files-close" type="button" onClick={onClose} aria-label="折叠文件侧边栏">×</button>
      </div>
    </header>
    {addOpen && <form className="conversation-files-add-form" onSubmit={(event) => void submitFilePath(event)}>
      <label htmlFor="conversation-file-path">Agent 文件路径</label>
      <div>
        <input
          id="conversation-file-path"
          value={path}
          maxLength={4096}
          autoComplete="off"
          autoFocus
          spellCheck={false}
          disabled={adding}
          placeholder="/home/ubuntu/documents/a.txt"
          onChange={(event) => {
            setPath(event.target.value);
            setAddError(null);
          }}
        />
        <button type="submit" disabled={adding || !path.trim()}>{adding && <i aria-hidden="true" />}{adding ? "验证中" : "添加"}</button>
      </div>
      {addError
        ? <p role="alert">{addError}</p>
        : <small>支持绝对路径；相对路径从当前会话工作空间解析</small>}
    </form>}
    {error && <div className="conversation-files-error" role="alert">{error}</div>}
    <div className="conversation-files-list">
      {loading && files.length === 0 && <div className="conversation-files-state"><span className="loading-spinner" />正在读取文件历史…</div>}
      {!loading && files.length === 0 && <div className="conversation-files-empty"><FilesIcon /><strong>还没有添加文件</strong><span>从对话中打开文件，或通过上方路径手动添加。</span></div>}
      {files.map((file) => <div className="conversation-file-row" key={file.id}>
        <button className="conversation-file-open" type="button" onClick={() => onOpen(file)} title={file.path}>
          <span className="conversation-file-kind">{openedFileTypeLabel(file)}</span>
          <span className="conversation-file-copy">
            <strong>{file.name}</strong>
            <code>{file.path}</code>
            <small><time dateTime={file.lastOpenedAt} title={new Date(file.lastOpenedAt).toLocaleString()}>{relativeTime(file.lastOpenedAt)}</time> · {formatFileSize(file.size)}</small>
          </span>
        </button>
        <button
          className="conversation-file-delete"
          type="button"
          disabled={deletingId !== null}
          onClick={() => onDelete(file)}
          aria-label={`删除 ${file.name} 的查看记录`}
          title="只删除查看记录，不删除实际文件"
        ><TrashIcon /></button>
      </div>)}
    </div>
    <footer>仅保存文件路径与查看时间；点击后从 Agent 重新读取最新内容。</footer>
  </aside>;
}

function ChatPanel({
  detail,
  node,
  pendingApprovals,
  onRefresh,
  onLoadEarlier,
  onReturnLatest,
  viewingHistoricalMessages,
  onBack,
  onNew,
  draftRequestId,
  isDraft,
  onConversationStarted,
  settings,
}: {
  detail: ConversationDetail | null;
  node: NodeRecord | null;
  pendingApprovals: Approval[];
  onRefresh: () => void;
  onLoadEarlier: () => Promise<void>;
  onReturnLatest: () => Promise<void>;
  viewingHistoricalMessages: boolean;
  onBack: () => void;
  onNew: () => void;
  draftRequestId: string;
  isDraft: boolean;
  onConversationStarted: (conversation: Conversation, run: Run, draftRequestId: string) => void;
  settings: GlobalSettings;
}) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedRunErrorIds, setDismissedRunErrorIds] = useState<Set<string>>(() => new Set());
  const [dismissingRunErrorId, setDismissingRunErrorId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<ReasoningEffort | "">("");
  const [messageRequestId, setMessageRequestId] = useState(newDraftRequestId);
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [returningLatest, setReturningLatest] = useState(false);
  const [loadEarlierError, setLoadEarlierError] = useState<string | null>(null);
  const [showCompactConfirm, setShowCompactConfirm] = useState(false);
  const [showWorkspaceConcurrencyConfirm, setShowWorkspaceConcurrencyConfirm] = useState(false);
  const [compactSubmitting, setCompactSubmitting] = useState(false);
  const [compactionRequestId, setCompactionRequestId] = useState(newDraftRequestId);
  const [openedFiles, setOpenedFiles] = useState<ConversationOpenedFile[]>([]);
  const [fileHistoryOpen, setFileHistoryOpen] = useState(false);
  const [fileHistoryLoading, setFileHistoryLoading] = useState(false);
  const [fileHistoryError, setFileHistoryError] = useState<string | null>(null);
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null);
  const timelineElement = useRef<HTMLDivElement>(null);
  const promptElement = useRef<HTMLTextAreaElement>(null);
  const fileInputElement = useRef<HTMLInputElement>(null);
  const followStreamingOutput = useRef(true);
  const timelinePositioned = useRef(false);
  const programmaticTimelineScroll = useRef(false);
  const uploadsRef = useRef<PendingUpload[]>([]);
  const fileHistoryRequestRef = useRef(0);
  const fileHistoryDeleteRequestRef = useRef(0);
  const fileHistoryAddRequestRef = useRef(0);
  const fileHistoryConversationRef = useRef<string | null>(detail?.conversation.id ?? null);
  fileHistoryConversationRef.current = detail?.conversation.id ?? null;
  const timeline = useMemo(() => buildTimeline(detail), [detail]);
  const activeRun = detail?.runs.findLast((run) => ["queued", "dispatching", "running", "waiting_approval", "recovering"].includes(run.status));
  const compaction = detail?.conversation.compaction ?? null;
  const compactionActive = Boolean(compaction && ["queued", "dispatching", "running", "recovering"].includes(compaction.status));
  const latestContextError = detail?.runs.findLast((run) => run.errorCode === "context_window_exceeded");
  const compactRecommended = Boolean(latestContextError
    && (compaction?.status !== "completed"
      || (latestContextError.finishedAt ?? latestContextError.createdAt) > (compaction.finishedAt ?? compaction.requestedAt)));
  const currentApprovals = detail ? pendingApprovals.filter((approval) => approval.conversationId === detail.conversation.id) : [];
  const modelCatalog = node?.models ?? [];
  const selectedModel = modelCatalog.find((candidate) => candidate.id === model)
    ?? modelCatalog.find((candidate) => candidate.isDefault);
  const effortOptions = selectedModel?.supportedReasoningEfforts ?? [];
  const conversationId = detail?.conversation.id ?? null;
  const composerStorageKey = `controller-center:composer:${node?.id ?? "none"}:${detail?.conversation.id ?? "new"}`;
  const draftWorkspaceStorageKey = `controller-center:draft-workspace:${node?.id ?? "none"}`;
  const timelineVirtualizer = useVirtualizer({
    count: timeline.length,
    getScrollElement: () => timelineElement.current,
    estimateSize: (index) => timeline[index]?.kind === "user" ? 66 : 84,
    getItemKey: (index) => timeline[index]?.id ?? index,
    overscan: 6,
    useFlushSync: false,
  });

  const refreshOpenedFiles = useCallback(async () => {
    const requestedConversationId = conversationId;
    if (requestedConversationId !== fileHistoryConversationRef.current) return;
    const revision = ++fileHistoryRequestRef.current;
    if (!requestedConversationId || isDraft) {
      setOpenedFiles([]);
      setFileHistoryLoading(false);
      setFileHistoryError(null);
      return;
    }
    setFileHistoryLoading(true);
    try {
      const result = await listConversationOpenedFiles(requestedConversationId);
      if (revision !== fileHistoryRequestRef.current || requestedConversationId !== fileHistoryConversationRef.current) return;
      setOpenedFiles(result);
      setFileHistoryError(null);
    } catch (reason) {
      if (revision === fileHistoryRequestRef.current && requestedConversationId === fileHistoryConversationRef.current) {
        setFileHistoryError(formatErrorMessage(reason, "读取文件历史"));
      }
    } finally {
      if (revision === fileHistoryRequestRef.current && requestedConversationId === fileHistoryConversationRef.current) {
        setFileHistoryLoading(false);
      }
    }
  }, [conversationId, isDraft]);

  useEffect(() => {
    fileHistoryDeleteRequestRef.current += 1;
    fileHistoryAddRequestRef.current += 1;
    setOpenedFiles([]);
    setFileHistoryOpen(false);
    setFileHistoryError(null);
    setDeletingFileId(null);
    void refreshOpenedFiles();
  }, [refreshOpenedFiles]);

  useEffect(() => {
    const refreshFromEvent = (event: Event) => {
      const affectedConversationId = (event as CustomEvent<{ conversationId?: string }>).detail?.conversationId;
      if (!affectedConversationId || affectedConversationId === conversationId) void refreshOpenedFiles();
    };
    window.addEventListener("controller-center:workspace-file-history", refreshFromEvent);
    return () => window.removeEventListener("controller-center:workspace-file-history", refreshFromEvent);
  }, [conversationId, refreshOpenedFiles]);

  useEffect(() => {
    if (!fileHistoryOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFileHistoryOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [fileHistoryOpen]);

  useEffect(() => {
    const preferredModel = settings.defaultModel && node?.models.some((candidate) => candidate.id === settings.defaultModel)
      ? settings.defaultModel
      : null;
    const initialModel = detail?.conversation.model
      ?? preferredModel
      ?? node?.models.find((candidate) => candidate.isDefault)?.id
      ?? "";
    const descriptor = node?.models.find((candidate) => candidate.id === initialModel);
    const preferredEffort = detail?.conversation.effort ?? settings.defaultEffort;
    const resolvedEffort = preferredEffort && (!descriptor || descriptor.supportedReasoningEfforts.length === 0 || descriptor.supportedReasoningEfforts.some((option) => option.reasoningEffort === preferredEffort))
      ? preferredEffort
      : descriptor?.defaultReasoningEffort ?? "";
    const activeWorkspaces = node?.workspaces.filter((workspace) => !workspace.archivedAt && workspace.source !== "history") ?? [];
    const storedWorkspaceId = isDraft ? storedValue(draftWorkspaceStorageKey) : null;
    const initialWorkspace = detail?.conversation.workspaceId
      ?? activeWorkspaces.find((workspace) => workspace.id === storedWorkspaceId)?.id
      ?? activeWorkspaces.find((workspace) => workspace.isDefault)?.id
      ?? activeWorkspaces[0]?.id
      ?? "";
    setWorkspaceId(initialWorkspace);
    setModel(initialModel);
    setEffort(resolvedEffort);
    setPrompt(storedValue(composerStorageKey) ?? "");
    setMessageRequestId(newDraftRequestId());
    setUploads((current) => {
      for (const upload of current) if (upload.previewUrl) URL.revokeObjectURL(upload.previewUrl);
      return [];
    });
    setError(null);
    setShowCompactConfirm(false);
    setShowWorkspaceConcurrencyConfirm(false);
    setCompactSubmitting(false);
  }, [node?.id, detail?.conversation.id, settings.defaultModel, settings.defaultEffort]);

  useEffect(() => {
    if (!showCompactConfirm) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !compactSubmitting) setShowCompactConfirm(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [showCompactConfirm, compactSubmitting]);

  useEffect(() => {
    storeValue(composerStorageKey, prompt || null);
  }, [composerStorageKey, prompt]);

  useEffect(() => {
    if (isDraft) storeValue(draftWorkspaceStorageKey, workspaceId || null);
  }, [draftWorkspaceStorageKey, isDraft, workspaceId]);

  useEffect(() => {
    if (!isDraft) return;
    const candidates = node?.workspaces.filter((workspace) => !workspace.archivedAt && workspace.source !== "history") ?? [];
    setWorkspaceId((current) => candidates.some((workspace) => workspace.id === current)
      ? current
      : candidates.find((workspace) => workspace.isDefault)?.id ?? candidates[0]?.id ?? "");
  }, [isDraft, node?.id, node?.workspaces]);

  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

  useEffect(() => () => {
    for (const upload of uploadsRef.current) if (upload.previewUrl) URL.revokeObjectURL(upload.previewUrl);
  }, []);

  useEffect(() => {
    followStreamingOutput.current = true;
    timelinePositioned.current = false;
    programmaticTimelineScroll.current = false;
    setShowScrollToBottom(false);
  }, [detail?.conversation.id]);

  useEffect(() => {
    if (viewingHistoricalMessages) return;
    const initialPosition = !timelinePositioned.current;
    if (!initialPosition && !followStreamingOutput.current) return;
    programmaticTimelineScroll.current = true;
    const positionAtEnd = () => {
      const element = timelineElement.current;
      if (element) element.scrollTop = element.scrollHeight;
      setShowScrollToBottom(false);
    };
    let secondFrame = 0;
    let settleTimer = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      positionAtEnd();
      secondFrame = window.requestAnimationFrame(() => {
        positionAtEnd();
        if (initialPosition) {
          settleTimer = window.setTimeout(() => {
            positionAtEnd();
            timelinePositioned.current = true;
            programmaticTimelineScroll.current = false;
          }, 80);
        } else {
          programmaticTimelineScroll.current = false;
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
      if (settleTimer) window.clearTimeout(settleTimer);
      programmaticTimelineScroll.current = false;
    };
  }, [timeline, activeRun?.status, currentApprovals.length, viewingHistoricalMessages]);

  useLayoutEffect(() => {
    const input = promptElement.current;
    if (!input) return;
    const timeline = timelineElement.current;
    const keepTimelineAtBottom = Boolean(timeline
      && !viewingHistoricalMessages
      && !isTimelineAwayFromBottom(timeline));

    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    if (!timeline || !keepTimelineAtBottom) return;

    timeline.scrollTop = timeline.scrollHeight;
    followStreamingOutput.current = true;
    setShowScrollToBottom(false);
  }, [prompt, viewingHistoricalMessages]);

  function scrollToTimelineBottom(): void {
    const element = timelineElement.current;
    if (!element) return;
    followStreamingOutput.current = true;
    setShowScrollToBottom(false);
    element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
  }

  function openAgentFile(path: string, baseFileId?: string): void {
    if (!detail) return;
    if (!openWorkspaceFileTab(detail.conversation.id, path, baseFileId)) {
      setError("浏览器阻止了文件预览标签页，请允许本站打开新窗口后重试");
    }
  }

  async function addOpenedFile(path: string): Promise<void> {
    if (!conversationId) throw new Error("请先打开一个会话");
    const requestedConversationId = conversationId;
    const revision = ++fileHistoryAddRequestRef.current;
    await openWorkspaceFile(requestedConversationId, path);
    if (revision !== fileHistoryAddRequestRef.current || requestedConversationId !== fileHistoryConversationRef.current) return;
    await refreshOpenedFiles();
  }

  async function removeOpenedFile(file: ConversationOpenedFile): Promise<void> {
    if (!conversationId || deletingFileId) return;
    const requestedConversationId = conversationId;
    const revision = ++fileHistoryDeleteRequestRef.current;
    setDeletingFileId(file.id);
    setFileHistoryError(null);
    try {
      await deleteConversationOpenedFile(requestedConversationId, file.id);
      if (revision === fileHistoryDeleteRequestRef.current && requestedConversationId === fileHistoryConversationRef.current) {
        setOpenedFiles((current) => current.filter((candidate) => candidate.id !== file.id));
      }
    } catch (reason) {
      if (revision === fileHistoryDeleteRequestRef.current && requestedConversationId === fileHistoryConversationRef.current) {
        setFileHistoryError(formatErrorMessage(reason, "删除文件查看记录"));
      }
    } finally {
      if (revision === fileHistoryDeleteRequestRef.current && requestedConversationId === fileHistoryConversationRef.current) {
        setDeletingFileId(null);
      }
    }
  }

  async function loadEarlierMessages(): Promise<void> {
    const element = timelineElement.current;
    const previousHeight = element?.scrollHeight ?? 0;
    const previousTop = element?.scrollTop ?? 0;
    setLoadingEarlier(true);
    setLoadEarlierError(null);
    try {
      await onLoadEarlier();
      programmaticTimelineScroll.current = true;
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        const current = timelineElement.current;
        if (current) current.scrollTop = previousTop + Math.max(0, current.scrollHeight - previousHeight);
        programmaticTimelineScroll.current = false;
      }));
    } catch (reason) {
      setLoadEarlierError(formatErrorMessage(reason, "加载更早消息"));
    } finally {
      setLoadingEarlier(false);
    }
  }

  async function returnToLatestMessages(): Promise<void> {
    setReturningLatest(true);
    setLoadEarlierError(null);
    try {
      await onReturnLatest();
      followStreamingOutput.current = true;
      programmaticTimelineScroll.current = true;
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        const current = timelineElement.current;
        if (current) current.scrollTop = current.scrollHeight;
        timelinePositioned.current = true;
        programmaticTimelineScroll.current = false;
        setShowScrollToBottom(false);
      }));
    } catch (reason) {
      setLoadEarlierError(formatErrorMessage(reason, "返回最新消息"));
    } finally {
      setReturningLatest(false);
    }
  }

  function updateUpload(localId: string, patch: Partial<PendingUpload>): void {
    setUploads((current) => current.map((upload) => upload.localId === localId ? { ...upload, ...patch } : upload));
  }

  async function performUpload(localId: string, file: File, existing: AttachmentRecord | null): Promise<void> {
    updateUpload(localId, { status: "uploading", error: null });
    try {
      const attachment = existing ?? await createAttachmentUpload({
        file,
        messageClientId: detail ? messageRequestId : draftRequestId,
        ...(detail ? { conversationId: detail.conversation.id } : {}),
      });
      updateUpload(localId, { attachment, progress: attachment.receivedSize });
      const ready = await uploadAttachmentContent(file, attachment, (progress) => updateUpload(localId, { progress }));
      updateUpload(localId, { attachment: ready, progress: ready.size, status: "ready", error: null });
    } catch (reason) {
      updateUpload(localId, { status: "failed", error: formatErrorMessage(reason, "上传附件") });
    }
  }

  function addFiles(files: File[]): void {
    if (busy || compactionActive) return;
    const available = Math.max(0, 10 - uploads.length);
    const accepted = files.slice(0, available);
    if (files.length > available) setError("单条消息最多添加 10 个附件");
    for (const file of accepted) {
      if (file.size <= 0 || file.size > 20 * 1024 * 1024) {
        setError(`${file.name || "附件"} 超过 20MB 或为空文件`);
        continue;
      }
      const localId = newDraftRequestId();
      const upload: PendingUpload = {
        localId,
        file,
        attachment: null,
        progress: 0,
        status: "uploading",
        error: null,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      };
      setUploads((current) => [...current, upload]);
      void performUpload(localId, file, null);
    }
  }

  function removeUpload(upload: PendingUpload): void {
    setUploads((current) => current.filter((candidate) => candidate.localId !== upload.localId));
    if (upload.previewUrl) URL.revokeObjectURL(upload.previewUrl);
    if (upload.attachment) void deleteAttachmentUpload(upload.attachment.id).catch(() => undefined);
  }

  function clearUploads(): void {
    setUploads((current) => {
      for (const upload of current) if (upload.previewUrl) URL.revokeObjectURL(upload.previewUrl);
      return [];
    });
  }

  async function sendMessage(allowWorkspaceConcurrency = false): Promise<void> {
    if (!node || !workspaceId || !prompt.trim() || activeRun && !activeRun.remoteTurnId || uploads.some((upload) => upload.status !== "ready")) return;
    setBusy(true);
    setError(null);
    try {
      const attachmentIds = uploads.flatMap((upload) => upload.attachment?.id ? [upload.attachment.id] : []);
      if (!detail) {
        const result = await startConversation({
          nodeId: node.id,
          workspaceId,
          prompt: prompt.trim(),
          clientRequestId: draftRequestId,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(attachmentIds.length ? { attachmentIds } : {}),
          ...(allowWorkspaceConcurrency ? { allowWorkspaceConcurrency: true } : {}),
        });
        setPrompt("");
        clearUploads();
        onConversationStarted(result.conversation, result.run, draftRequestId);
      } else if (activeRun?.remoteTurnId && ["running", "waiting_approval"].includes(activeRun.status)) {
        await steerRun(activeRun.id, prompt.trim(), {
          clientRequestId: messageRequestId,
          ...(attachmentIds.length ? { attachmentIds } : {}),
        });
        setPrompt("");
        clearUploads();
        setMessageRequestId(newDraftRequestId());
      } else {
        await startRun(detail.conversation.id, prompt.trim(), {
          clientRequestId: messageRequestId,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(attachmentIds.length ? { attachmentIds } : {}),
          ...(allowWorkspaceConcurrency ? { allowWorkspaceConcurrency: true } : {}),
        });
        setPrompt("");
        clearUploads();
        setMessageRequestId(newDraftRequestId());
      }
      setShowWorkspaceConcurrencyConfirm(false);
      onRefresh();
    } catch (reason) {
      if (!allowWorkspaceConcurrency && isWorkspaceConcurrencyConflict(reason)) {
        setShowWorkspaceConcurrencyConfirm(true);
      } else {
        setShowWorkspaceConcurrencyConfirm(false);
        const operation = !detail ? "创建会话" : activeRun?.remoteTurnId ? "追加任务指令" : "发送消息";
        setError(formatErrorMessage(reason, operation));
      }
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    void sendMessage();
  }

  async function interruptActiveRun(): Promise<void> {
    if (!activeRun?.remoteTurnId) return;
    setBusy(true);
    setError(null);
    try {
      await interruptRun(activeRun.id);
      onRefresh();
    } catch (reason) {
      setError(formatErrorMessage(reason, "中止任务"));
    } finally {
      setBusy(false);
    }
  }

  async function closeRunError(runId: string): Promise<void> {
    if (dismissingRunErrorId) return;
    setDismissingRunErrorId(runId);
    setError(null);
    try {
      await dismissRunError(runId);
      setDismissedRunErrorIds((current) => new Set(current).add(runId));
      onRefresh();
    } catch (reason) {
      setError(formatErrorMessage(reason, "关闭任务错误提示"));
    } finally {
      setDismissingRunErrorId(null);
    }
  }

  function requestCompaction(): void {
    if (!detail || activeRun || compactionActive) return;
    setCompactionRequestId(newDraftRequestId());
    setError(null);
    setShowCompactConfirm(true);
  }

  async function confirmCompaction(): Promise<void> {
    if (!detail || compactSubmitting) return;
    setCompactSubmitting(true);
    setError(null);
    try {
      await compactConversation(detail.conversation.id, compactionRequestId);
      setShowCompactConfirm(false);
      onRefresh();
    } catch (reason) {
      setError(formatErrorMessage(reason, "压缩上下文"));
    } finally {
      setCompactSubmitting(false);
    }
  }

  if (!node) {
    return (
      <main className="chat-pane empty-state">
        <div className="empty-state-content">
          <EmptyConversationGraphic />
          <span className="empty-eyebrow">Controller Center</span>
          <h2>选择一个节点</h2>
          <p>选择一台在线节点，即可创建新会话或查看这台节点上的历史会话。</p>
        </div>
      </main>
    );
  }

  if (!isDraft && !detail) {
    return (
      <main className="chat-pane empty-state">
        <div className="empty-state-content loading-state">
          <span className="loading-spinner" aria-hidden="true" />
          <h2>正在恢复会话</h2>
          <p>正在读取历史消息和当前运行状态…</p>
        </div>
      </main>
    );
  }

  const conversation = detail?.conversation ?? null;
  const effectiveWorkspaceId = isDraft ? workspaceId : conversation?.workspaceId ?? workspaceId;
  const workspace = node.workspaces.find((item) => item.id === effectiveWorkspaceId);
  const canCompose = node.status === "online"
    && Boolean(workspaceId)
    && workspace?.status === "valid"
    && !workspace.archivedAt
    && (!isDraft || workspace.source !== "history")
    && (isDraft || conversation?.status === "ready")
    && !compactionActive
    && (!activeRun || Boolean(activeRun.remoteTurnId) && ["running", "waiting_approval"].includes(activeRun.status));
  const activeStateText = activeRun?.status === "waiting_approval"
    ? "等待你的操作"
    : activeRun?.status === "recovering"
      ? "正在恢复任务状态"
    : activeRun?.status === "running"
      ? activeRun.progressLabel ?? "流式输出中"
      : "正在启动任务";
  const activeModelText = activeRun?.model || model || "本机默认模型";
  const activeEffortText = activeRun?.effort ? effortLabels[activeRun.effort] : "默认思考强度";

  return (
    <main className={`chat-pane ${isDraft ? "draft-state" : ""}`} aria-label={isDraft ? "新会话" : `对话：${conversation?.title ?? "正在加载"}`}>
      <h1 className="chat-title visually-hidden"><strong>{detail?.conversation.title ?? "新会话"}</strong></h1>
      <header className="mobile-chat-topbar">
        <button type="button" onClick={() => { setFileHistoryOpen(false); onBack(); }} aria-label="打开历史会话"><HistoryIcon /><span>历史</span></button>
        <div><strong>{conversation?.title ?? "新会话"}</strong><small>{node.name}</small></div>
        <button type="button" onClick={() => { setFileHistoryOpen(false); onNew(); }} aria-label="新建会话"><span className="mobile-chat-new-mark">＋</span><span>新建</span></button>
        <button
          type="button"
          disabled={!conversationId}
          className={fileHistoryOpen ? "active" : ""}
          aria-label={`打开本会话文件，${openedFiles.length} 个历史文件`}
          aria-expanded={fileHistoryOpen}
          onClick={() => setFileHistoryOpen((current) => !current)}
        ><FilesIcon /><span>文件</span>{openedFiles.length > 0 && <b>{openedFiles.length > 99 ? "99+" : openedFiles.length}</b>}</button>
      </header>
      {conversationId && <button
        className={`conversation-files-rail ${fileHistoryOpen ? "active" : ""}`}
        type="button"
        aria-label={`${fileHistoryOpen ? "折叠" : "展开"}本会话文件，${openedFiles.length} 个历史文件`}
        aria-expanded={fileHistoryOpen}
        onClick={() => setFileHistoryOpen((current) => !current)}
      ><FilesIcon /><span>文件</span>{openedFiles.length > 0 && <b>{openedFiles.length > 99 ? "99+" : openedFiles.length}</b>}</button>}
      {fileHistoryOpen && conversationId && <>
        <button className="conversation-files-backdrop" type="button" aria-label="折叠文件侧边栏" onClick={() => setFileHistoryOpen(false)} />
        <ConversationFileHistoryPanel
          files={openedFiles}
          loading={fileHistoryLoading}
          error={fileHistoryError}
          deletingId={deletingFileId}
          onClose={() => setFileHistoryOpen(false)}
          onAdd={addOpenedFile}
          onOpen={(file) => openAgentFile(file.path)}
          onDelete={(file) => void removeOpenedFile(file)}
        />
      </>}
      <div className="timeline-shell">
        <div
          className="timeline"
          aria-live="polite"
          ref={timelineElement}
          onScroll={(event) => {
            if (programmaticTimelineScroll.current) return;
            const element = event.currentTarget;
            const awayFromBottom = isTimelineAwayFromBottom(element);
            followStreamingOutput.current = !awayFromBottom;
            setShowScrollToBottom(awayFromBottom);
          }}
        >
          {!isDraft && detail?.messagePage.hasMore && (
            <div className="message-page-control">
              <button type="button" disabled={loadingEarlier} onClick={() => void loadEarlierMessages()}>
                {loadingEarlier ? "正在加载…" : "加载更早消息"}
              </button>
              {loadEarlierError && !viewingHistoricalMessages && <span>{loadEarlierError}</span>}
            </div>
          )}
          {isDraft ? (
            <div className="draft-welcome">
              <EmptyConversationGraphic />
              <h2>开始一个新会话</h2>
              <p>直接输入任务即可。发送前不会创建任何记录，标题会根据第一条消息自动生成。</p>
            </div>
          ) : timeline.length === 0 && (
            <div className="empty">
              <strong>{conversation?.status === "creating" ? "正在创建会话并启动任务…" : "对话已经准备好"}</strong>
              <span>{conversation?.status === "creating" ? "节点响应后会自动开始流式输出。" : "在下方输入第一个任务。"}</span>
            </div>
          )}
          {timeline.length > 0 && <div className="virtual-timeline" style={{ height: `${timelineVirtualizer.getTotalSize()}px` }}>
            {timelineVirtualizer.getVirtualItems().map((virtualRow) => {
              const entry = timeline[virtualRow.index];
              if (!entry) return null;
              return <div
                className="virtual-timeline-row"
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={timelineVirtualizer.measureElement}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <TimelineCard entry={entry} attachments={detail?.attachments ?? []} onOpenLocalPath={openAgentFile} />
              </div>;
            })}
          </div>}
          {currentApprovals.map((approval) => <ApprovalCard key={approval.id} approval={approval} onDone={onRefresh} />)}
          {detail?.runs.filter((run) => run.error && !run.errorDismissedAt && !dismissedRunErrorIds.has(run.id)).map((run) => (
            <div className="run-error" role="status" key={`error-${run.id}`}>
              <span>{run.error}</span>
              <button
                className="error-notice-close"
                type="button"
                aria-label="关闭任务错误提示"
                title="关闭"
                disabled={dismissingRunErrorId !== null}
                onClick={() => void closeRunError(run.id)}
              >×</button>
            </div>
          ))}
        </div>
        {viewingHistoricalMessages ? (
          <button
            className="return-to-latest"
            type="button"
            disabled={returningLatest}
            title={`历史消息分批加载，当前浏览器最多保留 ${messageHistoryCacheLimit} 条`}
            onClick={() => void returnToLatestMessages()}
          >
            <span aria-hidden="true">↓</span>{returningLatest ? "正在返回最新消息…" : "历史阅读模式 · 返回最新消息"}
          </button>
        ) : showScrollToBottom && (
          <button className="scroll-to-bottom" type="button" onClick={scrollToTimelineBottom}>
            <span aria-hidden="true">↓</span>滑动到底部
          </button>
        )}
        {viewingHistoricalMessages && loadEarlierError && <div className="history-navigation-error" role="alert">
          <span>{loadEarlierError}</span>
          <button className="error-notice-close" type="button" aria-label="关闭历史消息错误提示" title="关闭" onClick={() => setLoadEarlierError(null)}>×</button>
        </div>}
      </div>
      <div className="run-dock">
        {activeRun && (
          <section className="run-float" aria-live="polite" aria-label="当前任务状态">
            <div className="run-float-detail">
              <strong className={`stream-state stream-state-${activeRun.status}`}><i aria-hidden="true" />{activeStateText}</strong>
              <span>{activeModelText} · {activeEffortText}</span>
            </div>
            <StatusBadge status={activeRun.status} />
            <button
              className="stop-button"
              type="button"
              disabled={busy || !activeRun.remoteTurnId}
              title="中止当前轮次；已执行的操作不会自动撤销"
              onClick={() => void interruptActiveRun()}
            >
              {activeRun.remoteTurnId ? "中止本轮" : "准备中…"}
            </button>
          </section>
        )}
      </div>
      <form className="composer" onSubmit={submit} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles([...event.dataTransfer.files]); }}>
        {error && !showCompactConfirm && <div className="composer-error" role="alert">
          <span>{error}</span>
          <button className="error-notice-close" type="button" aria-label="关闭对话错误提示" title="关闭" onClick={() => setError(null)}>×</button>
        </div>}
        <ConversationUsageBar
          usage={conversation?.tokenUsage ?? null}
          draft={isDraft}
          compaction={compaction}
          disabled={busy || Boolean(activeRun) || node.status !== "online" || conversation?.status !== "ready"}
          recommended={compactRecommended}
          onRequestCompact={requestCompaction}
        />
        {compaction?.status === "failed" && compaction.error && (
          <div className="compaction-error" role="status">压缩失败：{compaction.error}</div>
        )}
        {uploads.length > 0 && <div className="upload-list">{uploads.map((upload) => <div className={`upload-item upload-${upload.status}`} key={upload.localId}>
          {upload.previewUrl ? <img src={upload.previewUrl} alt="" /> : <span className="upload-file-icon">DOC</span>}
          <span className="upload-copy"><strong>{upload.file.name || "粘贴的图片"}</strong><small>{upload.status === "ready" ? `${(upload.file.size / 1024).toFixed(0)} KB · 已就绪` : upload.status === "failed" ? upload.error : `上传中 ${Math.round(upload.progress / upload.file.size * 100)}%`}</small></span>
          {upload.status === "failed" && <button type="button" onClick={() => void performUpload(upload.localId, upload.file, upload.attachment)}>重试</button>}
          <button type="button" className="upload-remove" onClick={() => removeUpload(upload)} aria-label={`移除 ${upload.file.name}`}>×</button>
        </div>)}</div>}
        <textarea
          ref={promptElement}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={compactionActive ? "正在压缩上下文…" : activeRun ? "向正在执行的任务追加指令…" : "描述你希望 Codex 完成的任务…"}
          rows={2}
          disabled={!canCompose}
          onPaste={(event) => {
            const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
            if (images.length > 0) addFiles(images);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="composer-footer">
          <div className="composer-toolbar" aria-label="会话选项">
            <input ref={fileInputElement} className="file-input" type="file" multiple onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
            <button className="attach-button" type="button" onClick={() => fileInputElement.current?.click()} disabled={busy || compactionActive || uploads.length >= 10} title="上传文件或图片">＋ 附件</button>
            {isDraft ? (
              <label className="setting-field workspace-setting">
                <select aria-label="选择工作空间" title="选择工作空间" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} disabled={busy || node.status !== "online"}>
                  {node.workspaces.filter((candidate) => !candidate.archivedAt && candidate.source !== "history").map((candidate) => (
                    <option key={candidate.id} value={candidate.id} disabled={candidate.status !== "valid"}>
                      {candidate.name}{candidate.isDefault ? "（默认）" : ""} · {candidate.path}
                    </option>
                  ))}
                  {node.workspaces.every((candidate) => Boolean(candidate.archivedAt) || candidate.source === "history") && <option value="">没有有效工作空间</option>}
                </select>
              </label>
            ) : (
              <div
                className="workspace-setting workspace-readonly"
                role="group"
                aria-label={`当前工作空间：${workspace?.name ?? "未知工作空间"}，${workspace?.path ?? effectiveWorkspaceId}。会话创建后不可更改`}
                title={`${workspace?.name ?? "未知工作空间"} · ${workspace?.path ?? effectiveWorkspaceId}\n会话创建后不可更改`}
              >
                <span className="workspace-readonly-icon" aria-hidden="true">⌂</span>
                <span className="workspace-readonly-copy">
                  <strong>{workspace?.name ?? "未知工作空间"}</strong>
                  <small>{workspace?.path ?? effectiveWorkspaceId}</small>
                </span>
              </div>
            )}
            <label className="setting-field model-setting">
              <select
                aria-label="选择模型"
                title="选择模型"
                value={model}
                disabled={busy || Boolean(activeRun) || compactionActive}
                onChange={(event) => {
                  const nextModel = event.target.value;
                  setModel(nextModel);
                  const descriptor = modelCatalog.find((candidate) => candidate.id === nextModel);
                  setEffort(descriptor?.defaultReasoningEffort ?? "");
                }}
              >
                <option value="">本机默认</option>
                {conversation?.model && !modelCatalog.some((candidate) => candidate.id === conversation.model) && (
                  <option value={conversation.model}>{conversation.model}</option>
                )}
                {modelCatalog.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.displayName}</option>)}
              </select>
            </label>
            <label className="setting-field effort-setting">
              <select aria-label="选择思考强度" title="选择思考强度" value={effort} disabled={busy || Boolean(activeRun) || compactionActive} onChange={(event) => setEffort(event.target.value as ReasoningEffort | "")}>
                <option value="">模型默认</option>
                {conversation?.effort && !effortOptions.some((candidate) => candidate.reasoningEffort === conversation.effort) && (
                  <option value={conversation.effort}>{effortLabels[conversation.effort]}</option>
                )}
                {effortOptions.map((candidate) => (
                  <option key={candidate.reasoningEffort} value={candidate.reasoningEffort}>{effortLabels[candidate.reasoningEffort]}</option>
                ))}
              </select>
            </label>
          </div>
          <button className="send-button" disabled={busy || !prompt.trim() || !canCompose || uploads.some((upload) => upload.status !== "ready")}>
            {busy ? "…" : uploads.some((upload) => upload.status === "uploading") ? "上传中" : "发送"}
          </button>
        </div>
        {showCompactConfirm && (
          <div className="compact-confirm-backdrop" role="presentation">
            <section className="compact-confirm" role="dialog" aria-modal="true" aria-labelledby="compact-confirm-title">
              <span className="compact-confirm-icon" aria-hidden="true">↙↗</span>
              <div>
                <h2 id="compact-confirm-title">压缩当前会话？</h2>
                <p>Codex 会概括当前有效上下文以释放空间。聊天记录仍会保留，但后续对话使用的是压缩后的摘要。</p>
                <p className="compact-confirm-note">压缩会消耗一定 Token，完成后不能直接撤销。</p>
                {error && <p className="compact-confirm-error" role="alert">{error}</p>}
                <div className="compact-confirm-actions">
                  <button type="button" autoFocus disabled={compactSubmitting} onClick={() => setShowCompactConfirm(false)}>取消</button>
                  <button className="primary-button" type="button" disabled={compactSubmitting} onClick={() => void confirmCompaction()}>
                    {compactSubmitting ? "正在提交…" : "确认压缩"}
                  </button>
                </div>
              </div>
            </section>
          </div>
        )}
        {showWorkspaceConcurrencyConfirm && (
          <WorkspaceConcurrencyDialog
            workspace={workspace}
            busy={busy}
            onCancel={() => setShowWorkspaceConcurrencyConfirm(false)}
            onConfirm={() => void sendMessage(true)}
          />
        )}
      </form>
    </main>
  );
}

function AuthenticatedApp({ onLogout }: { onLogout: () => Promise<void> | void }) {
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationTotal, setConversationTotal] = useState(0);
  const [conversationNextCursor, setConversationNextCursor] = useState<string | null>(null);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationSearch, setConversationSearch] = useState("");
  const [conversationFilter, setConversationFilter] = useState<"all" | "active" | "failed">("all");
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [viewingHistoricalMessages, setViewingHistoricalMessages] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<Approval[]>([]);
  const [settings, setSettings] = useState<GlobalSettings>({ defaultModel: null, defaultEffort: null });
  const [taskEntries, setTaskEntries] = useState<TaskCenterEntry[]>([]);
  const [unreadTaskCount, setUnreadTaskCount] = useState(0);
  const [taskPolicy, setTaskPolicy] = useState<TaskCenterPolicy>({ limit: 200, replyPreviewCharacters: 120, readRetentionDays: 30, unreadRetentionDays: 90 });
  const [quickConversations, setQuickConversations] = useState<Conversation[]>([]);
  const [quickLoading, setQuickLoading] = useState(false);
  const [quickError, setQuickError] = useState<string | null>(null);
  const [primaryView, setPrimaryView] = useState<"workspace" | "tasks">("workspace");
  const [overlay, setOverlay] = useState<"settings" | "switcher" | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() => sessionStoredValue(selectedNodeStorageKey));
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(() => sessionStoredValue(selectedConversationStorageKey));
  const [draftRequestId, setDraftRequestId] = useState(() => sessionStoredValue(draftRequestStorageKey) ?? newDraftRequestId());
  const [nodesCollapsed, setNodesCollapsed] = useState(() => storedBoolean(nodesCollapsedStorageKey));
  const [historyCollapsed, setHistoryCollapsed] = useState(() => selectedNodeId && !selectedConversationId
    ? false
    : storedBoolean(historyCollapsedStorageKey));
  const [mobilePane, setMobilePane] = useState<MobilePane>(() => selectedConversationId
    ? "chat"
    : selectedNodeId ? "conversations" : "nodes");
  const [streamConnected, setStreamConnected] = useState(false);
  const [backgroundIssues, setBackgroundIssues] = useState<Partial<Record<BackgroundIssueSource, BackgroundIssue>>>({});
  const [dismissedBackgroundIssues, setDismissedBackgroundIssues] = useState<Partial<Record<BackgroundIssueSource, string>>>({});
  const selectedNodeIdRef = useRef(selectedNodeId);
  const selectedConversationIdRef = useRef(selectedConversationId);
  const draftRequestIdRef = useRef(draftRequestId);
  const nodesRequestRef = useRef(0);
  const approvalsRequestRef = useRef(0);
  const settingsRequestRef = useRef(0);
  const conversationListRequestRef = useRef(0);
  const conversationListAppliedRef = useRef(0);
  const conversationSearchRef = useRef("");
  const conversationFilterRef = useRef<"all" | "active" | "failed">("all");
  const conversationNextCursorRef = useRef<string | null>(null);
  const quickSearchRequestRef = useRef(0);
  const conversationDetailRequestRef = useRef(0);
  const conversationDetailAppliedRef = useRef(0);
  const taskCenterRequestRef = useRef(0);
  const taskCenterAppliedRef = useRef(0);
  const detailRef = useRef<ConversationDetail | null>(null);
  const viewingHistoricalMessagesRef = useRef(false);
  const presenceContextRef = useRef({
    selectedConversationId,
    primaryView,
    overlay,
    mobilePane,
  });
  const presenceReporterRef = useRef<(force?: boolean) => void>(() => undefined);
  const [browserSessionId] = useState(() => {
    try {
      const existing = window.sessionStorage.getItem(browserSessionStorageKey);
      if (existing) return existing;
      const created = newDraftRequestId();
      window.sessionStorage.setItem(browserSessionStorageKey, created);
      return created;
    } catch {
      return newDraftRequestId();
    }
  });

  const commitSelectedNode = useCallback((nodeId: string | null) => {
    selectedNodeIdRef.current = nodeId;
    conversationListRequestRef.current += 1;
    conversationListAppliedRef.current = conversationListRequestRef.current;
    conversationNextCursorRef.current = null;
    setConversationNextCursor(null);
    setConversationTotal(0);
    setSelectedNodeId(nodeId);
  }, []);

  const commitViewingHistoricalMessages = useCallback((value: boolean) => {
    viewingHistoricalMessagesRef.current = value;
    setViewingHistoricalMessages(value);
  }, []);

  const commitSelectedConversation = useCallback((conversationId: string | null) => {
    selectedConversationIdRef.current = conversationId;
    const nodeId = selectedNodeIdRef.current;
    if (nodeId) sessionStoreValue(nodeConversationStorageKey(nodeId), conversationId);
    conversationDetailRequestRef.current += 1;
    conversationDetailAppliedRef.current = conversationDetailRequestRef.current;
    commitViewingHistoricalMessages(false);
    setSelectedConversationId(conversationId);
  }, [commitViewingHistoricalMessages]);

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  presenceContextRef.current = { selectedConversationId, primaryView, overlay, mobilePane };

  const commitDraftRequestId = useCallback((requestId: string) => {
    draftRequestIdRef.current = requestId;
    setDraftRequestId(requestId);
  }, []);

  const clearBackgroundIssue = useCallback((source: BackgroundIssueSource) => {
    setBackgroundIssues((current) => {
      if (!current[source]) return current;
      const next = { ...current };
      delete next[source];
      return next;
    });
    setDismissedBackgroundIssues((current) => {
      if (!current[source]) return current;
      const next = { ...current };
      delete next[source];
      return next;
    });
  }, []);

  const reportBackgroundIssue = useCallback((source: BackgroundIssueSource, reason: unknown, operation: string) => {
    setBackgroundIssues((current) => ({
      ...current,
      [source]: {
        source,
        message: `${formatErrorMessage(reason, operation)}；系统将自动重试`,
        occurredAt: Date.now(),
      },
    }));
  }, []);

  const dismissBackgroundIssues = useCallback(() => {
    setDismissedBackgroundIssues((current) => {
      const next = { ...current };
      for (const issue of Object.values(backgroundIssues)) {
        if (issue) next[issue.source] = issue.message;
      }
      return next;
    });
  }, [backgroundIssues]);

  const backgroundIssue = useMemo(() => Object.values(backgroundIssues)
    .filter((issue): issue is BackgroundIssue => Boolean(issue) && dismissedBackgroundIssues[issue.source] !== issue.message)
    .sort((left, right) => right.occurredAt - left.occurredAt)[0] ?? null, [backgroundIssues, dismissedBackgroundIssues]);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;

  const refreshNodes = useCallback(async () => {
    const requestRevision = ++nodesRequestRef.current;
    try {
      const result = await listNodes();
      if (requestRevision !== nodesRequestRef.current) return;
      setNodes(result);
      if (result.length === 0 && (selectedNodeIdRef.current || selectedConversationIdRef.current)) {
        commitSelectedNode(null);
        commitSelectedConversation(null);
        setConversations([]);
        setConversationTotal(0);
        setDetail(null);
      }
      clearBackgroundIssue("nodes");
    } catch (error) {
      if (requestRevision === nodesRequestRef.current) reportBackgroundIssue("nodes", error, "刷新节点状态");
    }
  }, [clearBackgroundIssue, commitSelectedConversation, commitSelectedNode, reportBackgroundIssue]);

  const refreshConversations = useCallback(async (options: {
    mode?: "refresh" | "replace" | "append";
    query?: string;
    filter?: "all" | "active" | "failed";
  } = {}) => {
    const requestedNodeId = selectedNodeIdRef.current;
    if (!requestedNodeId) {
      clearBackgroundIssue("conversations");
      return;
    }
    const mode = options.mode ?? "refresh";
    const requestedQuery = options.query ?? conversationSearchRef.current;
    const requestedFilter = options.filter ?? conversationFilterRef.current;
    const requestedCursor = mode === "append" ? conversationNextCursorRef.current : null;
    if (mode === "append" && !requestedCursor) return;
    const requestRevision = ++conversationListRequestRef.current;
    setConversationLoading(true);
    try {
      const result = await listConversations({
        nodeId: requestedNodeId,
        query: requestedQuery,
        ...(requestedFilter === "all" ? {} : { status: requestedFilter }),
        limit: conversationPageSize,
        ...(requestedCursor ? { cursor: requestedCursor } : {}),
      });
      if (selectedNodeIdRef.current === requestedNodeId
        && conversationSearchRef.current === requestedQuery
        && conversationFilterRef.current === requestedFilter
        && requestRevision > conversationListAppliedRef.current) {
        conversationListAppliedRef.current = requestRevision;
        if (mode === "append") {
          setConversations((current) => {
            const existing = new Set(current.map((conversation) => conversation.id));
            return limitConversationCache([...current, ...result.data.filter((conversation) => !existing.has(conversation.id))]);
          });
        } else if (mode === "refresh") {
          setConversations((current) => {
            const refreshed = new Set(result.data.map((conversation) => conversation.id));
            return limitConversationCache(
              [...result.data, ...current.filter((conversation) => !refreshed.has(conversation.id))].slice(0, result.total),
            );
          });
        } else {
          setConversations(limitConversationCache(result.data));
        }
        const nextCursor = mode === "refresh" && conversationNextCursorRef.current
          ? conversationNextCursorRef.current
          : result.nextCursor;
        conversationNextCursorRef.current = nextCursor;
        setConversationNextCursor(nextCursor);
        setConversationTotal(result.total);
        clearBackgroundIssue("conversations");
      }
    } catch (error) {
      if (selectedNodeIdRef.current === requestedNodeId && requestRevision > conversationListAppliedRef.current) {
        reportBackgroundIssue("conversations", error, "刷新会话列表");
      }
    } finally {
      if (requestRevision === conversationListRequestRef.current) setConversationLoading(false);
    }
  }, [clearBackgroundIssue, reportBackgroundIssue]);

  const refreshDetail = useCallback(async () => {
    const requestedConversationId = selectedConversationIdRef.current;
    if (!requestedConversationId) {
      clearBackgroundIssue("detail");
      return;
    }
    const requestRevision = ++conversationDetailRequestRef.current;
    try {
      const result = await getConversation(requestedConversationId, { messageLimit: recentMessagePageSize });
      if (selectedConversationIdRef.current === requestedConversationId && requestRevision > conversationDetailAppliedRef.current) {
        if (result.conversation.nodeId !== selectedNodeIdRef.current) {
          conversationDetailAppliedRef.current = requestRevision;
          clearBackgroundIssue("detail");
          commitSelectedConversation(null);
          setDetail(null);
          commitDraftRequestId(newDraftRequestId());
          return;
        }
        conversationDetailAppliedRef.current = requestRevision;
        if (viewingHistoricalMessagesRef.current) {
          setDetail((current) => current?.conversation.id === result.conversation.id
            ? {
                ...result,
                messages: current.messages,
                messagePage: current.messagePage,
                attachments: current.attachments,
              }
            : boundedConversationDetail(result, "latest", recentMessagePageSize));
        } else {
          setDetail(boundedConversationDetail(result, "latest", recentMessagePageSize));
        }
        clearBackgroundIssue("detail");
      }
    } catch (error) {
      if (selectedConversationIdRef.current === requestedConversationId && requestRevision > conversationDetailAppliedRef.current) {
        if (error instanceof ApiError
          && error.status === 404
          && ["Conversation not found", "会话不存在或已被删除"].includes(error.message)) {
          conversationDetailAppliedRef.current = requestRevision;
          clearBackgroundIssue("detail");
          commitSelectedConversation(null);
          setDetail(null);
          commitDraftRequestId(newDraftRequestId());
          setMobilePane("chat");
          return;
        }
        reportBackgroundIssue("detail", error, "恢复会话");
      }
    }
  }, [clearBackgroundIssue, commitDraftRequestId, commitSelectedConversation, reportBackgroundIssue]);

  const loadEarlierMessages = useCallback(async () => {
    const requestedConversationId = selectedConversationIdRef.current;
    const beforeMessage = detailRef.current?.conversation.id === requestedConversationId
      ? detailRef.current.messagePage.before
      : null;
    if (!requestedConversationId || !beforeMessage) return;
    const result = await getConversation(requestedConversationId, {
      beforeMessage,
      messageLimit: recentMessagePageSize,
    });
    if (selectedConversationIdRef.current !== requestedConversationId) return;
    commitViewingHistoricalMessages(true);
    setDetail((current) => mergedConversationDetail(current, result, "older"));
    clearBackgroundIssue("detail");
  }, [clearBackgroundIssue, commitViewingHistoricalMessages]);

  const returnToLatestMessages = useCallback(async () => {
    const requestedConversationId = selectedConversationIdRef.current;
    if (!requestedConversationId) return;
    const requestRevision = ++conversationDetailRequestRef.current;
    const result = await getConversation(requestedConversationId, { messageLimit: recentMessagePageSize });
    if (selectedConversationIdRef.current !== requestedConversationId) return;
    if (result.conversation.nodeId !== selectedNodeIdRef.current) {
      throw new Error("会话所属节点已变化，请重新选择节点");
    }
    conversationDetailAppliedRef.current = Math.max(conversationDetailAppliedRef.current, requestRevision);
    commitViewingHistoricalMessages(false);
    setDetail(boundedConversationDetail(result, "latest", recentMessagePageSize));
    clearBackgroundIssue("detail");
  }, [clearBackgroundIssue, commitViewingHistoricalMessages]);

  const refreshApprovals = useCallback(async () => {
    const requestRevision = ++approvalsRequestRef.current;
    try {
      const result = await listPendingApprovals();
      if (requestRevision !== approvalsRequestRef.current) return;
      setPendingApprovals(result);
      clearBackgroundIssue("approvals");
    } catch (error) {
      if (requestRevision === approvalsRequestRef.current) reportBackgroundIssue("approvals", error, "刷新待处理请求");
    }
  }, [clearBackgroundIssue, reportBackgroundIssue]);

  const refreshSettings = useCallback(async () => {
    const requestRevision = ++settingsRequestRef.current;
    try {
      const result = await getSettings();
      if (requestRevision !== settingsRequestRef.current) return;
      setSettings(result);
      clearBackgroundIssue("settings");
    } catch (error) {
      if (requestRevision === settingsRequestRef.current) reportBackgroundIssue("settings", error, "刷新全局设置");
    }
  }, [clearBackgroundIssue, reportBackgroundIssue]);

  const refreshTasks = useCallback(async () => {
    const requestRevision = ++taskCenterRequestRef.current;
    try {
      const result = await getTaskCenter();
      if (requestRevision > taskCenterAppliedRef.current) {
        taskCenterAppliedRef.current = requestRevision;
        setTaskEntries(result.entries);
        setUnreadTaskCount(result.unreadCount);
        setTaskPolicy(result.policy);
        clearBackgroundIssue("tasks");
      }
    } catch (error) {
      if (requestRevision > taskCenterAppliedRef.current) {
        reportBackgroundIssue("tasks", error, "刷新任务中心");
      }
    }
  }, [clearBackgroundIssue, reportBackgroundIssue]);

  const refreshAll = useCallback(() => {
    void refreshNodes();
    void refreshConversations();
    void refreshDetail();
    void refreshApprovals();
    void refreshTasks();
  }, [refreshNodes, refreshConversations, refreshDetail, refreshApprovals, refreshTasks]);

  const searchQuickConversations = useCallback(async (query: string) => {
    const requestRevision = ++quickSearchRequestRef.current;
    setQuickError(null);
    const keyword = query.trim();
    if (!keyword) {
      setQuickConversations([]);
      setQuickLoading(false);
      return;
    }
    setQuickLoading(true);
    try {
      const result = await listConversations({ query: keyword, limit: 10, includeTotal: false });
      if (requestRevision === quickSearchRequestRef.current) setQuickConversations(result.data);
    } catch (reason) {
      if (requestRevision === quickSearchRequestRef.current) setQuickError(formatErrorMessage(reason, "搜索节点和会话"));
    } finally {
      if (requestRevision === quickSearchRequestRef.current) setQuickLoading(false);
    }
  }, []);

  const openQuickSwitcher = useCallback(() => {
    quickSearchRequestRef.current += 1;
    setOverlay("switcher");
    setQuickLoading(false);
    setQuickError(null);
    setQuickConversations([]);
  }, []);

  useEffect(() => {
    void refreshNodes();
    void refreshApprovals();
    void refreshSettings();
    void refreshTasks();
  }, [refreshApprovals, refreshNodes, refreshSettings, refreshTasks]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshAll();
    };
    const interval = window.setInterval(
      refreshWhenVisible,
      streamConnected ? connectedSafetySyncIntervalMs : disconnectedFallbackSyncIntervalMs,
    );
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshAll, streamConnected]);

  useEffect(() => {
    if (nodes.length === 0) return;
    if (!selectedNodeId || !nodes.some((node) => node.id === selectedNodeId)) {
      commitSelectedNode(nodes[0].id);
      commitSelectedConversation(null);
      setDetail(null);
      commitDraftRequestId(newDraftRequestId());
      setHistoryCollapsed(false);
      setMobilePane("conversations");
    }
  }, [nodes, selectedNodeId, commitSelectedNode, commitSelectedConversation, commitDraftRequestId]);

  useEffect(() => sessionStoreValue(selectedNodeStorageKey, selectedNodeId), [selectedNodeId]);
  useEffect(() => sessionStoreValue(selectedConversationStorageKey, selectedConversationId), [selectedConversationId]);
  useEffect(() => {
    if (selectedNodeId) sessionStoreValue(nodeConversationStorageKey(selectedNodeId), selectedConversationId);
  }, [selectedConversationId, selectedNodeId]);
  useEffect(() => sessionStoreValue(draftRequestStorageKey, draftRequestId), [draftRequestId]);
  useEffect(() => storeValue(nodesCollapsedStorageKey, String(nodesCollapsed)), [nodesCollapsed]);
  useEffect(() => storeValue(historyCollapsedStorageKey, String(historyCollapsed)), [historyCollapsed]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        if (overlay === "switcher") setOverlay(null);
        else openQuickSwitcher();
      } else if (event.key === "Escape" && overlay !== null) {
        setOverlay(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openQuickSwitcher, overlay]);

  useEffect(() => {
    conversationSearchRef.current = conversationSearch;
    conversationFilterRef.current = conversationFilter;
    conversationNextCursorRef.current = null;
    setConversationNextCursor(null);
    if (!selectedNodeId) {
      setConversations([]);
      setConversationTotal(0);
      setConversationLoading(false);
      return;
    }
    setConversationLoading(true);
    const timer = window.setTimeout(() => {
      void refreshConversations({ mode: "replace", query: conversationSearch, filter: conversationFilter });
    }, conversationSearch.trim() ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [conversationFilter, conversationSearch, refreshConversations, selectedNodeId]);

  useEffect(() => {
    if (!selectedConversationId) {
      setDetail(null);
      return;
    }
    void refreshDetail();
    void markConversationRead(selectedConversationId).then(refreshTasks).catch(() => undefined);
  }, [selectedConversationId, refreshDetail]);

  useEffect(() => {
    let lastPresence = "";
    let resizeTimer: number | null = null;
    const report = (force = false) => {
      const context = presenceContextRef.current;
      const pageIsVisible = document.visibilityState === "visible";
      const chatIsVisible = context.primaryView === "workspace"
        && context.overlay === null
        && (window.innerWidth > 840 || context.mobilePane === "chat");
      const conversationId = pageIsVisible && chatIsVisible ? context.selectedConversationId : null;
      const signature = `${conversationId ?? ""}:${pageIsVisible}`;
      if (!force && signature === lastPresence) return;
      lastPresence = signature;
      void updatePresence(browserSessionId, conversationId, pageIsVisible).catch(() => undefined);
    };
    const onVisibilityChange = () => report(true);
    const onResize = () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        report(false);
      }, 300);
    };
    presenceReporterRef.current = report;
    report(true);
    const interval = window.setInterval(() => report(true), presenceHeartbeatIntervalMs);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("resize", onResize);
    return () => {
      presenceReporterRef.current = () => undefined;
      window.clearInterval(interval);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("resize", onResize);
      void updatePresence(browserSessionId, presenceContextRef.current.selectedConversationId, false).catch(() => undefined);
    };
  }, [browserSessionId]);

  useEffect(() => {
    presenceReporterRef.current(false);
  }, [mobilePane, overlay, primaryView, selectedConversationId]);

  useEffect(() => {
    const storedRevision = Number(storedValue(streamRevisionStorageKey) ?? 0);
    const source = new EventSource(streamUrl(Number.isSafeInteger(storedRevision) ? storedRevision : 0), { withCredentials: true });
    const refreshTimers = new Map<string, number>();
    let hasBeenReady = false;
    const schedule = (key: string, callback: () => void, delay: number) => {
      if (refreshTimers.has(key)) return;
      const timer = window.setTimeout(() => {
        refreshTimers.delete(key);
        callback();
      }, delay);
      refreshTimers.set(key, timer);
    };
    source.addEventListener("ready", () => {
      setStreamConnected(true);
      if (hasBeenReady) schedule("all", refreshAll, 100);
      hasBeenReady = true;
    });
    source.onerror = () => setStreamConnected(false);
    source.addEventListener("update", (event) => {
      const message = event as MessageEvent<string>;
      try {
        const data = JSON.parse(message.data) as {
          revision?: number;
          type?: string;
          resourceId?: string | null;
          conversationId?: string | null;
        };
        if (typeof data.revision === "number") storeValue(streamRevisionStorageKey, String(data.revision));
        if (typeof data.type !== "string") {
          schedule("all", refreshAll, 1_000);
          return;
        }
        const conversationId = data.conversationId
          ?? (data.type.startsWith("conversation.") ? data.resourceId : null);
        const selectedConversationAffected = !conversationId || conversationId === selectedConversationIdRef.current;
        if (data.type.startsWith("node.")) {
          schedule("nodes", () => void refreshNodes(), 250);
        } else if (data.type.startsWith("workspace-file-history.")) {
          window.dispatchEvent(new CustomEvent("controller-center:workspace-file-history", { detail: { conversationId } }));
        } else if (data.type.startsWith("workspace.")) {
          schedule("nodes", () => void refreshNodes(), 400);
        } else if (data.type.startsWith("conversation.")) {
          schedule("conversations", () => void refreshConversations(), 400);
          if (selectedConversationAffected) schedule("detail", () => void refreshDetail(), 400);
        } else if (data.type.startsWith("usage.")) {
          if (selectedConversationAffected) schedule("detail", () => void refreshDetail(), 400);
        } else if (data.type.startsWith("message.")) {
          if (selectedConversationAffected) schedule("detail", () => void refreshDetail(), 500);
          schedule("conversations", () => void refreshConversations(), 1_500);
        } else if (data.type.startsWith("run.") || data.type === "agent.error") {
          if (selectedConversationAffected) schedule("detail", () => void refreshDetail(), 500);
          schedule("conversations", () => void refreshConversations(), 1_000);
        } else if (data.type.startsWith("approval.")) {
          schedule("approvals", () => void refreshApprovals(), 300);
          if (selectedConversationAffected) schedule("detail", () => void refreshDetail(), 500);
        } else if (data.type.startsWith("notification.")) {
          schedule("tasks", () => void refreshTasks(), 300);
        } else if (data.type.startsWith("settings.")) {
          schedule("settings", () => void refreshSettings(), 300);
        } else if (data.type.startsWith("enrollment.")) {
          schedule("nodes", () => void refreshNodes(), 500);
        } else if (!data.type.startsWith("command.")) {
          schedule("all", refreshAll, 1_000);
        }
      } catch {
        schedule("all", refreshAll, 1_000);
      }
    });
    return () => {
      for (const timer of refreshTimers.values()) window.clearTimeout(timer);
      source.close();
    };
  }, [refreshAll, refreshApprovals, refreshConversations, refreshDetail, refreshNodes, refreshSettings, refreshTasks]);

  function beginNewConversation() {
    commitSelectedConversation(null);
    setDetail(null);
    commitDraftRequestId(newDraftRequestId());
    setPrimaryView("workspace");
    setMobilePane("chat");
  }

  function selectNode(node: NodeRecord) {
    const nodeChanged = selectedNodeIdRef.current !== node.id;
    if (!nodeChanged) {
      setPrimaryView("workspace");
      if (selectedConversationIdRef.current) {
        setMobilePane("chat");
      } else {
        setHistoryCollapsed(false);
        setMobilePane("conversations");
      }
      setOverlay(null);
      return;
    }
    conversationSearchRef.current = "";
    conversationFilterRef.current = "all";
    setConversationSearch("");
    setConversationFilter("all");
    const rememberedConversationId = sessionStoredValue(nodeConversationStorageKey(node.id));
    commitSelectedNode(node.id);
    commitSelectedConversation(rememberedConversationId);
    setConversations([]);
    setDetail(null);
    commitDraftRequestId(newDraftRequestId());
    setPrimaryView("workspace");
    if (rememberedConversationId) {
      setMobilePane("chat");
    } else {
      setHistoryCollapsed(false);
      setMobilePane("conversations");
    }
    setOverlay(null);
  }

  function selectConversation(conversation: Conversation) {
    if (selectedNodeIdRef.current !== conversation.nodeId) {
      conversationSearchRef.current = "";
      conversationFilterRef.current = "all";
      setConversationSearch("");
      setConversationFilter("all");
      commitSelectedNode(conversation.nodeId);
      setConversations([]);
    }
    commitSelectedConversation(conversation.id);
    setDetail(null);
    setPrimaryView("workspace");
    setMobilePane("chat");
    setOverlay(null);
    void refreshDetail();
  }

  async function removeConversation(conversation: Conversation): Promise<void> {
    await deleteConversation(conversation.id);
    setConversations((current) => current.filter((candidate) => candidate.id !== conversation.id));
    setConversationTotal((current) => Math.max(0, current - 1));
    if (selectedConversationIdRef.current === conversation.id) beginNewConversation();
  }

  function conversationStarted(conversation: Conversation, run: Run, originatingDraftRequestId: string) {
    const matchesSearch = !conversationSearchRef.current.trim()
      || conversation.title.toLocaleLowerCase().includes(conversationSearchRef.current.trim().toLocaleLowerCase());
    const matchesFilter = conversationFilterRef.current === "all" || conversationFilterRef.current === "active";
    if (matchesSearch && matchesFilter) {
      setConversations((current) => limitConversationCache([conversation, ...current.filter((candidate) => candidate.id !== conversation.id)]));
      setConversationTotal((current) => current + 1);
    }
    if (selectedConversationIdRef.current !== null || draftRequestIdRef.current !== originatingDraftRequestId) return;
    commitSelectedConversation(conversation.id);
    setDetail({
      conversation,
      runs: [run],
      messages: [],
      messagePage: { hasMore: false, before: null },
      attachments: [],
      approvals: [],
    });
    commitDraftRequestId(newDraftRequestId());
    setMobilePane("chat");
  }

  async function changeConversation(conversation: Conversation, input: { title?: string; pinned?: boolean }): Promise<void> {
    const updated = await updateConversation(conversation.id, input);
    setConversations((current) => limitConversationCache(current.map((candidate) => candidate.id === updated.id ? updated : candidate)));
    setDetail((current) => current?.conversation.id === updated.id ? { ...current, conversation: updated } : current);
    void refreshConversations({ mode: "replace" });
  }

  function openTask(entry: TaskCenterEntry): void {
    const node = nodes.find((candidate) => candidate.id === entry.nodeId);
    if (node && selectedNodeIdRef.current !== node.id) {
      conversationSearchRef.current = "";
      conversationFilterRef.current = "all";
      setConversationSearch("");
      setConversationFilter("all");
      commitSelectedNode(node.id);
      setConversations([]);
    }
    commitSelectedConversation(entry.conversationId);
    setDetail(null);
    setMobilePane("chat");
    setPrimaryView("workspace");
    void refreshDetail();
    void markConversationRead(entry.conversationId).then(refreshTasks).catch(() => undefined);
  }

  const onlineNodeCount = nodes.filter((node) => node.status === "online").length;

  return (
    <div className="app-root">
      {backgroundIssue && <div className="connection-banner" role="status">
        <span>{backgroundIssue.message}</span>
        <button className="connection-retry" type="button" onClick={refreshAll}>立即重试</button>
        <button className="error-notice-close" type="button" aria-label="关闭错误提示" title="关闭" onClick={dismissBackgroundIssues}>×</button>
      </div>}
      <div className={`layout mobile-${mobilePane} ${primaryView === "tasks" ? "task-center-active" : ""} ${nodesCollapsed ? "nodes-collapsed" : ""} ${historyCollapsed ? "history-collapsed" : ""}`}>
        <NodePanel
          nodes={nodes}
          selectedId={selectedNodeId}
          onSelect={selectNode}
          onRenamed={(updated) => setNodes((current) => current.map((node) => node.id === updated.id ? updated : node))}
          collapsed={nodesCollapsed}
          onToggleCollapsed={() => setNodesCollapsed((current) => !current)}
          taskEntries={taskEntries}
          unreadCount={unreadTaskCount}
          taskCenterActive={primaryView === "tasks"}
          onOpenSwitcher={openQuickSwitcher}
          onOpenTasks={() => { setOverlay(null); setPrimaryView("tasks"); }}
          onOpenSettings={() => setOverlay("settings")}
        />
        <ConversationPanel
          node={selectedNode}
          conversations={conversations}
          pendingApprovals={pendingApprovals}
          selectedId={selectedConversationId}
          onSelect={selectConversation}
          onNew={beginNewConversation}
          onDelete={removeConversation}
          onUpdate={changeConversation}
          onBack={() => setMobilePane("nodes")}
          collapsed={historyCollapsed}
          onToggleCollapsed={() => setHistoryCollapsed((current) => !current)}
          query={conversationSearch}
          onQueryChange={setConversationSearch}
          filter={conversationFilter}
          onFilterChange={setConversationFilter}
          total={conversationTotal}
          loading={conversationLoading}
          hasMore={Boolean(conversationNextCursor) && conversations.length < conversationCacheLimit}
          cacheLimited={conversationTotal > conversations.length && conversations.length >= conversationCacheLimit}
          onLoadMore={() => void refreshConversations({ mode: "append" })}
        />
        <button
          type="button"
          className="mobile-history-backdrop"
          aria-label="关闭历史会话"
          onClick={() => setMobilePane("chat")}
        />
        {primaryView === "tasks" ? (
          <TaskCenterPage
            entries={taskEntries}
            nodes={nodes}
            unreadCount={unreadTaskCount}
            policy={taskPolicy}
            onBack={() => setPrimaryView("workspace")}
            onOpen={openTask}
            onMarkAllRead={async () => { await markAllNotificationsRead(); await refreshTasks(); }}
            onRetry={async (entry, allowWorkspaceConcurrency) => {
              if (!entry.runId) return;
              await retryRun(entry.runId, allowWorkspaceConcurrency);
              refreshAll();
            }}
          />
        ) : <ChatPanel
          key={selectedConversationId ? `${selectedConversationId}:${detail?.conversation.id === selectedConversationId ? "ready" : "loading"}` : `draft:${draftRequestId}`}
          detail={detail}
          node={selectedNode}
          pendingApprovals={pendingApprovals}
          onRefresh={refreshAll}
          onLoadEarlier={loadEarlierMessages}
          onReturnLatest={returnToLatestMessages}
          viewingHistoricalMessages={viewingHistoricalMessages}
          onBack={() => setMobilePane("conversations")}
          onNew={beginNewConversation}
          draftRequestId={draftRequestId}
          isDraft={selectedConversationId === null}
          onConversationStarted={conversationStarted}
          settings={settings}
        />}
      </div>
      <nav className="mobile-toolbar" aria-label="移动端主导航">
        <button
          className={primaryView === "workspace" && mobilePane === "nodes" && overlay === null ? "active" : ""}
          type="button"
          aria-label={`查看节点，${onlineNodeCount} 个在线，共 ${nodes.length} 个节点`}
          aria-current={primaryView === "workspace" && mobilePane === "nodes" && overlay === null ? "page" : undefined}
          onClick={() => { setOverlay(null); setPrimaryView("workspace"); setMobilePane("nodes"); }}
        >
          <NodesIcon />
          <span className="mobile-nav-label">节点<small title={`${onlineNodeCount} 个在线，共 ${nodes.length} 个节点`}>{onlineNodeCount}/{nodes.length}</small></span>
        </button>
        <button
          className={primaryView === "tasks" ? "active" : ""}
          type="button"
          aria-label="消息中心"
          aria-current={primaryView === "tasks" ? "page" : undefined}
          onClick={() => { setOverlay(null); setPrimaryView("tasks"); }}
        >
          <BellIcon /><span>消息</span>{unreadTaskCount > 0 && <b>{unreadTaskCount > 99 ? "99+" : unreadTaskCount}</b>}
        </button>
        <button className={overlay === "switcher" ? "active" : ""} type="button" aria-label="快速切换" onClick={openQuickSwitcher}>
          <SearchIcon /><span>搜索</span>
        </button>
        <button className={overlay === "settings" ? "active" : ""} type="button" aria-label="设置" onClick={() => setOverlay("settings")}>
          <SettingsIcon /><span>设置</span>
        </button>
      </nav>
      {overlay === "settings" && <SettingsPanel settings={settings} nodes={nodes} selectedNodeId={selectedNodeId} onClose={() => setOverlay(null)} onSaved={setSettings} onNodesChanged={refreshNodes} onLogout={onLogout} />}
      {overlay === "switcher" && <QuickSwitcher
        nodes={nodes}
        conversations={quickConversations}
        loading={quickLoading}
        error={quickError}
        onClose={() => setOverlay(null)}
        onSearch={searchQuickConversations}
        onNode={(node) => {
          selectNode(node);
          setOverlay(null);
        }}
        onConversation={selectConversation}
      />}
    </div>
  );
}

function LoginScreen({ initialError, onAuthenticated, onRetry }: {
  initialError?: string | null;
  onAuthenticated: () => void;
  onRetry: () => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await loginAdmin(token.trim());
      setToken("");
      onAuthenticated();
    } catch (reason) {
      setError(formatErrorMessage(reason, "登录"));
    } finally {
      setBusy(false);
    }
  }

  return <main className="login-page">
    <section className="login-card">
      <div className="login-brand"><span>CC</span><div><strong>Controller Center</strong><small>集中调度你的 Codex 节点</small></div></div>
      <div className="login-copy"><span>ADMIN ACCESS</span><h1>登录控制中心</h1><p>输入部署机器上保存的管理员 Token。验证通过后，浏览器只保存安全会话 Cookie，不保存原始 Token。</p></div>
      <form onSubmit={(event) => void submit(event)}>
        <label><span>管理员 Token</span><input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="cca_…" autoComplete="current-password" autoFocus /></label>
        {error && <div className="login-error"><span>{error}</span>{initialError && <button type="button" onClick={onRetry}>重试连接</button>}</div>}
        <button className="primary-button" disabled={busy || !token.trim()}>{busy ? "正在验证…" : "进入控制中心"}</button>
      </form>
      <footer>管理员 Token 可在控制中心服务器本机通过管理命令查询。</footer>
    </section>
  </main>;
}

export function App() {
  const [state, setState] = useState<"loading" | "authenticated" | "anonymous" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const checkSession = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const session = await getAuthSession();
      setState(session.authenticated ? "authenticated" : "anonymous");
    } catch (reason) {
      setError(formatErrorMessage(reason, "检查登录状态"));
      setState("error");
    }
  }, []);

  useEffect(() => { void checkSession(); }, [checkSession]);
  useEffect(() => {
    const unauthorized = () => setState("anonymous");
    window.addEventListener("controller-center:unauthorized", unauthorized);
    return () => window.removeEventListener("controller-center:unauthorized", unauthorized);
  }, []);

  if (state === "loading") return <main className="auth-loading"><span /><strong>正在连接控制中心…</strong></main>;
  if (state !== "authenticated") {
    return <LoginScreen
      initialError={state === "error" ? error : null}
      onRetry={() => void checkSession()}
      onAuthenticated={() => setState("authenticated")}
    />;
  }
  if (/^\/workspace-files\/opening\/?$/u.test(window.location.pathname)) return <WorkspaceFileOpeningPage />;
  const workspaceFileRoute = /^\/workspace-files\/([^/]+)\/?$/u.exec(window.location.pathname);
  if (workspaceFileRoute) {
    try {
      return <WorkspaceFilePage fileId={decodeURIComponent(workspaceFileRoute[1]!)} />;
    } catch {
      return <main className="workspace-file-page"><div className="workspace-file-error">文件预览地址无效</div></main>;
    }
  }
  return <AuthenticatedApp onLogout={async () => {
    await logoutAdmin();
    setState("anonymous");
  }} />;
}
