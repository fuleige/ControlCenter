/** Ephemeral node tools never enter the Codex command/outbox replay queue. */
export const TERMINAL_PTY_CAPABILITY = 'terminal_pty_v1';
export const NODE_FILES_CAPABILITY = 'node_files_v1';
export const NODE_FILES_DIRECT_CAPABILITY = 'node_files_direct_v1';
export const DEFAULT_NODE_FILES_STUN_URLS = [
  'stun:stun.cloudflare.com:3478',
  'stun:global.stun.twilio.com:3478',
  'stun:stun.l.google.com:19302',
] as const;
export type NodeFileTransport = 'relay' | 'direct';
export type NodeFileSignal = { type: 'offer' | 'answer'; sdp: string } | { type: 'candidate'; candidate: string; mid: string };
export const NODE_FILE_MAX_BYTES = 1024 ** 3;
export const NODE_FILE_CHUNK_BYTES = 1024 ** 2;
export const NODE_TOOL_LEASE_MS = 60_000;
export const TERMINAL_WINDOW_BYTES = 256 * 1024;
export const TERMINAL_FRAME_BYTES = 32 * 1024;

export interface NodeFileIdentity {
  dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number;
  mode: number; uid: number; gid: number;
}
export interface NodeFileEntry {
  name: string; path: string; type: 'directory' | 'file' | 'symlink' | 'other';
  size: number; modifiedAt: string; linkType?: 'directory' | 'file' | 'other' | 'unavailable';
}
export interface NodeDirectory {
  path: string; parent: string; entries: NodeFileEntry[]; nextCursor: number | null;
  user: string;
}
export interface NodeUploadTarget {
  name: string; path: string; size: number; existing: NodeFileIdentity | null;
}
export interface NodeDownloadSource { path: string; name: string; size: number; identity: NodeFileIdentity }

export type NodeToolCommand =
  | { action: 'reset' }
  | { action: 'terminal.open'; id: string; cols: number; rows: number }
  | { action: 'terminal.input'; id: string; data: string }
  | { action: 'terminal.resize'; id: string; cols: number; rows: number }
  | { action: 'terminal.ack'; id: string; bytes: number }
  | { action: 'terminal.close'; id: string }
  | { action: 'terminal.lease'; id: string }
  | { action: 'files.list'; requestId: string; path: string; cursor: number }
  | { action: 'files.preflight'; requestId: string; directory: string; files: Array<{ name: string; size: number }> }
  | { action: 'files.stat'; requestId: string; path: string }
  | { action: 'files.upload'; id: string; target: NodeUploadTarget; sha256: string; url: string; token: string }
  | { action: 'files.download'; id: string; source: NodeDownloadSource; url: string; token: string }
  | { action: 'files.direct.signal'; pageId: string; connectionId: string; token: string; stunUrls: string[]; signal: NodeFileSignal }
  | { action: 'files.direct.close'; pageId: string }
  | { action: 'files.direct.lease'; pageId: string }
  | { action: 'files.direct.upload'; id: string; pageId: string; connectionId: string; target: NodeUploadTarget; token: string }
  | { action: 'files.direct.download'; id: string; pageId: string; connectionId: string; source: NodeDownloadSource; token: string }
  | { action: 'files.direct.resume'; id: string; pageId: string; connectionId: string; token: string }
  | { action: 'files.cancel'; id: string }
  | { action: 'files.lease'; ids: string[] };
export interface ControlNodeToolMessage {
  type: 'control.nodeTool'; generation: string; command: NodeToolCommand;
}
export type NodeToolEvent =
  | { action: 'files.direct.signal'; pageId: string; connectionId: string; signal: NodeFileSignal }
  | { action: 'files.direct.ready'; pageId: string; connectionId: string }
  | { action: 'terminal.opened'; id: string; user: string; cwd: string }
  | { action: 'terminal.output'; id: string; data: string; bytes: number }
  | { action: 'terminal.exit'; id: string; exitCode: number; reason: string }
  | { action: 'terminal.error'; id: string; error: string }
  | { action: 'files.result'; requestId: string; result?: NodeDirectory | NodeUploadTarget[] | NodeDownloadSource; error?: string }
  | { action: 'files.progress'; id: string; offset: number; phase: 'transferring' | 'verifying' | 'committing' }
  | { action: 'files.complete'; id: string; sha256: string }
  | { action: 'files.error'; id: string; error: string; kind?: 'connection' | 'business' }
  | { action: 'files.stopped'; id: string };
export interface AgentNodeToolMessage { type: 'agent.nodeTool'; generation: string; event: NodeToolEvent }
export interface NodeFileTaskView {
  transport?: NodeFileTransport;
  /** Agent file ownership has ended; a new attempt can safely acquire its path. */
  stopped?: boolean;
  errorKind?: 'connection' | 'business';
  id: string; direction: 'upload' | 'download'; name: string; path: string; size: number;
  offset: number; agentOffset: number;
  status: 'transferring' | 'verifying' | 'committing' | 'ready' | 'completed' | 'failed' | 'cancelled';
  phase: 'browser-upload' | 'node-upload' | 'node-download' | 'verifying' | 'committing' | 'ready' | 'completed';
  error: string | null; sha256: string | null;
}
