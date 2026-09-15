import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
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
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  ApiError,
  deleteConversation,
  createEnrollmentToken,
  createNodeWorkspace,
  deleteNodeWorkspace,
  createAttachmentUpload,
  deleteAttachmentUpload,
  getConversation,
  getAuthSession,
  getSettings,
  getTaskCenter,
  interruptRun,
  listConversations,
  listEnrollmentTokens,
  listNodes,
  listNodeWorkspaces,
  listPendingApprovals,
  markAllNotificationsRead,
  markConversationRead,
  loginAdmin,
  logoutAdmin,
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
  AttachmentRecord,
  Conversation,
  ConversationDetail,
  EnrollmentToken,
  GlobalSettings,
  NodeRecord,
  ReasoningEffort,
  Run,
  TaskCenterEntry,
  TaskCenterPolicy,
  Workspace,
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
const draftRequestStorageKey = "controller-center:draft-request";
const nodesCollapsedStorageKey = "controller-center:nodes-collapsed";
const historyCollapsedStorageKey = "controller-center:history-collapsed";
const streamRevisionStorageKey = "controller-center:stream-revision";
const browserSessionStorageKey = "controller-center:browser-session";

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

function storedBoolean(key: string): boolean {
  return storedValue(key) === "true";
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

function StatusBadge({ status }: { status: string }) {
  return <span className={`status status-${status}`}>{statusText[status] ?? status}</span>;
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

function SettingsIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m16.4 11.2 1.1.9-1.5 2.6-1.4-.5c-.5.4-1 .7-1.6.9l-.3 1.4h-3l-.3-1.4c-.6-.2-1.1-.5-1.6-.9l-1.4.5-1.5-2.6 1.1-.9a6.5 6.5 0 0 1 0-1.9l-1.1-.9 1.5-2.6 1.4.5c.5-.4 1-.7 1.6-.9l.3-1.4h3l.3 1.4c.6.2 1.1.5 1.6.9l1.4-.5 1.5 2.6-1.1.9a6.5 6.5 0 0 1 0 1.9ZM11.2 8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Z" /></svg>;
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

function CopyableCodeBlock({ children, node: _node, ...props }: ComponentPropsWithoutRef<"pre"> & { node?: unknown }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const code = reactNodeText(children).replace(/\n$/, "");
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
      <pre {...props}>{children}</pre>
    </div>
  );
}

function MarkdownContent({ children }: { children: string }) {
  const markdown = useMemo(() => normalizeMathMarkdown(children), [children]);
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }], rehypeHighlight]}
        components={{ pre: CopyableCodeBlock }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
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
        <span>{node?.name ?? "对话"}</span>
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

function TimelineCard({ entry, attachments }: { entry: TimelineEntry; attachments: AttachmentRecord[] }) {
  const linkedAttachments = attachments.filter((attachment) => entry.attachmentIds.includes(attachment.id));
  return (
    <article className={`timeline-card timeline-${entry.kind}`} title={formatDate(entry.at)}>
      {linkedAttachments.length > 0 && <div className="message-attachments">{linkedAttachments.map((attachment) => <span key={attachment.id}>{attachment.mediaType.startsWith("image/") ? "图片" : "文件"} · {attachment.name}</span>)}</div>}
      <MarkdownContent>{entry.content}</MarkdownContent>
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

function EnrollmentSettings({ nodes, onNodesChanged }: { nodes: NodeRecord[]; onNodesChanged: () => Promise<void> | void }) {
  const [entries, setEntries] = useState<EnrollmentToken[]>([]);
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [confirmNodeId, setConfirmNodeId] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
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
    const timer = window.setInterval(update, 2_000);
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
    <div className="enrollment-create-card">
      <div><strong>注册新节点</strong><span>在目标机器准备好控制中心 HTTPS 地址，然后粘贴这里生成的 Token。</span></div>
      <button type="button" className="primary-button" disabled={busy} onClick={() => void create()}>{busy ? "生成中…" : "生成注册 Token"}</button>
    </div>
    {(error ?? refreshError) && <p className="form-error workspace-settings-error">{error ?? refreshError}</p>}
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
  onRetry: (entry: TaskCenterEntry) => Promise<void>;
}) {
  const [filter, setFilter] = useState<"all" | "active" | "attention" | "completed">("all");
  const [nodeId, setNodeId] = useState("all");
  const [query, setQuery] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
            onClick={() => void runAction(`retry:${entry.id}`, "重新执行任务", () => onRetry(entry))}
          >{busyAction === `retry:${entry.id}` ? "正在重试…" : "重新执行"}</button>}
        </div>)}
        {visible.length === 0 && <div className="empty"><strong>这里暂时没有任务</strong><span>运行中的任务和需要你关注的结果会显示在这里。</span></div>}
        </div>
        <footer className="task-center-policy">
          最多展示最近 {policy.limit} 条；回复摘要最多 {policy.replyPreviewCharacters} 个字符。已读通知保留 {policy.readRetentionDays} 天，未读通知保留 {policy.unreadRetentionDays} 天。清理通知不会删除会话历史。
        </footer>
      </section>
    </div>
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

