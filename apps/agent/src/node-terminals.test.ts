import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { NodeToolEvent } from '@controller-center/protocol';
import { NodeTerminals } from './node-terminals.js';
const terminals: NodeTerminals[] = [];
afterEach(() => { for (const terminal of terminals.splice(0)) terminal.dispose(); });
describe('real node PTY', () => {
  it('runs interactive shell/TTY, resizes and closes each session independently', async () => {
    const events: NodeToolEvent[] = [];
    const manager = new NodeTerminals(os.tmpdir(), (event) => { events.push(event); return true; }); terminals.push(manager);
    expect(await manager.initialize()).toBe(true);
    const one = randomUUID(), two = randomUUID();
    manager.handle({ action: 'terminal.open', id: one, cols: 80, rows: 24 }, 'test');
    manager.handle({ action: 'terminal.open', id: two, cols: 80, rows: 24 }, 'test');
    manager.handle({ action: 'terminal.resize', id: one, cols: 110, rows: 35 }, 'test');
    manager.handle({ action: 'terminal.input', id: one, data: 'test -t 0 && printf "PTY_IS_REAL\\n"; stty size\r' }, 'test');
    await expect.poll(() => events.filter((e) => e.action === 'terminal.output' && e.id === one).map((e) => e.action === 'terminal.output' ? e.data : '').join('')).toContain('35 110');
    manager.handle({ action: 'terminal.close', id: one }, 'test');
    manager.handle({ action: 'terminal.input', id: two, data: 'printf "SECOND_ALIVE\\n"\r' }, 'test');
    await expect.poll(() => events.filter((e) => e.action === 'terminal.output' && e.id === two).map((e) => e.action === 'terminal.output' ? e.data : '').join('')).toContain('SECOND_ALIVE');
    expect(events.some((e) => e.action === 'terminal.exit' && e.id === one)).toBe(true);
    manager.handle({ action: 'terminal.open', id: one, cols: 80, rows: 24 }, 'test');
    expect(events.filter((e) => e.action === 'terminal.opened' && e.id === one)).toHaveLength(1);
  });
  it('does not resurrect a close-before-open session', async () => {
    const events: NodeToolEvent[] = [];
    const manager = new NodeTerminals(os.tmpdir(), (event) => { events.push(event); return true; }); terminals.push(manager);
    await manager.initialize(); const id = randomUUID();
    manager.handle({ action: 'terminal.close', id }, 'test');
    manager.handle({ action: 'terminal.open', id, cols: 80, rows: 24 }, 'test');
    expect(events).toHaveLength(0);
  });
});

it('reaps a foreground program that ignores hangup without affecting an unrelated process', async () => {
  const { spawn } = await import('node:child_process');
  const unrelated = spawn('/bin/sh', ['-c', 'sleep 20'], { stdio: 'ignore' });
  const events: NodeToolEvent[] = [];
  const manager = new NodeTerminals(os.tmpdir(), (event) => { events.push(event); return true; }); terminals.push(manager);
  try {
    await manager.initialize(); const id = randomUUID();
    manager.handle({ action: 'terminal.open', id, cols: 80, rows: 24 }, 'test');
    manager.handle({ action: 'terminal.input', id, data: `sh -c 'trap "" HUP; printf "OWNED_PID=%s\\n" "$$"; sleep 20'\r` }, 'test');
    const text = () => events.filter((event) => event.action === 'terminal.output').map((event) => event.action === 'terminal.output' ? event.data : '').join('');
    await expect.poll(() => /OWNED_PID=(\d+)/.test(text())).toBe(true);
    const pid = Number(/OWNED_PID=(\d+)/.exec(text())![1]);
    manager.handle({ action: 'terminal.close', id }, 'test');
    await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, { timeout: 4000 }).toBe(false);
    expect(unrelated.exitCode).toBeNull();
  } finally { unrelated.kill('SIGTERM'); }
});
