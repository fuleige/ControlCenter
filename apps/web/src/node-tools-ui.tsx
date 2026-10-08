import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { NodeFileTaskView, NodeFileTransport } from '@controller-center/protocol';

const iconPaths = {
  terminal: ['m5 7 5 5-5 5', 'M13 17h6'],
  folder: ['M3 7V5h6l2 2h10v13H3Z'],
  file: ['M6 3h8l4 4v14H6Z', 'M14 3v5h4', 'M9 12h6M9 16h6'],
  upload: ['M12 16V3m-5 5 5-5 5 5', 'M4 16v5h16v-5'],
  download: ['M12 3v13m-5-5 5 5 5-5', 'M4 16v5h16v-5'],
  up: ['m6 12 6-6 6 6', 'M12 6v14'],
  refresh: ['M20 7v5h-5', 'M20 12a8 8 0 1 0-2 6'],
  arrow: ['M4 12h16m-6-6 6 6-6 6'],
  close: ['m6 6 12 12M6 18 18 6'],
  expand: ['M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5'],
  collapse: ['M3 8h5V3M21 8h-5V3M16 21v-5h5M8 21v-5H3'],
  info: ['M12 11v6', 'M12 7h.01'],
  check: ['m5 12 4 4L19 6'],
  back: ['M20 12H4m6-6-6 6 6 6'],
} as const;
export function ToolIcon({ name, className = '' }: { name: keyof typeof iconPaths; className?: string }) {
  return <svg className={`node-tool-icon ${className}`} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'info' && <circle cx="12" cy="12" r="9" />}{iconPaths[name].map((d) => <path d={d} key={d} />)}
  </svg>;
}
export function sizeText(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KiB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MiB`;
  return `${(size / 1024 ** 3).toFixed(2)} GiB`;
}
export function progressBytes(task: NodeFileTaskView): number {
  if (task.transport === 'direct') return task.agentOffset;
  return task.direction === 'upload' && (task.phase === 'node-upload' || task.phase === 'committing') ? task.agentOffset : task.offset;
}
export interface TransferRow {
  key: string; name: string; direction: 'upload' | 'download'; size: number; controller: AbortController;
  message: string; error: string; requested: boolean; task?: NodeFileTaskView;
  transport?: NodeFileTransport; directFailure?: boolean; retrying?: boolean;
  queuedAt: number; startedAt?: number; finishedAt?: number; progressAt?: number; speed?: number;
  measurement?: { at: number; offset: number; phase: NodeFileTaskView['phase'] };
}
const ended = new Set(['completed', 'failed', 'cancelled']);
export const transferFinished = (row: TransferRow) => !row.retrying && Boolean(row.error || row.message === '已取消' || ended.has(row.task?.status || ''));

export function FileConfirmDialog({ title, onCancel, children, actions }: {
  title: string; onCancel: () => void; children: ReactNode; actions: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null); const titleId = useId();
  useEffect(() => { const element = dialog.current; element?.showModal(); element?.querySelector<HTMLButtonElement>('footer button')?.focus(); return () => element?.close(); }, []);
  return <dialog className="node-file-confirm-dialog" ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onCancel(); }}>
    <header><h2 id={titleId}>{title}</h2><button type="button" className="node-tool-button node-tool-button-ghost node-tool-button-icon" aria-label="关闭确认窗口" onClick={onCancel}><ToolIcon name="close" /></button></header>
    <div className="node-file-confirm-content">{children}</div><footer>{actions}</footer>
  </dialog>;
}
const phaseLabels: Record<NodeFileTaskView['phase'], string> = {
  'browser-upload': '电脑 → 服务器', 'node-upload': '服务器 → 节点', 'node-download': '节点 → 服务器',
  verifying: '文件校验', committing: '节点文件提交', ready: '服务器准备完成', completed: '节点写入完成',
};
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function CopyTaskId({ id }: { id: string }) {
  const [message, setMessage] = useState('复制编号');
  return <button type="button" className="node-tool-text-button" onClick={() => {
    if (!navigator.clipboard) { setMessage('请选中编号复制'); return; }
    void navigator.clipboard.writeText(id).then(() => setMessage('已复制')).catch(() => setMessage('请选中编号复制'));
  }}>{message}</button>;
}
export function TransferPanel({ rows, onCancel, onDownload, onRetry, onClearFinished }: {
  rows: TransferRow[]; onCancel: (row: TransferRow) => void; onDownload: (key: string, id: string) => void;
  onRetry?: (row: TransferRow, transport: NodeFileTransport) => void;
  onClearFinished?: () => void;
}) {
  const active = rows.filter((row) => row.retrying || (!row.error && row.message !== '已取消' && !ended.has(row.task?.status || '') && (row.task?.status !== 'ready' || row.task.transport === 'direct')));
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active.length]);
  return <aside className="node-file-transfer-panel" aria-label="传输面板">
    <header className="node-panel-heading"><div><h2>传输</h2><span>{active.length ? `${active.length} 项待完成` : rows.length ? `${rows.length} 项记录` : '本页任务'}</span></div>
      <div className="node-transfer-header-actions">{active.length > 0 && <span className="node-transfer-live-dot" aria-hidden="true" />}{onClearFinished && rows.some(transferFinished) && <button type="button" className="node-tool-text-button" onClick={onClearFinished}>清理已结束</button>}</div></header>
    <div className="node-file-transfers-list">
      {!rows.length ? <div className="node-transfers-empty"><span><ToolIcon name="upload" /></span><strong>还没有传输任务</strong><p>上传文件，或选择节点文件后下载。</p><small>进度和结果会显示在这里</small></div> : rows.map((row) => {
        const task = row.task; const size = task?.size ?? row.size;
        const bytes = task ? progressBytes(task) : 0;
        const finished = row.finishedAt || now;
        const percent = size ? Math.min(100, Math.floor(bytes / size * 100)) : task && (task.status === 'ready' || task.status === 'completed') ? 100 : 0;
        const failed = Boolean(row.error || task?.status === 'failed');
        const cancelled = row.message === '已取消' || task?.status === 'cancelled';
        const ready = task?.status === 'ready'; const localPending = ready && task.transport === 'direct'; const completed = task?.status === 'completed';
        const queued = !row.startedAt && !failed && !cancelled;
        const badge = row.retrying ? '重新准备中' : failed ? '失败' : cancelled ? '已取消' : completed ? '已完成' : localPending ? '保存中' : ready ? row.requested ? '浏览器下载' : '等待保存' : queued ? '排队中' : task?.phase === 'verifying' ? '校验中' : row.direction === 'download' ? task?.transport === 'direct' ? '下载中' : '准备中' : '上传中';
        const waiting = !failed && !cancelled && !ready && !completed && row.startedAt && now - (row.progressAt || row.startedAt) > 15_000;
        return <article className="node-transfer-card" key={row.key} data-state={failed ? 'failed' : cancelled ? 'cancelled' : (ready && !localPending) || completed ? 'done' : 'active'}>
          <div className="node-transfer-title"><span className="node-transfer-direction"><ToolIcon name={row.direction} /></span><strong title={row.name}>{row.name}</strong><span className="node-transfer-badge">{badge}</span></div>
          <div className="node-transfer-meta"><span>{row.direction === 'upload' ? '上传' : '下载'}{row.transport ? ` · ${row.transport === 'direct' ? '直连' : '中转'}` : ''}</span><span>{sizeText(size)}</span></div>
          <p className="node-transfer-message" role="status">{row.message}</p>
          <progress aria-label={`${row.name} ${row.direction === 'download' ? '准备' : '上传'}进度`} max={100} value={task ? percent : failed || cancelled || queued ? 0 : undefined} />
          <div className="node-transfer-numbers"><span>{sizeText(bytes)} / {sizeText(size)}</span><span>{task ? `${percent}%` : cancelled ? '已取消' : failed ? '失败' : queued ? '尚未开始' : '等待进度'}</span></div>
          {row.startedAt && <p className="node-transfer-timing">{ready ? '准备耗时' : '已用时'} {elapsed(finished - row.startedAt)}{row.speed && size > 1024 ** 2 && task?.status === 'transferring' ? ` · ${sizeText(row.speed)}/秒` : ''}</p>}
          {waiting && <p className="node-transfer-waiting">仍在等待新的进度，已等待 {elapsed(now - (row.progressAt || row.startedAt!))}。可以查看详情或取消。</p>}
          {row.error && <p role="alert" className="node-tools-error">{row.error}</p>}
          {task && <details className="node-transfer-details"><summary>任务详情</summary><dl><dt>传输方式</dt><dd>{task.transport === 'direct' ? '直连' : '中转'}</dd><dt>节点路径</dt><dd>{task.path}</dd><dt>任务编号</dt><dd><code>{task.id}</code><CopyTaskId id={task.id} /></dd><dt>当前阶段</dt><dd>{task.transport === 'direct' && task.phase === 'node-download' ? '节点 → 电脑' : task.transport === 'direct' && task.phase === 'node-upload' ? '电脑 → 节点' : localPending ? '等待本地保存提交' : completed && row.direction === 'download' ? '本地保存完成' : phaseLabels[task.phase]}</dd><dt>{task.transport === 'direct' ? '接收端确认' : '服务器确认'}</dt><dd>{sizeText(task.offset)} / {sizeText(task.size)}</dd></dl></details>}
          <div className="node-transfer-actions">
            {row.directFailure && onRetry && <><button type="button" className="node-tool-button" onClick={() => onRetry(row, 'direct')}>重试直连</button><button type="button" className="node-tool-button" onClick={() => onRetry(row, 'relay')}>改用中转</button><button type="button" className="node-tool-text-button" onClick={() => onCancel(row)}>取消</button></>}
            {ready && task.transport !== 'direct' && <button type="button" className="node-tool-button node-tool-button-primary" onClick={() => onDownload(row.key, task.id)}><ToolIcon name="download" />{row.requested ? '再次下载' : '保存到电脑'}</button>}
            {!ended.has(task?.status || '') && !row.error && !cancelled && <button type="button" className="node-tool-text-button" onClick={() => onCancel(row)}>{ready ? '取消下载' : '取消'}</button>}
          </div>
        </article>;
      })}
    </div>
    <footer className="node-transfer-footer"><span>传输期间请保持本页打开</span><details><summary>传输说明</summary><p>关闭或刷新本页会结束未完成任务。直连下载进度显示在本页；中转下载的保存进度在浏览器下载列表查看。直连失败需确认后才能改用中转，并从头传输。</p></details></footer>
  </aside>;
}