function ChatPanel({
  detail,
  node,
  pendingApprovals,
  onRefresh,
  onBack,
  draftRequestId,
  isDraft,
  onConversationStarted,
  settings,
}: {
  detail: ConversationDetail | null;
  node: NodeRecord | null;
  pendingApprovals: Approval[];
  onRefresh: () => void;
  onBack: () => void;
  draftRequestId: string;
  isDraft: boolean;
  onConversationStarted: (conversation: Conversation, run: Run, draftRequestId: string) => void;
  settings: GlobalSettings;
}) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<ReasoningEffort | "">("");
  const [messageRequestId, setMessageRequestId] = useState(newDraftRequestId);
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const timelineElement = useRef<HTMLDivElement>(null);
  const promptElement = useRef<HTMLTextAreaElement>(null);
  const fileInputElement = useRef<HTMLInputElement>(null);
  const followStreamingOutput = useRef(true);
  const timelinePositioned = useRef(false);
  const programmaticTimelineScroll = useRef(false);
  const uploadsRef = useRef<PendingUpload[]>([]);
  const timeline = useMemo(() => buildTimeline(detail), [detail]);
  const activeRun = detail?.runs.findLast((run) => ["queued", "dispatching", "running", "waiting_approval", "recovering"].includes(run.status));
  const currentApprovals = detail ? pendingApprovals.filter((approval) => approval.conversationId === detail.conversation.id) : [];
  const modelCatalog = node?.models ?? [];
  const selectedModel = modelCatalog.find((candidate) => candidate.id === model)
    ?? modelCatalog.find((candidate) => candidate.isDefault);
  const effortOptions = selectedModel?.supportedReasoningEfforts ?? [];
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
  }, [node?.id, detail?.conversation.id, settings.defaultModel, settings.defaultEffort]);

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
  }, [timeline, activeRun?.status, currentApprovals.length]);

  useEffect(() => {
    const element = promptElement.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [prompt]);

  function scrollToTimelineBottom(): void {
    const element = timelineElement.current;
    if (!element) return;
    followStreamingOutput.current = true;
    setShowScrollToBottom(false);
    element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
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

  async function submit(event: FormEvent) {
    event.preventDefault();
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
        });
        setPrompt("");
        clearUploads();
        setMessageRequestId(newDraftRequestId());
      }
      onRefresh();
    } catch (reason) {
      const operation = !detail ? "创建会话" : activeRun?.remoteTurnId ? "追加任务指令" : "发送消息";
      setError(formatErrorMessage(reason, operation));
    } finally {
      setBusy(false);
    }
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
  const workspace = node.workspaces.find((item) => item.id === workspaceId);
  const canCompose = node.status === "online"
    && Boolean(workspaceId)
    && workspace?.status === "valid"
    && !workspace.archivedAt
    && (!isDraft || workspace.source !== "history")
    && (isDraft || conversation?.status === "ready")
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
    <main className="chat-pane">
      <header className="chat-header">
        <button className="icon-button mobile-back" onClick={onBack} aria-label="返回对话">‹</button>
        <div className="chat-title">
          <strong>{detail?.conversation.title ?? "新会话"}</strong>
          <span>{node.name} / {workspace?.name ?? workspaceId}</span>
        </div>
        <div className="chat-header-status">
          {isDraft ? <span className="status status-draft">草稿</span> : !activeRun && <StatusBadge status={conversation?.status ?? "creating"} />}
        </div>
      </header>
      <div className="timeline-shell">
        <div
          className="timeline"
          aria-live="polite"
          ref={timelineElement}
          onScroll={(event) => {
            if (programmaticTimelineScroll.current) return;
            const element = event.currentTarget;
            const awayFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight >= 96;
            followStreamingOutput.current = !awayFromBottom;
            setShowScrollToBottom(awayFromBottom);
          }}
        >
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
                <TimelineCard entry={entry} attachments={detail?.attachments ?? []} />
              </div>;
            })}
          </div>}
          {currentApprovals.map((approval) => <ApprovalCard key={approval.id} approval={approval} onDone={onRefresh} />)}
          {detail?.runs.filter((run) => run.error).map((run) => (
            <div className="run-error" key={`error-${run.id}`}>{run.error}</div>
          ))}
        </div>
        {showScrollToBottom && (
          <button className="scroll-to-bottom" type="button" onClick={scrollToTimelineBottom}>
            <span aria-hidden="true">↓</span>滑动到底部
          </button>
        )}
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
        {error && <div className="composer-error">{error}</div>}
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
          placeholder={activeRun ? "向正在执行的任务追加指令…" : "描述你希望 Codex 完成的任务…"}
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
          <div className="composer-toolbar">
            <input ref={fileInputElement} className="file-input" type="file" multiple onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
            <button className="attach-button" type="button" onClick={() => fileInputElement.current?.click()} disabled={busy || uploads.length >= 10} title="上传文件或图片">＋ 附件</button>
            {isDraft && (
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
            )}
            <label className="setting-field model-setting">
              <select
                aria-label="选择模型"
                title="选择模型"
                value={model}
                disabled={busy || Boolean(activeRun)}
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
              <select aria-label="选择思考强度" title="选择思考强度" value={effort} disabled={busy || Boolean(activeRun)} onChange={(event) => setEffort(event.target.value as ReasoningEffort | "")}>
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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() => storedValue(selectedNodeStorageKey));
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(() => storedValue(selectedConversationStorageKey));
  const [draftRequestId, setDraftRequestId] = useState(() => storedValue(draftRequestStorageKey) ?? newDraftRequestId());
  const [nodesCollapsed, setNodesCollapsed] = useState(() => storedBoolean(nodesCollapsedStorageKey));
  const [historyCollapsed, setHistoryCollapsed] = useState(() => storedBoolean(historyCollapsedStorageKey));
  const [mobilePane, setMobilePane] = useState<MobilePane>(() => storedValue(selectedConversationStorageKey) ? "chat" : "nodes");
  const [backgroundIssues, setBackgroundIssues] = useState<Partial<Record<BackgroundIssueSource, BackgroundIssue>>>({});
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

  const commitSelectedConversation = useCallback((conversationId: string | null) => {
    selectedConversationIdRef.current = conversationId;
    conversationDetailRequestRef.current += 1;
    conversationDetailAppliedRef.current = conversationDetailRequestRef.current;
    setSelectedConversationId(conversationId);
  }, []);

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

  const backgroundIssue = useMemo(() => Object.values(backgroundIssues)
    .filter((issue): issue is BackgroundIssue => Boolean(issue))
    .sort((left, right) => right.occurredAt - left.occurredAt)[0] ?? null, [backgroundIssues]);

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
        limit: 50,
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
            return [...current, ...result.data.filter((conversation) => !existing.has(conversation.id))];
          });
        } else if (mode === "refresh") {
          setConversations((current) => {
            const refreshed = new Set(result.data.map((conversation) => conversation.id));
            return [...result.data, ...current.filter((conversation) => !refreshed.has(conversation.id))].slice(0, result.total);
          });
        } else {
          setConversations(result.data);
        }
        conversationNextCursorRef.current = result.nextCursor;
        setConversationNextCursor(result.nextCursor);
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
      const result = await getConversation(requestedConversationId);
      if (selectedConversationIdRef.current === requestedConversationId && requestRevision > conversationDetailAppliedRef.current) {
        conversationDetailAppliedRef.current = requestRevision;
        setDetail(result);
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
    const interval = window.setInterval(refreshAll, 10_000);
    return () => window.clearInterval(interval);
  }, [refreshAll, refreshNodes, refreshApprovals, refreshSettings, refreshTasks]);

  useEffect(() => {
    if (nodes.length === 0) return;
    if (!selectedNodeId || !nodes.some((node) => node.id === selectedNodeId)) {
      commitSelectedNode(nodes[0].id);
      commitSelectedConversation(null);
      setDetail(null);
      commitDraftRequestId(newDraftRequestId());
    }
  }, [nodes, selectedNodeId, commitSelectedNode, commitSelectedConversation, commitDraftRequestId]);

  useEffect(() => storeValue(selectedNodeStorageKey, selectedNodeId), [selectedNodeId]);
  useEffect(() => storeValue(selectedConversationStorageKey, selectedConversationId), [selectedConversationId]);
  useEffect(() => storeValue(draftRequestStorageKey, draftRequestId), [draftRequestId]);
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
    const report = () => {
      const chatIsVisible = primaryView === "workspace"
        && overlay === null
        && (window.innerWidth > 840 || mobilePane === "chat");
      void updatePresence(
        browserSessionId,
        chatIsVisible ? selectedConversationId : null,
        document.visibilityState === "visible",
      ).catch(() => undefined);
    };
    report();
    const interval = window.setInterval(report, 15_000);
    document.addEventListener("visibilitychange", report);
    window.addEventListener("resize", report);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", report);
      window.removeEventListener("resize", report);
      void updatePresence(browserSessionId, selectedConversationId, false).catch(() => undefined);
    };
  }, [browserSessionId, mobilePane, overlay, primaryView, selectedConversationId]);

  useEffect(() => {
    const storedRevision = Number(storedValue(streamRevisionStorageKey) ?? 0);
    const source = new EventSource(streamUrl(Number.isSafeInteger(storedRevision) ? storedRevision : 0), { withCredentials: true });
    let refreshTimer: number | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        refreshAll();
      }, 100);
    };
    source.addEventListener("update", (event) => {
      const message = event as MessageEvent<string>;
      try {
        const data = JSON.parse(message.data) as { revision?: number };
        if (typeof data.revision === "number") storeValue(streamRevisionStorageKey, String(data.revision));
      } catch {
        // A malformed lightweight event is harmless because the REST refresh is authoritative.
      }
      scheduleRefresh();
    });
    return () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      source.close();
    };
  }, [refreshAll]);

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
      setMobilePane("chat");
      setOverlay(null);
      return;
    }
    conversationSearchRef.current = "";
    conversationFilterRef.current = "all";
    setConversationSearch("");
    setConversationFilter("all");
    commitSelectedNode(node.id);
    setConversations([]);
    beginNewConversation();
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
      setConversations((current) => [conversation, ...current.filter((candidate) => candidate.id !== conversation.id)]);
      setConversationTotal((current) => current + 1);
    }
    if (selectedConversationIdRef.current !== null || draftRequestIdRef.current !== originatingDraftRequestId) return;
    commitSelectedConversation(conversation.id);
    setDetail({ conversation, runs: [run], messages: [], attachments: [], approvals: [] });
    commitDraftRequestId(newDraftRequestId());
    setMobilePane("chat");
  }

  async function changeConversation(conversation: Conversation, input: { title?: string; pinned?: boolean }): Promise<void> {
    const updated = await updateConversation(conversation.id, input);
    setConversations((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
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

  return (
    <div className="app-root">
      {backgroundIssue && <div className="connection-banner" role="status"><span>{backgroundIssue.message}</span><button type="button" onClick={refreshAll}>立即重试</button></div>}
      <div className="mobile-topbar">
        <strong>Controller Center</strong>
        <div><button aria-label="快速切换" onClick={openQuickSwitcher}><SearchIcon /></button><button aria-label="任务中心" onClick={() => { setOverlay(null); setPrimaryView("tasks"); }}><BellIcon />{unreadTaskCount > 0 && <b>{unreadTaskCount}</b>}</button><button aria-label="设置" onClick={() => setOverlay("settings")}><SettingsIcon /></button></div>
      </div>
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
          hasMore={Boolean(conversationNextCursor)}
          onLoadMore={() => void refreshConversations({ mode: "append" })}
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
            onRetry={async (entry) => {
              if (!entry.runId) return;
              await retryRun(entry.runId);
              refreshAll();
            }}
          />
        ) : <ChatPanel
          key={selectedConversationId ? `${selectedConversationId}:${detail?.conversation.id === selectedConversationId ? "ready" : "loading"}` : `draft:${draftRequestId}`}
          detail={detail}
          node={selectedNode}
          pendingApprovals={pendingApprovals}
          onRefresh={refreshAll}
          onBack={() => setMobilePane("conversations")}
          draftRequestId={draftRequestId}
          isDraft={selectedConversationId === null}
          onConversationStarted={conversationStarted}
          settings={settings}
        />}
      </div>
      {overlay === "settings" && <SettingsPanel settings={settings} nodes={nodes} selectedNodeId={selectedNodeId} onClose={() => setOverlay(null)} onSaved={setSettings} onNodesChanged={refreshNodes} onLogout={onLogout} />}
      {overlay === "switcher" && <QuickSwitcher
        nodes={nodes}
        conversations={quickConversations}
        loading={quickLoading}
        error={quickError}
        onClose={() => setOverlay(null)}
        onSearch={searchQuickConversations}
        onNode={(node) => {
          if (selectedNodeIdRef.current === node.id) beginNewConversation();
          else selectNode(node);
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
  return <AuthenticatedApp onLogout={async () => {
    await logoutAdmin();
    setState("anonymous");
  }} />;
}
