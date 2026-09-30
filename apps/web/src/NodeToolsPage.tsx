import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Terminal as XtermTerminal } from '@xterm/xterm';
import { NODE_FILE_CHUNK_BYTES, NODE_FILE_MAX_BYTES, type NodeDirectory, type NodeFileTaskView, type NodeUploadTarget, type NodeToolEvent } from '@controller-center/protocol';
import { API_URL, api, formatErrorMessage } from './api';
import { createFilePage, FilePageApi, socketUrl, toolInfo, retryable, delay } from './node-tools-api';
import { ToolIcon, TransferPanel, progressBytes, sizeText, type TransferRow } from './node-tools-ui';
import './node-tools.css';

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
    {error ? <section className="node-tools-route-message"><ToolIcon name={mode === 'terminal' ? 'terminal' : 'folder'} /><h1>{name} · {mode === 'terminal' ? '终端' : '节点文件'}</h1><p role="alert" className="node-tools-error">{error}</p><button type="button" className="node-tool-button" onClick={() => window.location.reload()}>重新打开</button></section>
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
interface UploadBatch { files: File[]; planId: string; targets: NodeUploadTarget[] }
const doneStates = new Set(['completed', 'failed', 'cancelled']);
const phaseText: Record<NodeFileTaskView['phase'], string> = { 'browser-upload': '正在上传到服务器', 'node-upload': '正在写入节点', 'node-download': '正在准备下载', verifying: '正在校验文件', committing: '正在提交节点文件', ready: '准备完成', completed: '已上传到节点' };
function FilesPage({ nodeId, name }: { nodeId: string; name: string }) {
  const [client, setClient] = useState<FilePageApi | null>(null); const [connectionStatus, setConnectionStatus] = useState('正在建立文件页面…');
  const [directory, setDirectory] = useState<NodeDirectory | null>(null); const [pathInput, setPathInput] = useState(''); const [loading, setLoading] = useState(false);
  const [error, setError] = useState(''); const [rows, setRows] = useState<Row[]>([]); const rowsRef = useRef<Row[]>([]);
  const [batch, setBatch] = useState<UploadBatch | null>(null); const [busy, setBusy] = useState(false); const [selected, setSelected] = useState<Set<string>>(new Set());
  const stopPage = useRef<(() => void) | null>(null);
  const alive = useRef(true); const listRevision = useRef(0); const queue = useRef(Promise.resolve()); const fileInput = useRef<HTMLInputElement>(null);
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
      rowsRef.current.forEach((row) => row.controller.abort());
      if (socket?.readyState === WebSocket.OPEN) socket.send('{"action":"close"}'); socket?.close();
      void apiClient?.close().catch(() => undefined);
    };
    stopPage.current = stop;
    const connect = () => {
      if (!active || !apiClient) return;
      socket = new WebSocket(socketUrl(`/api/node-tools/nodes/${encodeURIComponent(nodeId)}/pages/${apiClient.id}/connect`));
      socket.onopen = () => { if (active) { attempts = 0; setConnectionStatus('已连接'); setClient(apiClient); } };
      socket.onclose = () => {
        if (!active) return;
        setConnectionStatus('连接中断，正在尝试续传；超过失联期限后任务结束');
        if (++attempts > 6) { setConnectionStatus('文件页面连接已失效，请重新打开'); setClient(null); return; }
        reconnect = window.setTimeout(connect, Math.min(5000, 500 * 2 ** attempts));
      };
      socket.onerror = () => { /* close drives bounded retries */ };
    };
    void createFilePage(nodeId).then(({ pageId }) => {
      apiClient = new FilePageApi(pageId);
      if (!active) { void apiClient.close().catch(() => undefined); return; } connect();
    }).catch((reason) => { if (active) setError(formatErrorMessage(reason, '创建文件页面')); });
    window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); stop(); };
  }, [nodeId]);
  const browse = useCallback(async (target: string, cursor = 0) => {
    if (!client) return;
    const revision = ++listRevision.current; setLoading(true); setError('');
    try {
      const result = await client.list(target, cursor);
      if (!alive.current || revision !== listRevision.current) return;
      setDirectory((old) => cursor && old?.path === result.directory.path ? { ...result.directory, entries: [...old.entries, ...result.directory.entries] } : result.directory);
      setPathInput(result.directory.path); if (!cursor) setSelected(new Set());
    } catch (reason) { if (alive.current && revision === listRevision.current) setError(formatErrorMessage(reason, '浏览目录')); }
    finally { if (alive.current && revision === listRevision.current) setLoading(false); }
  }, [client]);
  useEffect(() => { if (client) void browse(''); }, [client, browse]);
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
        update(row.key, { message: row.controller.signal.aborted ? '已取消' : '失败', error: row.controller.signal.aborted ? '' : formatErrorMessage(reason, row.direction === 'upload' ? '上传' : '下载') });
      }
    });
  }
  function startUploads(plan: UploadBatch, overwrite: boolean) {
    if (!client) return;
    const apiClient = client; setBatch(null);
    plan.files.forEach((file, index) => {
      const row = addRow(file.name, 'upload', file.size);
      enqueue(row, async () => {
        const { task } = await retry(() => apiClient.upload(plan.planId, index, overwrite, row.controller.signal), row); update(row.key, { task });
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
      });
    });
  }
  async function chooseUploads(files: File[]) {
    if (!client || !directory || !files.length) return;
    if (rowsRef.current.length + files.length > 200 || files.length > 100) { setError('每批最多 100 个文件；当前页面最多展示 200 项，请重新打开页面开始新批次'); return; }
    const accepted: File[] = [];
    files.forEach((file) => {
      if (file.size > NODE_FILE_MAX_BYTES) { const row = addRow(file.name, 'upload', file.size); update(row.key, { message: '失败', error: '文件超过单文件大小限制（最大 1 GiB）' }); }
      else accepted.push(file);
    });
    if (!accepted.length) return;
    setBusy(true); setError('');
    try {
      const plan = await client.preflight(directory.path, accepted);
      if (!alive.current) return;
      const next = { files: accepted, ...plan };
      if (plan.targets.some((target) => target.existing)) setBatch(next); else startUploads(next, false);
    } catch (reason) { if (alive.current) setError(formatErrorMessage(reason, '上传预检')); }
    finally { if (alive.current) setBusy(false); }
  }
  function startDownloads(paths: string[]) {
    if (!client || !directory) return;
    if (rowsRef.current.length + paths.length > 200) { setError('当前页面最多展示 200 项，请重新打开页面开始新批次'); return; }
    const apiClient = client;
    paths.forEach((filePath) => {
      const entry = directory.entries.find((item) => item.path === filePath); const row = addRow(entry?.name || filePath, 'download', entry?.size || 0);
      if (entry && entry.size > NODE_FILE_MAX_BYTES) { update(row.key, { message: '失败', error: '文件超过单文件大小限制（最大 1 GB）' }); return; }
      enqueue(row, async () => {
        const { task } = await retry(() => apiClient.download(filePath, row.key, row.controller.signal), row); update(row.key, { task });
        const result = await waitForTask(apiClient, row, task.id);
        if (result.status !== 'ready') throw new Error(result.error || '下载准备失败');
        requestDownload(row.key, result.id);
      });
    });
  }
  function requestDownload(key: string, id: string) {
    const anchor = document.createElement('a'); anchor.href = `${API_URL}/api/node-tools/tasks/${id}/content`; anchor.download = ''; anchor.style.display = 'none';
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    update(key, { requested: true, message: '已请求浏览器下载，请在 Chrome 下载栏查看进度' });
  }
  async function cancelRow(row: Row) {
    row.controller.abort();
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
  return <><header className="node-files-header"><div className="node-files-identity"><span className="node-files-app-icon"><ToolIcon name="folder" /></span><div><h1>{name} · 节点文件</h1><p>系统用户 {directory?.user || '待确认'} <span>·</span> 单文件最大 1 GiB</p></div></div><span role="status" title={connectionStatus} data-state={connectionStatus === '已连接' ? 'online' : 'connecting'} className="node-tool-connection"><i aria-hidden="true" />{connectionStatus}</span>
    <button type="button" className="node-tool-button node-tool-button-ghost" aria-label="关闭文件页" onClick={() => { stopPage.current?.(); setClient(null); setConnectionStatus('文件页已关闭；请重新打开'); window.close(); }}><ToolIcon name="close" />关闭</button></header>
    <form className="node-files-path" onSubmit={(event: FormEvent) => { event.preventDefault(); void browse(pathInput); }}>
      <button type="button" className="node-tool-button node-tool-button-icon" aria-label="上级" title="上级目录" disabled={!directory || loading} onClick={() => void browse(directory!.parent)}><ToolIcon name="up" /></button>
      <div className="node-files-path-input"><ToolIcon name="folder" /><input aria-label="节点目录路径" value={pathInput} onChange={(event) => setPathInput(event.target.value)} placeholder="输入绝对路径" /></div>
      <button className="node-tool-button" disabled={!client || loading}><ToolIcon name="arrow" />打开</button><button type="button" className="node-tool-button node-tool-button-icon" aria-label="刷新" title="刷新目录" disabled={!directory || loading} onClick={() => void browse(directory!.path)}><ToolIcon name="refresh" /></button>
    </form>
    <div className="node-files-workspace">
      <section className="node-file-browser" aria-label="节点目录">
        <header className="node-panel-heading"><div><h2>文件</h2><span>{loading ? '正在读取目录…' : selected.size ? `已选择 ${selected.size} 项` : `${directory?.entries.length || 0} 项`}</span></div>
          <div className="node-files-actions"><button type="button" className="node-tool-button node-tool-button-primary" disabled={!client || !directory || busy || !!batch} onClick={() => fileInput.current?.click()}><ToolIcon name="upload" />{busy ? '正在预检…' : '上传文件'}</button><button type="button" className="node-tool-button" disabled={!client || !selected.size} onClick={() => startDownloads([...selected])}><ToolIcon name="download" />下载所选文件（{selected.size}）</button></div>
          <input hidden multiple type="file" ref={fileInput} onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ''; void chooseUploads(files); }} />
        </header>
        {error && <p role="alert" className="node-tools-error node-files-error">{error}</p>}
        <div className="node-files-list" aria-busy={loading}><table><thead><tr><th className="node-file-check">选择</th><th>名称</th><th className="node-file-type">类型</th><th className="node-file-size">大小</th><th className="node-file-date">修改时间</th></tr></thead><tbody>
          {directory?.entries.map((entry) => <tr key={entry.path}><td className="node-file-check">{(entry.type === 'file' || entry.linkType === 'file') && <input type="checkbox" aria-label={`选择 ${entry.name}`} checked={selected.has(entry.path)} onChange={(event) => setSelected((old) => { const next = new Set(old); event.target.checked ? next.add(entry.path) : next.delete(entry.path); return next; })} />}</td>
            <td><div className="node-file-name"><ToolIcon name={entry.type === 'directory' || entry.linkType === 'directory' ? 'folder' : 'file'} />{entry.type === 'directory' || entry.linkType === 'directory' ? <button type="button" className="node-tool-text-button" title={entry.path} onClick={() => void browse(entry.path)}>{entry.name}{entry.type === 'symlink' ? ' ↗' : ''}</button> : <span title={entry.path}>{entry.name}</span>}</div></td>
            <td className="node-file-type">{entry.type === 'symlink' ? `软链接（${{ file: '文件', directory: '目录', other: '特殊文件', unavailable: '不可访问' }[entry.linkType || 'unavailable']}）` : { directory: '目录', file: '文件', other: '特殊文件' }[entry.type]}</td><td className="node-file-size">{entry.type === 'file' || entry.linkType === 'file' ? sizeText(entry.size) : '—'}</td><td className="node-file-date">{new Date(entry.modifiedAt).toLocaleString()}</td></tr>)}
        </tbody></table>{directory && !directory.entries.length && !loading && <div className="node-directory-empty"><ToolIcon name="folder" /><strong>目录为空</strong><span>点击“上传文件”添加文件</span></div>}</div>
        <footer className="node-file-browser-footer"><span>切换目录不影响当前传输</span>{directory?.nextCursor !== null && directory?.nextCursor !== undefined && <button type="button" className="node-tool-text-button" disabled={loading} onClick={() => void browse(directory.path, directory.nextCursor!)}>加载更多</button>}</footer>
      </section>
      <TransferPanel rows={rows} onCancel={(row) => void cancelRow(row)} onDownload={requestDownload} />
    </div>
    {batch && <div className="node-file-confirm-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="node-upload-confirm"><h2 id="node-upload-confirm">确认整批覆盖</h2><p>以下同名文件将被覆盖；其他文件一同上传。传输期间请避免同时编辑这些目标文件。</p><ul>{batch.targets.filter((target) => target.existing).map((target) => <li key={target.path}>{target.path}</li>)}</ul><div><button type="button" className="node-tool-button" onClick={() => setBatch(null)}>取消整批</button><button type="button" className="node-tool-button node-tool-button-primary" onClick={() => startUploads(batch, true)}>确认覆盖并上传整批</button></div></section></div>}
  </>;
}
