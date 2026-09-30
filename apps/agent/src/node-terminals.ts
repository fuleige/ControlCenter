import { createRequire } from 'node:module';
import path from 'node:path';
import { accessSync, chmodSync, constants, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import type { IPty } from 'node-pty';
import { NODE_TOOL_LEASE_MS, TERMINAL_FRAME_BYTES, TERMINAL_WINDOW_BYTES, type NodeToolCommand, type NodeToolEvent } from '@controller-center/protocol';

type TerminalCommand = Extract<NodeToolCommand, { action: `terminal.${string}` }>;
interface Session {
  pty: IPty; expires: number; pending: number; blockedAt: number | null; generation: string;
}
export class NodeTerminals {
  private native: typeof import('node-pty') | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly closed = new Set<string>();
  private readonly timer: NodeJS.Timeout;
  private readonly killTimers = new Set<NodeJS.Timeout>();
  constructor(private readonly cwd: string, private readonly emit: (event: NodeToolEvent, generation: string) => boolean,
    private readonly limit = 8) {
    this.timer = setInterval(() => {
      for (const [id, session] of this.sessions) {
        if (session.expires <= Date.now()) this.close(id, '终端连接已失联');
        else if (session.blockedAt && Date.now() - session.blockedAt > 30_000) this.close(id, '终端输出无法及时显示，连接已结束');
      }
    }, 1_000);
    this.timer.unref();
  }
  async initialize(): Promise<boolean> {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return false;
    try {
      if (process.platform === 'darwin') {
        // The upstream npm tarball ships spawn-helper without its executable bit.
        // Standalone packages already fix it; this also supports source installs.
        const moduleDirectory = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
        const helper = path.join(moduleDirectory, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
        if (existsSync(helper)) { try { accessSync(helper, constants.X_OK); } catch { chmodSync(helper, 0o755); } }
      }
      const native = await import('node-pty');
      await new Promise<void>((resolve, reject) => {
        const probe = native.spawn('/bin/sh', ['-c', 'exit 0'], { cwd: this.cwd, cols: 80, rows: 24, name: 'xterm-256color' });
        const timeout = setTimeout(() => { try { probe.kill('SIGKILL'); } catch { /* exited */ } reject(new Error('PTY 冒烟检查超时')); }, 3_000);
        probe.onExit(({ exitCode }) => { clearTimeout(timeout); exitCode === 0 ? resolve() : reject(new Error('PTY 启动失败')); });
      });
      this.native = native;
      return true;
    } catch (error) {
      console.warn('[agent] terminal unavailable:', error instanceof Error ? error.message : 'PTY loading failed');
      return false;
    }
  }
  get available(): boolean { return this.native !== null; }
  handle(command: TerminalCommand, generation: string): void {
    const { id } = command;
    if (!/^[a-f0-9-]{36}$/i.test(id)) return;
    try {
      if (command.action === 'terminal.open') {
        if (this.sessions.has(id) || this.closed.has(id)) return;
        if (!this.native) throw new Error('PTY 不可用，请安装匹配系统的 Agent 安装包');
        if (this.sessions.size >= this.limit) throw new Error(`节点最多同时打开 ${this.limit} 个终端`);
        this.dimensions(command.cols, command.rows);
        const pty = this.native.spawn(this.shell(), ['-i'], { cwd: this.cwd, env: { ...process.env, TERM: 'xterm-256color' },
          name: 'xterm-256color', cols: command.cols, rows: command.rows });
        const session: Session = { pty, expires: Date.now() + NODE_TOOL_LEASE_MS, pending: 0, blockedAt: null, generation };
        this.sessions.set(id, session);
        if (!this.emit({ action: 'terminal.opened', id, user: os.userInfo().username, cwd: this.cwd }, generation)) {
          this.close(id, '终端连接已结束'); return;
        }
        pty.onData((data) => {
          if (this.sessions.get(id) !== session) return;
          for (let start = 0; start < data.length;) {
            let end = Math.min(start + TERMINAL_FRAME_BYTES / 4, data.length);
            if (end < data.length && /[\uD800-\uDBFF]/u.test(data[end - 1]!)) end--;
            const frame = data.slice(start, end); start = end;
            const bytes = Buffer.byteLength(frame);
            session.pending += bytes;
            if (session.pending > TERMINAL_WINDOW_BYTES * 2 || !this.emit({ action: 'terminal.output', id, data: frame, bytes }, generation)) {
              this.close(id, '终端输出超过连接容量'); return;
            }
          }
          if (session.pending >= TERMINAL_WINDOW_BYTES && session.blockedAt === null) {
            session.blockedAt = Date.now(); pty.pause();
          }
        });
        pty.onExit(({ exitCode }) => {
          if (this.sessions.get(id) !== session) return;
          this.sessions.delete(id); this.rememberClosed(id);
          this.emit({ action: 'terminal.exit', id, exitCode, reason: 'Shell 已退出' }, generation);
        });
        return;
      }
      const session = this.sessions.get(id);
      if (!session || session.generation !== generation) {
        if (command.action === 'terminal.close') this.rememberClosed(id);
        return;
      }
      if (command.action === 'terminal.input') {
        if (typeof command.data !== 'string' || Buffer.byteLength(command.data) > TERMINAL_FRAME_BYTES) throw new Error('终端输入过长');
        session.pty.write(command.data);
      } else if (command.action === 'terminal.resize') {
        this.dimensions(command.cols, command.rows); session.pty.resize(command.cols, command.rows);
      } else if (command.action === 'terminal.ack') {
        if (!Number.isSafeInteger(command.bytes) || command.bytes <= 0 || command.bytes > session.pending) throw new Error('终端输出确认无效');
        session.pending -= command.bytes;
        if (session.blockedAt !== null && session.pending < TERMINAL_WINDOW_BYTES / 2) {
          session.blockedAt = null; session.pty.resume();
        }
      } else if (command.action === 'terminal.lease') session.expires = Date.now() + NODE_TOOL_LEASE_MS;
      else if (command.action === 'terminal.close') this.close(id, '终端已关闭');
    } catch (error) {
      this.emit({ action: 'terminal.error', id, error: error instanceof Error ? error.message : '终端操作失败' }, generation);
      this.close(id, '终端操作失败');
    }
  }
  private dimensions(cols: number, rows: number): void {
    if (![cols, rows].every((n) => Number.isInteger(n) && n >= 2 && n <= 500)) throw new Error('终端尺寸无效');
  }
  private shell(): string {
    for (const candidate of [process.env.SHELL, ...(process.platform === 'darwin' ? ['/bin/zsh', '/bin/sh'] : ['/bin/bash', '/bin/sh'])]) {
      if (!candidate?.startsWith('/')) continue;
      try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* next shell */ }
    }
    throw new Error('找不到可用的 Shell');
  }
  private rememberClosed(id: string): void {
    this.closed.add(id);
    if (this.closed.size > 1024) this.closed.delete(this.closed.values().next().value!);
  }
  close(id: string, reason: string): void {
    this.rememberClosed(id);
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    // Job-control foreground groups belong to this PTY's session. Detached tmux/nohup
    // sessions are not selected. Never kill processes by executable name.
    const pid = session.pty.pid;
    // Darwin exposes the session as a kernel identifier (sess), Linux as sid.
    // Compare the captured identifier, rather than assuming it always equals PID.
    const format = process.platform === 'darwin' ? 'pid=,sess=,pgid=,tpgid=' : 'pid=,sid=,pgid=,tpgid=';
    const parse = (text: string) => text.split('\n').flatMap((line) => {
      const [child, sid, group, foreground] = line.trim().split(/\s+/u);
      return child && sid && group ? [{ pid: Number(child), sid, group: Number(group), foreground: Number(foreground) }] : [];
    });
    execFile('ps', ['-axo', format], { timeout: 1_000, maxBuffer: 2 * 1024 * 1024 }, (_error, stdout) => {
      const processes = parse(stdout); const owner = processes.find((entry) => entry.pid === pid);
      const selected = new Map<number, number>();
      if (owner) for (const child of processes) {
        if (child.sid === owner.sid && child.group > 1 && (child.group === owner.group || child.group === owner.foreground)) selected.set(child.pid, child.group);
      }
      for (const group of new Set(selected.values())) { try { process.kill(-group, 'SIGHUP'); } catch { /* exited */ } }
      try { session.pty.kill('SIGHUP'); } catch { /* exited */ }
      const timer = setTimeout(() => {
        this.killTimers.delete(timer);
        execFile('ps', ['-axo', format], { timeout: 1_000, maxBuffer: 2 * 1024 * 1024 }, (_err, current) => {
          for (const child of parse(current)) {
            if (owner && child.sid === owner.sid && selected.get(child.pid) === child.group) {
              try { process.kill(-child.group, 'SIGKILL'); } catch { /* exited */ }
            }
          }
        });
      }, 1_500);
      this.killTimers.add(timer); timer.unref();
    });
    this.emit({ action: 'terminal.exit', id, exitCode: -1, reason }, session.generation);
  }
  reset(): void { for (const id of this.sessions.keys()) this.close(id, '节点连接已断开'); }
  dispose(): void { clearInterval(this.timer); this.reset(); }
}
