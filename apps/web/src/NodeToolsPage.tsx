import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Terminal as XtermTerminal } from '@xterm/xterm';
import { NODE_FILE_CHUNK_BYTES, NODE_FILE_MAX_BYTES, DirectConnectionError, type NodeDirectory, type NodeFileTaskView, type NodeUploadTarget, type NodeToolEvent, type NodeFileTransport } from '@controller-center/protocol';
import { API_URL, api, formatErrorMessage } from './api';
import { createFilePage, FilePageApi, socketUrl, toolInfo, retryable, delay } from './node-tools-api';
import { ToolIcon, TransferPanel, FileConfirmDialog, transferFinished, progressBytes, sizeText, type TransferRow } from './node-tools-ui';
import './node-tools.css';
import { BrowserDirectFiles, canSaveDirect, filePickers, localIdentity, saveRelayFile, type LocalFileHandle, type LocalDirectoryHandle, type LocalWritable } from './direct-files';
import type { DirectDiagnosticReport } from './direct-diagnostics';
import { DirectDiagnosticsPanel } from './DirectDiagnosticsPanel';
import { FileTransferAction, type DirectAvailability } from './FileTransferAction';

export default function NodeToolsPage({ nodeId, mode }: { nodeId: string; mode: 'terminal' | 'files' }) {
  const [name, setName] = useState(nodeId); const [error, setError] = useState(''); const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([toolInfo(nodeId), api<{ data: Array<{ id: string; name: string }> }>('/api/nodes')]).then(([info, nodes]) => {
      if (!active) return;
      setName(nodes.data.find((node) => node.id === nodeId)?.name || nodeId);
      if (!info.online) setError('节点当前离线，请在节点上线后重新打开');
      else if (!info[mode === 'terminal' ? 'terminal' : 'files']) setError('需升级 Agent 才能使用此功能');
      else setReady(true);
    }).catch((reason) => { if (active) setError(formatErrorMessage(reason, '读取节点')); });
    return () => { active = false; };
  }, [nodeId, mode]);
  return <main className={`node-tools-page ${mode === 'terminal' ? 'terminal-page' : 'files-page'}`}>
    {error ? <section className="node-tools-route-message"><ToolIcon name={mode === 'terminal' ? 'terminal' : 'folder'} /><h1>{name} · {mode === 'terminal' ? '终端' : '节点文件'}</h1><p role="alert" className="node-tools-error">{error}</p><div><button type="button" className="node-tool-button" onClick={() => window.location.assign('/')}><ToolIcon name="back" />返回控制中心</button><button type="button" className="node-tool-button node-tool-button-primary" onClick={() => window.location.reload()}>重新打开</button></div></section>
      : !ready ? <section className="node-tools-route-message"><p role="status">正在连接节点…</p></section> : mode === 'terminal' ? <TerminalPage nodeId={nodeId} name={name} /> : <FilesPage nodeId={nodeId} name={name} />}
  </main>;
}
function TerminalPage({ nodeId, name }: { nodeId: string; name: string }) {
  const container = useRef<HTMLDivElement>(null); const connection = useRef<WebSocket | null>(null);
  const terminalInstance = useRef<XtermTerminal | null>(null); const terminalEnded = useRef(false);
  const [status, setStatus] = useState('正在启动终端…'); const [user, setUser] = useState(''); const [cwd, setCwd] = useState(''); const [ended, setEnded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false); const [screenError, setScreenError] = useState('');
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement?.classList.contains('terminal-page') || false);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  async function toggleFullscreen() {
    setScreenError('');
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await container.current?.closest<HTMLElement>('.terminal-page')?.requestFullscreen();
    } catch { setScreenError('无法进入全屏，请检查浏览器权限'); }
  }
  function closeTerminal() {
    if (connection.current?.readyState === WebSocket.OPEN) connection.current.send(JSON.stringify({ action: 'close' }));
    connection.current?.close(); finishTerminal('终端已关闭');
  }
  function finishTerminal(reason: string | ((current: string) => string)) {
    terminalEnded.current = true; setEnded(true); setStatus(reason);
    const terminal = terminalInstance.current;
    if (terminal) {
      terminal.options.disableStdin = true; terminal.options.cursorBlink = false; terminal.options.cursorInactiveStyle = 'none';
      // Hide the cursor after pending output is consumed, including after clicking the read-only screen.
      terminal.write('\x1b[?25l');
      terminal.blur();
    }
  }
  useEffect(() => {
    let active = true; let dispose: (() => void) | null = null;
    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')]).then(([{ Terminal }, { FitAddon }]) => {
      if (!active || terminalEnded.current || !container.current) return;
      const terminal = new Terminal({ cursorBlink: true, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 14, scrollback: 3000,
        theme: { background: '#101318', foreground: '#e6edf3' } });
      const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(container.current); fit.fit(); terminal.focus();
      terminalInstance.current = terminal;
      const socket = new WebSocket(socketUrl(`/api/node-tools/nodes/${encodeURIComponent(nodeId)}/terminal`)); connection.current = socket;
      let opened = false;
      const send = (value: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
      socket.onopen = () => send({ action: 'open', cols: terminal.cols, rows: terminal.rows });
      socket.onmessage = (message) => {
        if (!active || terminalEnded.current) return;
        try {
          const event = JSON.parse(message.data) as NodeToolEvent;
          if (event.action === 'terminal.opened') { opened = true; setUser(event.user); setCwd(event.cwd); setStatus('已连接'); }
          else if (event.action === 'terminal.output') terminal.write(event.data, () => { if (active) send({ action: 'ack', bytes: event.bytes }); });
          else if (event.action === 'terminal.exit') { opened = false; finishTerminal(event.reason); }
          else if (event.action === 'terminal.error') { opened = false; finishTerminal(event.error); }
        } catch { setStatus('终端消息无效，连接已结束'); socket.close(); }
      };
      socket.onclose = () => {
        opened = false;
        if (active && !terminalEnded.current) finishTerminal((current) => current === '已连接' || current === '正在启动终端…' ? '终端连接已结束，无法重新接回' : current);
      };
      socket.onerror = () => { if (active) setStatus('无法建立终端连接，请检查节点状态、登录状态及网络'); };
      const input = terminal.onData((data) => {
        if (!opened || terminalEnded.current) return;
        // Split large pastes without splitting a Unicode code point.
        for (let index = 0; index < data.length;) {
          let end = Math.min(index + 8192, data.length);
          if (end < data.length && /[\uD800-\uDBFF]/u.test(data[end - 1]!)) end--;
          send({ action: 'input', data: data.slice(index, end) }); index = end;
        }
      });
      const resize = new ResizeObserver(() => { try { fit.fit(); if (opened && !terminalEnded.current) send({ action: 'resize', cols: terminal.cols, rows: terminal.rows }); } catch { /* disposed */ } });
      resize.observe(container.current);
      const close = () => { send({ action: 'close' }); socket.close(); };
      window.addEventListener('pagehide', close);
      dispose = () => { window.removeEventListener('pagehide', close); close(); resize.disconnect(); input.dispose(); terminal.dispose(); terminalInstance.current = null; connection.current = null; };
    }).catch((reason) => { if (active) finishTerminal(formatErrorMessage(reason, '加载终端')); });
    return () => { active = false; dispose?.(); };
  }, [nodeId]);
  return <><header className="node-terminal-toolbar">
    <div className="node-terminal-identity"><ToolIcon name="terminal" /><h1 title={name}>{name}</h1>{user && <span className="node-terminal-user" title="Agent 系统用户">{user}</span>}</div>
    <span role="status" title={status} data-state={ended ? 'ended' : status === '已连接' ? 'online' : 'connecting'} className={`node-tool-connection ${ended ? 'node-tool-ended' : ''}`}><i aria-hidden="true" />{status}</span>
    <div className="node-terminal-controls">
      <details className="node-tool-info"><summary aria-label="终端信息" title="启动目录与使用说明"><ToolIcon name="info" /></summary><div className="node-tool-info-popover"><strong>终端信息</strong><dl><dt>系统用户</dt><dd>{user || '等待节点确认'}</dd><dt>启动目录</dt><dd>{cwd || '等待节点确认'}</dd></dl><p>关闭、刷新或断线后终端结束，无法接回；请先保存编辑内容。终端使用上述系统用户的正常 Shell 权限。</p></div></details>
      <button type="button" className="node-tool-button node-tool-button-ghost" aria-label={fullscreen ? '退出全屏' : '全屏'} onClick={() => void toggleFullscreen()}><ToolIcon name={fullscreen ? 'collapse' : 'expand'} /><span>{fullscreen ? '退出全屏' : '全屏'}</span></button>
      {ended ? <button type="button" className="node-tool-button" onClick={() => window.location.reload()}><ToolIcon name="terminal" />新开终端</button> : <button type="button" className="node-tool-button node-tool-button-ghost node-tool-button-danger" aria-label="关闭终端" onClick={closeTerminal}><ToolIcon name="close" /><span>关闭</span></button>}
    </div>
  </header>{screenError && <p className="node-terminal-toast" role="alert">{screenError}</p>}
    <div className={`node-terminal ${ended ? 'node-terminal-ended' : ''}`} aria-label={ended ? '终端输出（已结束，只读）' : '交互终端'} ref={container} />
    {ended && <div className="node-terminal-ended-notice">终端已结束 · 已显示的输出保留，可选中复制。点击“新开终端”开始新的 Shell。</div>}</>;
}
type Row = TransferRow;
const taskError = (task: NodeFileTaskView, message: string) => task.errorKind === 'connection' ? new DirectConnectionError(task.error || message) : new Error(task.error || message);
interface UploadBatch { files: File[]; planId: string; targets: NodeUploadTarget[]; transport: NodeFileTransport }
interface DownloadItem { path: string; name: string; size: number; handle?: LocalFileHandle; identity?: string }
interface DownloadBatch { items: DownloadItem[]; directory: LocalDirectoryHandle; existing: Map<string, string> }
const doneStates = new Set(['completed', 'failed', 'cancelled']);
const phaseText: Record<NodeFileTaskView['phase'], string> = { 'browser-upload': '正在上传到服务器', 'node-upload': '正在写入节点', 'node-download': '正在准备下载', verifying: '正在校验文件', committing: '正在提交节点文件', ready: '准备完成', completed: '已上传到节点' };
function FilesPage({ nodeId, name }: { nodeId: string; name: string }) {
  const [client, setClient] = useState<FilePageApi | null>(null); const [connectionStatus, setConnectionStatus] = useState('正在建立文件页面…');
  const [directory, setDirectory] = useState<NodeDirectory | null>(null); const [pathInput, setPathInput] = useState(''); const [loading, setLoading] = useState(false);
  const currentDirectory = useRef<NodeDirectory | null>(null); const refreshTimer = useRef<number | null>(null);
  const [error, setError] = useState(''); const [rows, setRows] = useState<Row[]>([]); const rowsRef = useRef<Row[]>([]);
  const [batch, setBatch] = useState<UploadBatch | null>(null); const [busy, setBusy] = useState(false); const [selected, setSelected] = useState<Set<string>>(new Set());
  const direct = useRef<BrowserDirectFiles | null>(null); const [directReady, setDirectReady] = useState(false); const [directStatus, setDirectStatus] = useState('正在检查节点直连能力…');
  const [directReport, setDirectReport] = useState<DirectDiagnosticReport | null>(null);
  const [directSupported, setDirectSupported] = useState<boolean | 'failed' | null>(null);
  const [uploadMode, setUploadMode] = useState<NodeFileTransport>('relay'); const [downloadMode, setDownloadMode] = useState<NodeFileTransport>('relay');
  const manualMode = useRef({ upload: false, download: false });
  const uploadChoice = useRef<NodeFileTransport>('relay');
  const retries = useRef(new Map<string, (transport: NodeFileTransport) => Promise<void>>());
  const retrying = useRef(new Set<string>());
  const [fallback, setFallback] = useState<Row | null>(null); const [downloadBatch, setDownloadBatch] = useState<DownloadBatch | null>(null);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const alive = useRef(true); const listRevision = useRef(0); const queue = useRef(Promise.resolve()); const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { currentDirectory.current = directory; }, [directory]);
  const update = useCallback((key: string, changes: Partial<Row>) => {
    rowsRef.current = rowsRef.current.map((row) => {
      if (row.key !== key) return row;
      const next = { ...row, ...changes }; const now = Date.now();
      if (changes.task) {
        const offset = progressBytes(changes.task); const previous = row.measurement;
        if (!previous || previous.phase !== changes.task.phase || offset < previous.offset) {
          next.measurement = { at: now, offset, phase: changes.task.phase }; next.speed = undefined; next.progressAt = now;
        } else if (offset > previous.offset) {
          next.speed = (offset - previous.offset) / Math.max(0.001, (now - previous.at) / 1000);
          next.measurement = { at: now, offset, phase: changes.task.phase }; next.progressAt = now;
        }
        if (doneStates.has(changes.task.status) || changes.task.status === 'ready') next.finishedAt ??= now;
      }
      if (changes.error || changes.message === '已取消') next.finishedAt ??= now;
      return next;
    });
    if (alive.current) setRows(rowsRef.current);
  }, []);
  useEffect(() => {
    alive.current = true; let active = true; let apiClient: FilePageApi | null = null; let socket: WebSocket | null = null; let reconnect: number | null = null; let attempts = 0;
    const stop = () => {
      active = false; alive.current = false;
      if (reconnect !== null) window.clearTimeout(reconnect);
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      rowsRef.current.forEach((row) => row.controller.abort());
      direct.current?.close(false); direct.current = null;
      if (socket?.readyState === WebSocket.OPEN) socket.send('{"action":"close"}'); socket?.close();
      void apiClient?.close().catch(() => undefined);
    };
    const connect = () => {
      if (!active || !apiClient) return;
      socket = new WebSocket(socketUrl(`/api/node-tools/nodes/${encodeURIComponent(nodeId)}/pages/${apiClient.id}/connect`));
      socket.onopen = () => { if (active) { attempts = 0; setConnectionStatus('已连接'); setClient(apiClient); } };
      socket.onmessage = ({ data }) => { try { direct.current?.receive(JSON.parse(data as string)); } catch { /* invalid signaling is ignored */ } };
      socket.onclose = () => {
        if (!active) return;
        setConnectionStatus('连接中断，正在尝试续传；超过失联期限后任务结束');
        if (++attempts > 6) { setConnectionStatus('文件页面连接已失效，请重新打开'); setClient(null); return; }
        reconnect = window.setTimeout(connect, Math.min(5000, 500 * 2 ** attempts));
      };
      socket.onerror = () => { /* close drives bounded retries */ };
    };
    void createFilePage(nodeId).then(({ pageId, direct: supported, stunUrls }) => {
      apiClient = new FilePageApi(pageId);
      if (!active) { void apiClient.close().catch(() => undefined); return; }
      setDirectSupported(supported);
      if (supported) direct.current = new BrowserDirectFiles(apiClient, stunUrls, (ready, message, report) => { if (active) { setDirectReady(ready); setDirectStatus(message); setDirectReport(report || null); } });
      else { setDirectReady(false); setDirectStatus('此节点尚不支持直连，可使用中转'); }
      connect();
    }).catch((reason) => { if (active) { setDirectSupported('failed'); setError(formatErrorMessage(reason, '创建文件页面')); } });
    window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); stop(); };
  }, [nodeId]);
  useEffect(() => { if (client && direct.current) void direct.current.probe(); }, [client]);
  useEffect(() => {
    if (!manualMode.current.upload) { const mode = directReady ? 'direct' : 'relay'; setUploadMode(mode); uploadChoice.current = mode; }
    if (!manualMode.current.download) setDownloadMode(directReady && canSaveDirect(selected.size > 1) ? 'direct' : 'relay');
  }, [directReady, selected.size]);
  const browse = useCallback(async (target: string, cursor = 0, preserveSelection = false) => {
    if (!client) return;
    const revision = ++listRevision.current; setLoading(true); setError('');
    try {
      const previousDirectory = currentDirectory.current;
      let result = await client.list(target, cursor);
      while (preserveSelection && !cursor && previousDirectory?.path === result.directory.path && result.directory.entries.length < previousDirectory.entries.length && result.directory.nextCursor !== null) {
        if (!alive.current || revision !== listRevision.current) return;
        const nextCursor = result.directory.nextCursor;
        const next = await client.list(target, nextCursor);
        if (next.directory.nextCursor !== null && next.directory.nextCursor <= nextCursor) throw new Error('目录分页位置无效，请重新读取目录');
        result = { directory: { ...next.directory, entries: [...result.directory.entries, ...next.directory.entries] } };
        if (!next.directory.entries.length) break;
      }
      if (!alive.current || revision !== listRevision.current) return;
      setDirectory((old) => cursor && old?.path === result.directory.path ? { ...result.directory, entries: [...old.entries, ...result.directory.entries] } : result.directory);
      if (!preserveSelection) setPathInput(result.directory.path);
      if (!cursor) setSelected(old => preserveSelection ? new Set(result.directory.entries.filter(entry => old.has(entry.path)).map(entry => entry.path)) : new Set());
    } catch (reason) { if (alive.current && revision === listRevision.current) setError(formatErrorMessage(reason, '浏览目录')); }
    finally { if (alive.current && revision === listRevision.current) setLoading(false); }
  }, [client]);
  useEffect(() => { if (client) void browse(''); }, [client, browse]);
  function scheduleDirectoryRefresh(target: string) {
    if (currentDirectory.current?.path !== target) return;
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      if (alive.current && currentDirectory.current?.path === target) void browse(target, 0, true);
    }, 150);
  }
  function toggleSelected(filePath: string) {
    setSelected(old => { const next = new Set(old); next.has(filePath) ? next.delete(filePath) : next.add(filePath); return next; });
  }
  function clearFinishedTransfers() {
    const remaining = rowsRef.current.filter(row => {
      if (!transferFinished(row)) return true;
      retries.current.delete(row.key); return false;
    });
    rowsRef.current = remaining; setRows(remaining);
  }
  function returnToControlCenter() {
    if (rowsRef.current.some(row => !transferFinished(row))) setLeaveConfirm(true);
    else window.location.assign('/');
  }
  async function retry<T>(operation: () => Promise<T>, row: Row): Promise<T> {
    for (let attempt = 0;; attempt++) {
      row.controller.signal.throwIfAborted();
      try { return await operation(); } catch (reason) {
        if (!alive.current || row.controller.signal.aborted || !retryable(reason) || attempt >= 5) throw reason;
        update(row.key, { message: '连接中断，正在尝试续传' }); await delay(Math.min(5000, 500 * 2 ** attempt), row.controller.signal);
      }
    }
  }
  function addRow(name: string, direction: Row['direction'], size: number): Row {
    const row: Row = { key: crypto.randomUUID(), name, direction, size, queuedAt: Date.now(), controller: new AbortController(), message: '排队中', error: '', requested: false };
    rowsRef.current = [...rowsRef.current, row]; setRows(rowsRef.current); return row;
  }
  async function waitForTask(apiClient: FilePageApi, row: Row, id: string): Promise<NodeFileTaskView> {
    while (true) {
      const { task } = await retry(() => apiClient.task(id, row.controller.signal), row); update(row.key, { task, message: phaseText[task.phase] });
      if (doneStates.has(task.status) || task.status === 'ready') return task;
      await delay(1000, row.controller.signal);
    }
  }
  function enqueue(row: Row, operation: () => Promise<void>) {
    queue.current = queue.current.catch(() => undefined).then(async () => {
      try { row.controller.signal.throwIfAborted(); update(row.key, { startedAt: Date.now(), message: row.direction === 'download' ? '正在请求节点准备文件' : '正在创建上传任务' }); await operation(); }
      catch (reason) {
        const current = rowsRef.current.find((entry) => entry.key === row.key);
        if (current?.task && client) void client.cancel(current.task.id).catch(() => undefined);
        update(row.key, { message: row.controller.signal.aborted ? '已取消' : '失败', directFailure: !row.controller.signal.aborted && row.transport === 'direct' && reason instanceof DirectConnectionError, error: row.controller.signal.aborted ? '' : formatErrorMessage(reason, row.direction === 'upload' ? '上传' : '下载') });
      }
    });
  }
  function startUploads(plan: UploadBatch, overwrite: boolean) {
    if (!client) return;
    const apiClient = client; setBatch(null);
    plan.files.forEach((file, index) => {
      const row = addRow(file.name, 'upload', file.size);
      row.transport = plan.transport; update(row.key, { transport: plan.transport });
      retries.current.set(row.key, async (transport) => { await chooseUploads([file], transport, plan.targets[index]!.path.slice(0, plan.targets[index]!.path.lastIndexOf('/')) || '/'); });
      enqueue(row, async () => {
        if (plan.transport === 'direct' && !direct.current?.available) throw new DirectConnectionError();
        const { task, token } = await retry(() => apiClient.upload(plan.planId, index, overwrite, row.controller.signal, plan.transport), row); update(row.key, { task });
        if (plan.transport === 'direct') {
          await direct.current!.upload(task, token!, file, row.controller.signal, (offset) => update(row.key, { task: { ...task, offset, agentOffset: offset }, message: '正在直连上传到节点' }));
          const result = await waitForTask(apiClient, row, task.id);
          if (result.status !== 'completed') throw taskError(result, '节点文件未成功写入');
          update(row.key, { message: '已上传到节点' });
          scheduleDirectoryRefresh(plan.targets[index]!.path.slice(0, plan.targets[index]!.path.lastIndexOf('/')) || '/'); return;
        }
        const hash = sha256.create();
        for (let offset = 0; offset < file.size; offset += NODE_FILE_CHUNK_BYTES) {
          row.controller.signal.throwIfAborted();
          const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + NODE_FILE_CHUNK_BYTES)).arrayBuffer());
          hash.update(bytes); const chunkHash = bytesToHex(sha256(bytes));
          await retry(async () => {
            const current = (await apiClient.task(task.id, row.controller.signal)).task;
            if (doneStates.has(current.status)) throw new Error(current.error || '文件任务已结束');
            if (current.offset === offset + bytes.length) { update(row.key, { task: current }); return; }
            if (current.offset !== offset) throw new Error('服务器确认位置不一致');
            await apiClient.chunk(task.id, offset, bytes, chunkHash, row.controller.signal);
            update(row.key, { task: { ...current, offset: offset + bytes.length }, message: '正在上传到服务器' });
          }, row);
        }
        const finalHash = bytesToHex(hash.digest());
        await retry(() => apiClient.finalize(task.id, finalHash, row.controller.signal), row);
        const result = await waitForTask(apiClient, row, task.id);
        if (result.status !== 'completed') throw new Error(result.error || '节点文件未成功写入');
        update(row.key, { message: '已上传到节点' });
        scheduleDirectoryRefresh(plan.targets[index]!.path.slice(0, plan.targets[index]!.path.lastIndexOf('/')) || '/');
      });
    });
  }
  async function chooseUploads(files: File[], transport = uploadChoice.current, targetDirectory = directory?.path) {
    if (!client || !directory || !files.length) return;
    if (rowsRef.current.length + files.length > 200 || files.length > 100) { setError('每批最多 100 个文件，当前页面最多 200 项记录；清理已结束的传输记录后可继续'); return; }
    const accepted: File[] = [];
    files.forEach((file) => {
      if (file.size > NODE_FILE_MAX_BYTES) { const row = addRow(file.name, 'upload', file.size); update(row.key, { message: '失败', error: '文件超过单文件大小限制（最大 1 GiB）' }); }
      else accepted.push(file);
    });
    if (!accepted.length) return;
    setBusy(true); setError('');
    try {
      const plan = await client.preflight(targetDirectory!, accepted);
      if (!alive.current) return;
      const next = { files: accepted, ...plan, transport };
      if (plan.targets.some((target) => target.existing)) setBatch(next); else startUploads(next, false);
    } catch (reason) { if (alive.current) setError(formatErrorMessage(reason, '上传预检')); }
    finally { if (alive.current) setBusy(false); }
  }
  async function chooseDownloads(paths: string[]) {
    if (!client || !directory) return;
    if (rowsRef.current.length + paths.length > 200 || paths.length > 100) { setError('每批最多 100 项，当前页面最多 200 项记录；清理已结束的传输记录后可继续'); return; }
    const transport = downloadMode;
    const items = paths.map((filePath) => { const entry = directory.entries.find((item) => item.path === filePath); return { path: filePath, name: entry?.name || filePath, size: entry?.size || 0 }; }).filter((item) => {
      if (item.size <= NODE_FILE_MAX_BYTES) return true;
      const row = addRow(item.name, 'download', item.size); update(row.key, { message: '失败', error: '文件超过单文件大小限制（最大 1 GiB）' }); return false;
    });
    if (!items.length) return;
    if (transport === 'relay') { startDownloads(items, transport); return; }
    if (!direct.current?.available || !canSaveDirect(items.length > 1)) { setError('当前直连或浏览器保存能力不可用，请重新检测或选择中转'); return; }
    try {
      // Invoke the picker directly in the click handler, before any network await.
      if (items.length === 1) {
        const handle = await filePickers().showSaveFilePicker!({ suggestedName: items[0]!.name });
        const identity = localIdentity(await handle.getFile()); startDownloads([{ ...items[0]!, handle, identity }], transport);
      } else {
        const localDirectory = await filePickers().showDirectoryPicker!({ mode: 'readwrite' });
        const existing = new Map<string, string>(); const names = new Set<string>();
        for (const item of items) {
          if (names.has(item.name)) throw new Error('同一批次不能保存重名文件'); names.add(item.name);
          try { const handle = await localDirectory.getFileHandle(item.name); existing.set(item.name, localIdentity(await handle.getFile())); }
          catch (reason) { if (!(reason instanceof DOMException && reason.name === 'NotFoundError')) throw reason; }
        }
        const next = { items, directory: localDirectory, existing };
        if (existing.size) setDownloadBatch(next); else startDirectoryDownloads(next);
      }
    } catch (reason) { if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(formatErrorMessage(reason, '选择保存位置')); }
  }
  function startDirectoryDownloads(plan: DownloadBatch) {
    setDownloadBatch(null);
    startDownloads(plan.items, 'direct', plan);
  }
  function startDownloads(items: DownloadItem[], transport: NodeFileTransport, localPlan?: DownloadBatch) {
    if (!client) return;
    const apiClient = client;
    items.forEach((original) => {
      const item = { ...original }; const row = addRow(item.name, 'download', item.size);
      row.transport = transport; update(row.key, { transport });
      retries.current.set(row.key, async (mode) => { startDownloads([item], mode, item.handle ? undefined : localPlan); });
      enqueue(row, async () => {
        if (transport === 'direct' && !direct.current?.available) throw new DirectConnectionError();
        if (localPlan) {
          let existing: LocalFileHandle | undefined;
          try { existing = await localPlan.directory.getFileHandle(item.name); }
          catch (reason) { if (!(reason instanceof DOMException && reason.name === 'NotFoundError')) throw reason; }
          const expected = localPlan.existing.get(item.name);
          if (existing ? expected !== localIdentity(await existing.getFile()) : expected !== undefined) throw new Error('本地目标文件在确认后已变化，请重新选择保存位置');
          item.handle = existing || await localPlan.directory.getFileHandle(item.name, { create: true });
          item.identity = localIdentity(await item.handle.getFile());
        }
        let stream: LocalWritable | null = null;
        let committed = false;
        const work = new AbortController(); const abort = () => work.abort(row.controller.signal.reason); row.controller.signal.addEventListener('abort', abort, { once: true });
        const workRow = { ...row, controller: work };
        try {
          if (item.handle) {
            if (item.identity !== localIdentity(await item.handle.getFile())) throw new Error('本地目标文件在确认后已变化，请重新选择保存位置');
            stream = await item.handle.createWritable({ keepExistingData: false });
          }
          const { task, token } = await retry(() => apiClient.download(item.path, row.key, work.signal, transport), workRow); update(row.key, { task });
          let result: NodeFileTaskView; let checksum: string;
          if (transport === 'direct') {
            if (!stream) throw new Error('尚未授权保存位置');
            const received = direct.current!.downloadTo(task, token!, stream, work.signal, (offset) => update(row.key, { task: { ...task, offset, agentOffset: offset }, message: '正在直连下载到电脑' }));
            [checksum, result] = await Promise.all([received, waitForTask(apiClient, workRow, task.id).then((current) => { if (current.status !== 'ready') throw taskError(current, '节点最终校验失败'); return current; })]);
            if (result.sha256 !== checksum) throw new Error('节点最终校验结果不一致');
          } else {
            result = await waitForTask(apiClient, workRow, task.id);
            if (result.status !== 'ready') throw new Error(result.error || '下载准备失败');
            if (!stream) { requestDownload(row.key, result.id); return; }
            checksum = await saveRelayFile(apiClient, result, stream, work.signal, (offset) => update(row.key, { task: { ...result, status: 'transferring', phase: 'node-download', offset }, message: '正在通过中转保存到所选位置' }));
          }
          work.signal.throwIfAborted();
          const current = (await apiClient.task(result.id, work.signal)).task;
          if (current.status !== 'ready' || current.sha256 !== checksum) throw new Error(current.error || '下载授权已失效');
          update(row.key, { message: '正在完成本地保存' });
          await stream!.close(); committed = true;
          try { item.identity = localIdentity(await item.handle!.getFile()); } catch { /* close has already committed the file */ }
          // Once close commits the user's file, a lost status reply must not offer a duplicate transfer.
          if (transport === 'direct') { try { result = (await apiClient.saved(result.id, checksum, work.signal)).task; } catch { result = { ...result, status: 'completed', phase: 'completed' }; } }
          update(row.key, { task: { ...result, status: 'completed', phase: 'completed' }, message: '已保存到电脑', finishedAt: Date.now() });
        } finally {
          work.abort(); row.controller.signal.removeEventListener('abort', abort);
          if (stream && !committed) await stream.abort().catch(() => undefined);
        }
      });
    });
  }
  async function retryTransfer(row: Row, transport: NodeFileTransport) {
    if (!client || retrying.current.has(row.key)) return;
    retrying.current.add(row.key);
    setFallback(null); update(row.key, { directFailure: false, retrying: true, message: '正在重新准备传输' });
    try {
      if (row.task) {
        let task = (await client.cancel(row.task.id)).task;
        if (!doneStates.has(task.status)) task = await waitForTask(client, { ...row, controller: new AbortController() }, task.id);
        if (task.status === 'completed') { update(row.key, { task, message: '已上传到节点', error: '' }); return; }
        if (task.error?.includes('提交结果不确定')) throw new Error('请先检查节点目标文件，提交结果不确定时不重新上传');
        if (task.transport === 'direct') {
          update(row.key, { message: '正在等待旧直连任务释放文件' }); const deadline = Date.now() + 15_000;
          while (!task.stopped) {
            if (Date.now() >= deadline) throw new DirectConnectionError('旧直连任务尚未停止，请稍后重试');
            await delay(100, row.controller.signal); task = (await client.task(task.id, row.controller.signal)).task;
          }
        }
      }
      if (transport === 'direct' && !direct.current?.available) await direct.current?.probe();
      if (transport === 'direct' && !direct.current?.available) throw new DirectConnectionError('直连仍不可用，可确认改用中转');
      await retries.current.get(row.key)?.(transport);
    } catch (reason) { update(row.key, { error: formatErrorMessage(reason, '重新传输'), directFailure: reason instanceof DirectConnectionError }); }
    finally { retrying.current.delete(row.key); update(row.key, { retrying: false }); }
  }
  function requestDownload(key: string, id: string) {
    const anchor = document.createElement('a'); anchor.href = `${API_URL}/api/node-tools/tasks/${id}/content`; anchor.download = ''; anchor.style.display = 'none';
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    update(key, { requested: true, message: '已请求浏览器下载，请在 Chrome 下载栏查看进度' });
  }
  async function cancelRow(row: Row) {
    row.controller.abort();
    update(row.key, { directFailure: false });
    if (!row.task || !client) { update(row.key, { message: '已取消' }); return; }
    try {
      const { task } = await client.cancel(row.task.id);
      update(row.key, { task, message: task.status === 'completed' ? '已上传到节点' : task.error || '已取消' });
      if (!doneStates.has(task.status)) {
        const current = await waitForTask(client, { ...row, controller: new AbortController() }, task.id);
        update(row.key, { task: current, message: current.status === 'completed' ? '已上传到节点' : current.error || '已取消' });
      }
    } catch (reason) { update(row.key, { error: formatErrorMessage(reason, '取消任务') }); }
  }
  const entries = useMemo(() => [...(directory?.entries || [])].sort((a, b) => {
    const aDirectory = a.type === 'directory' || a.linkType === 'directory';
    const bDirectory = b.type === 'directory' || b.linkType === 'directory';
    return Number(bDirectory) - Number(aDirectory) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
  }), [directory]);
  const selectable = entries.filter(entry => entry.type === 'file' || entry.linkType === 'file');
  const allSelected = selectable.length > 0 && selectable.every(entry => selected.has(entry.path));
  const uploadDirect: DirectAvailability = directReady ? { state: 'available', reason: '浏览器与节点直接传输' }
    : directSupported === false ? { state: 'unavailable', reason: '节点尚不支持直连' }
    : directSupported === 'failed' ? { state: 'unavailable', reason: '文件页面连接失败，请重新打开' }
    : directReport?.outcome === 'failed' ? { state: 'unavailable', reason: '连接失败，查看连接诊断' }
    : directReport?.outcome === 'closed' ? { state: 'unavailable', reason: '连接已断开，请重新检测' }
    : { state: 'checking', reason: '正在检查节点与网络' };
  const downloadDirect: DirectAvailability = canSaveDirect(selected.size > 1) ? uploadDirect
    : { state: 'unavailable', reason: selected.size > 1 && canSaveDirect(false) ? '浏览器不支持选择保存目录' : '浏览器不支持直接保存文件' };
  return <><header className="node-files-header"><div className="node-files-identity"><span className="node-files-app-icon"><ToolIcon name="folder" /></span><div><h1>{name} · 节点文件</h1><p>远程文件管理 <span>·</span> {directory?.user || '正在连接'} <span>·</span> 单文件最大 1 GiB</p></div></div><span role="status" title={connectionStatus} data-state={connectionStatus === '已连接' ? 'online' : 'connecting'} className="node-tool-connection"><i aria-hidden="true" />{connectionStatus}</span>
    <button type="button" className="node-tool-button node-tool-button-ghost" title="返回控制中心" onClick={returnToControlCenter}><ToolIcon name="back" />返回控制中心</button></header>
    <div className="node-files-workspace">
      <section className="node-file-browser" aria-label="节点目录">
        <form className="node-files-path" onSubmit={(event: FormEvent) => { event.preventDefault(); void browse(pathInput); }}>
          <button type="button" className="node-tool-button node-tool-button-icon" aria-label="上级" title="上级目录" disabled={!directory || loading || directory.path === directory.parent} onClick={() => void browse(directory!.parent)}><ToolIcon name="up" /></button>
          <div className="node-files-path-input"><ToolIcon name="folder" /><input aria-label="节点目录路径" value={pathInput} onChange={event => setPathInput(event.target.value)} placeholder="输入节点上的绝对路径" /></div>
          <button className="node-tool-button" disabled={!client || loading}>打开</button><button type="button" className="node-tool-button node-tool-button-icon" aria-label="刷新" title="刷新目录" disabled={!directory || loading} onClick={() => void browse(directory!.path, 0, true)}><ToolIcon name="refresh" /></button>
        </form>
        <header className="node-panel-heading node-files-toolbar"><div><h2>文件</h2><span>{loading ? '正在读取目录…' : selected.size ? `已选择 ${selected.size} 项` : `${directory?.entries.length || 0} 项`}</span></div>
          <div className="node-files-actions">
            <FileTransferAction direction="upload" mode={uploadMode} direct={uploadDirect} busy={busy}
              disabled={!client || !directory || busy || !!batch || (uploadMode === 'direct' && !directReady)}
              hint={uploadMode === 'direct' && !directReady ? '请重新检测直连，或手动选择中转' : `使用${uploadMode === 'direct' ? '直连' : '中转'}上传到当前目录`}
              onModeChange={mode => { manualMode.current.upload = true; uploadChoice.current = mode; setUploadMode(mode); }}
              onExecute={() => fileInput.current?.click()} />
            <FileTransferAction direction="download" mode={downloadMode} direct={downloadDirect} count={selected.size}
              disabled={!client || !selected.size || !!downloadBatch || (downloadMode === 'direct' && downloadDirect.state !== 'available')}
              hint={!selected.size ? '先从下方列表选择文件' : downloadMode === 'direct' && !canSaveDirect(selected.size > 1) ? '浏览器不支持此保存方式，请选择中转' : downloadMode === 'direct' && !directReady ? '请重新检测直连，或手动选择中转' : downloadMode === 'direct' ? '使用直连下载，选择本地保存位置' : '使用中转下载，由浏览器保存'}
              onModeChange={mode => { manualMode.current.download = true; setDownloadMode(mode); }}
              onExecute={() => void chooseDownloads([...selected])} />
          </div>
          <input hidden multiple type="file" ref={fileInput} onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ''; void chooseUploads(files); }} />
        </header>
        {error && <p role="alert" className="node-tools-error node-files-error">{error}</p>}
        <div className="node-files-list" aria-busy={loading}><table><thead><tr><th className="node-file-check"><input type="checkbox" aria-label="全选当前目录文件" title="全选当前目录文件" checked={allSelected} disabled={!selectable.length} ref={element => { if (element) element.indeterminate = selected.size > 0 && !allSelected; }} onChange={event => setSelected(event.target.checked ? new Set(selectable.map(entry => entry.path)) : new Set())} /></th><th>名称</th><th className="node-file-type">类型</th><th className="node-file-size">大小</th><th className="node-file-date">修改时间</th></tr></thead><tbody>
          {entries.map(entry => <tr key={entry.path} aria-selected={selected.has(entry.path)} onClick={event => { if (!(event.target as HTMLElement).closest('button, input') && (entry.type === 'file' || entry.linkType === 'file')) toggleSelected(entry.path); }}><td className="node-file-check">{(entry.type === 'file' || entry.linkType === 'file') && <input type="checkbox" aria-label={`选择 ${entry.name}`} checked={selected.has(entry.path)} onChange={() => toggleSelected(entry.path)} />}</td>
            <td><div className="node-file-name"><ToolIcon name={entry.type === 'directory' || entry.linkType === 'directory' ? 'folder' : 'file'} />{entry.type === 'directory' || entry.linkType === 'directory' ? <button type="button" className="node-tool-text-button" title={entry.path} onClick={() => void browse(entry.path)}>{entry.name}{entry.type === 'symlink' ? ' ↗' : ''}</button> : entry.type === 'file' || entry.linkType === 'file' ? <button type="button" className="node-tool-text-button" title={entry.path} onClick={() => toggleSelected(entry.path)}>{entry.name}{entry.type === 'symlink' ? ' ↗' : ''}</button> : <span title={entry.path}>{entry.name}</span>}</div></td>
            <td className="node-file-type">{entry.type === 'symlink' ? `软链接（${{ file: '文件', directory: '目录', other: '特殊文件', unavailable: '不可访问' }[entry.linkType || 'unavailable']}）` : { directory: '目录', file: '文件', other: '特殊文件' }[entry.type]}</td><td className="node-file-size">{entry.type === 'file' || entry.linkType === 'file' ? sizeText(entry.size) : '—'}</td><td className="node-file-date">{new Date(entry.modifiedAt).toLocaleString()}</td></tr>)}
        </tbody></table>{directory && !directory.entries.length && !loading && <div className="node-directory-empty"><ToolIcon name="folder" /><strong>目录为空</strong><span>点击“上传”添加文件</span></div>}</div>
        <footer className="node-file-browser-footer"><span>{selected.size ? <>{selected.size} 项已选 <button type="button" className="node-tool-text-button" onClick={() => setSelected(new Set())}>取消选择</button></> : '点击文件选择，点击文件夹进入目录'}</span>{directory?.nextCursor !== null && directory?.nextCursor !== undefined && <button type="button" className="node-tool-text-button" disabled={loading} onClick={() => void browse(directory.path, directory.nextCursor!)}>加载更多</button>}</footer>
      </section>
      <div className="node-files-sidebar"><DirectDiagnosticsPanel status={directStatus + (directReady && !canSaveDirect(selected.size > 1) ? '；当前浏览器不支持直连保存，上传仍可直连' : '')} ready={directReady} report={directReport} onProbe={() => void direct.current?.probe()} probeDisabled={!client || !direct.current || rows.some(row => row.transport === 'direct' && !row.error && row.startedAt && !doneStates.has(row.task?.status || '') && row.task?.status !== 'ready')} />
        <TransferPanel rows={rows} onCancel={row => void cancelRow(row)} onDownload={requestDownload} onClearFinished={clearFinishedTransfers} onRetry={(row, transport) => { if (transport === 'relay') setFallback(row); else void retryTransfer(row, transport); }} />
      </div>
    </div>
    {batch && <FileConfirmDialog title="确认整批覆盖" onCancel={() => setBatch(null)} actions={<><button type="button" autoFocus className="node-tool-button" onClick={() => setBatch(null)}>取消整批</button><button type="button" className="node-tool-button node-tool-button-primary" onClick={() => startUploads(batch, true)}>确认覆盖并上传整批</button></>}><p>以下同名文件将被覆盖，其他文件一同上传。传输期间请避免编辑这些目标文件。</p><ul>{batch.targets.filter(target => target.existing).map(target => <li key={target.path}>{target.path}</li>)}</ul></FileConfirmDialog>}
    {downloadBatch && <FileConfirmDialog title="确认本地整批覆盖" onCancel={() => setDownloadBatch(null)} actions={<><button type="button" autoFocus className="node-tool-button" onClick={() => setDownloadBatch(null)}>取消整批</button><button type="button" className="node-tool-button node-tool-button-primary" onClick={() => startDirectoryDownloads(downloadBatch)}>确认覆盖并下载整批</button></>}><p>以下本地同名文件将被覆盖，其他文件保存到同一目录。写入前会再次检查文件是否变化。</p><ul>{[...downloadBatch.existing.keys()].map(name => <li key={name}>{name}</li>)}</ul></FileConfirmDialog>}
    {fallback && <FileConfirmDialog title="确认改用中转" onCancel={() => setFallback(null)} actions={<><button type="button" autoFocus className="node-tool-button" onClick={() => setFallback(null)}>返回</button><button type="button" className="node-tool-button node-tool-button-primary" onClick={() => void retryTransfer(fallback, 'relay')}>确认改用中转</button></>}><p>直连已中断。通过控制中心重新传输以下文件，将从头开始。</p><div className="node-file-confirm-file"><ToolIcon name={fallback.direction} /><strong>{fallback.name}</strong><span>{sizeText(fallback.size)}</span></div><p>{fallback.direction === 'download' ? '已选择的保存位置会继续使用。' : '上传会重新检查同名文件，覆盖前需要确认。'}</p></FileConfirmDialog>}
    {leaveConfirm && <FileConfirmDialog title="离开文件管理？" onCancel={() => setLeaveConfirm(false)} actions={<><button type="button" autoFocus className="node-tool-button" onClick={() => setLeaveConfirm(false)}>继续传输</button><button type="button" className="node-tool-button node-tool-button-danger" onClick={() => window.location.assign('/')}>结束传输并离开</button></>}><p>当前还有未完成或尚未确认完成的文件传输。离开后会结束这些任务，已完成的文件会保留。</p>{rows.some(row => row.task?.status === 'ready' && row.task.transport !== 'direct') && <p>中转下载的保存进度由浏览器管理，请先在浏览器下载列表确认是否已完成。</p>}</FileConfirmDialog>}
  </>;
}
