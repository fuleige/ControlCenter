import type { NodeDirectory, NodeFileTaskView, NodeUploadTarget } from '@controller-center/protocol';
import { API_URL, ApiError, api } from './api';
export interface ToolInfo { online: boolean; terminal: boolean; files: boolean }
export const toolInfo = (nodeId: string) => api<ToolInfo>(`/api/node-tools/nodes/${encodeURIComponent(nodeId)}/info`, { signal: AbortSignal.timeout(30_000) });
export function socketUrl(endpoint: string): string {
  const url = new URL(`${API_URL}${endpoint}`, window.location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; return url.toString();
}
export const createFilePage = (nodeId: string) => api<{ pageId: string }>(`/api/node-tools/nodes/${encodeURIComponent(nodeId)}/pages`, { method: 'POST', signal: AbortSignal.timeout(30_000) });
export class FilePageApi {
  private readonly controller = new AbortController();
  constructor(readonly id: string) {}
  private request<T>(endpoint: string, init?: RequestInit): Promise<T> {
    const signals = [this.controller.signal, AbortSignal.timeout(30_000)];
    if (init?.signal) signals.push(init.signal);
    return api<T>(endpoint, { ...init, signal: AbortSignal.any(signals), headers: { ...init?.headers as Record<string, string>, 'X-Node-Page': this.id } });
  }
  list(path: string, cursor = 0) { return this.request<{ directory: NodeDirectory }>(`/api/node-tools/files/list?path=${encodeURIComponent(path)}&cursor=${cursor}`); }
  preflight(directory: string, files: File[]) { return this.request<{ planId: string; targets: NodeUploadTarget[] }>('/api/node-tools/files/preflight',
    { method: 'POST', body: JSON.stringify({ directory, files: files.map(({ name, size }) => ({ name, size })) }) }); }
  upload(planId: string, index: number, overwrite: boolean, signal?: AbortSignal) { return this.request<{ task: NodeFileTaskView }>('/api/node-tools/files/uploads', { method: 'POST', signal, body: JSON.stringify({ planId, index, overwrite }) }); }
  download(path: string, requestId: string, signal?: AbortSignal) { return this.request<{ task: NodeFileTaskView }>('/api/node-tools/files/downloads', { method: 'POST', signal, body: JSON.stringify({ path, requestId }) }); }
  task(id: string, signal?: AbortSignal) { return this.request<{ task: NodeFileTaskView }>(`/api/node-tools/tasks/${id}`, { signal }); }
  chunk(id: string, offset: number, bytes: Uint8Array, hash: string, signal: AbortSignal) { return this.request<{ offset: number }>(`/api/node-tools/tasks/${id}/chunks/${offset}`,
    { method: 'PUT', body: bytes as BodyInit, signal, headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': hash } }); }
  finalize(id: string, hash: string, signal?: AbortSignal) { return this.request<{ task: NodeFileTaskView }>(`/api/node-tools/tasks/${id}/finalize`, { method: 'POST', signal, body: JSON.stringify({ sha256: hash }) }); }
  cancel(id: string) { return this.request<{ task: NodeFileTaskView }>(`/api/node-tools/tasks/${id}`, { method: 'DELETE' }); }
  close() {
    this.controller.abort();
    return api<void>(`/api/node-tools/pages/${this.id}`, { method: 'DELETE', keepalive: true, signal: AbortSignal.timeout(30_000) });
  }
}
export function retryable(error: unknown): boolean {
  return error instanceof ApiError && (error.kind === 'network' || (error.status !== null && [408, 429, 502, 503, 504].includes(error.status)));
}
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { window.clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = window.setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
}
