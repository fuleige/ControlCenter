import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { isRecord } from "@controller-center/protocol";

export type RpcRequestId = string | number;

interface RpcPending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface AppServerNotification {
  method: string;
  params: unknown;
}

export interface AppServerRequest extends AppServerNotification {
  id: RpcRequestId;
}

export class AppServerClient extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<RpcRequestId, RpcPending>();
  private starting: Promise<void> | null = null;

  constructor(private readonly codexBinary: string) {
    super();
  }

  async start(): Promise<void> {
    if (this.process) return;
    if (this.starting) return this.starting;
    this.starting = this.startInternal();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startInternal(): Promise<void> {
    const child = spawn(this.codexBinary, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.process = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.onLine(line));
    child.stderr.on("data", (chunk: Buffer) => this.emit("stderr", chunk.toString()));
    child.on("error", (error) => this.emit("clientError", error));
    child.on("exit", (code, signal) => {
      if (this.process !== child) return;
      this.process = null;
      const error = new Error(`codex app-server exited (${code ?? signal ?? "unknown"})`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
      this.emit("exit", error);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "controller_center_agent",
        title: "Controller Center Agent",
        version: "0.1.0",
      },
    });
    this.notify("initialized", {});
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("clientError", new Error(`Invalid JSON from app-server: ${line.slice(0, 200)}`));
      return;
    }
    if (!isRecord(message)) return;

    if (typeof message.method === "string") {
      const notification = { method: message.method, params: message.params ?? {} };
      if (typeof message.id === "string" || typeof message.id === "number") {
        this.emit("serverRequest", { ...notification, id: message.id } satisfies AppServerRequest);
      } else {
        this.emit("notification", notification satisfies AppServerNotification);
      }
      return;
    }

    if (typeof message.id !== "string" && typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (isRecord(message.error)) {
      pending.reject(new Error(String(message.error.message ?? "Unknown app-server error")));
    } else {
      pending.resolve(message.result);
    }
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.process) return Promise.reject(new Error("codex app-server is not running"));
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout });
      this.write({ method, id, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  respond(id: RpcRequestId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RpcRequestId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private write(message: unknown): void {
    if (!this.process) throw new Error("codex app-server is not running");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    const child = this.process;
    this.process = null;
    child?.kill("SIGTERM");
  }
}
