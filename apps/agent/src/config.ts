import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkspaceDescriptor } from "@controller-center/protocol";

export interface AgentConfig {
  controlUrl: string;
  token: string;
  nodeId: string;
  nodeName: string;
  dataDirectory: string;
  codexBinary: string;
  maxConcurrentRuns: number;
  networkAccess: boolean;
  workspaces: WorkspaceDescriptor[];
}

function integerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeControlUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("CONTROL_CENTER_URL must use http(s) or ws(s)");
  }
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/agent/connect";
  return url.toString();
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "workspace";
}

function parseWorkspaces(): WorkspaceDescriptor[] {
  const configured = process.env.AGENT_WORKSPACES;
  let candidates: Array<{ id?: string; name?: string; path?: string }>;
  if (configured) {
    const parsed: unknown = JSON.parse(configured);
    if (!Array.isArray(parsed)) throw new Error("AGENT_WORKSPACES must be a JSON array");
    candidates = parsed as Array<{ id?: string; name?: string; path?: string }>;
  } else {
    const current = process.cwd();
    candidates = [{ id: slug(path.basename(current)), name: path.basename(current), path: current }];
  }

  const seen = new Set<string>();
  return candidates.map((candidate, index) => {
    if (!candidate.path) throw new Error(`Workspace at index ${index} is missing path`);
    const absolutePath = realpathSync(path.resolve(candidate.path));
    const id = candidate.id?.trim() || slug(candidate.name || path.basename(absolutePath));
    if (seen.has(id)) throw new Error(`Duplicate workspace id: ${id}`);
    seen.add(id);
    return { id, name: candidate.name?.trim() || path.basename(absolutePath), path: absolutePath };
  });
}

function loadOrCreateNodeId(dataDirectory: string): string {
  const identityPath = path.join(dataDirectory, "identity.json");
  if (process.env.AGENT_ID) return process.env.AGENT_ID;
  if (existsSync(identityPath)) {
    const parsed = JSON.parse(readFileSync(identityPath, "utf8")) as { nodeId?: string };
    if (parsed.nodeId) return parsed.nodeId;
  }
  const nodeId = randomUUID();
  writeFileSync(identityPath, `${JSON.stringify({ nodeId }, null, 2)}\n`, { mode: 0o600 });
  return nodeId;
}

export function loadConfig(): AgentConfig {
  const dataDirectory = path.resolve(
    process.env.AGENT_DATA_DIR ?? path.join(os.homedir(), ".controller-center-agent"),
  );
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const token = process.env.AGENT_TOKEN ?? "dev-agent-token";
  return {
    controlUrl: normalizeControlUrl(process.env.CONTROL_CENTER_URL ?? "ws://127.0.0.1:8787/agent/connect"),
    token,
    nodeId: loadOrCreateNodeId(dataDirectory),
    nodeName: process.env.AGENT_NAME?.trim() || os.hostname(),
    dataDirectory,
    codexBinary: process.env.CODEX_BIN ?? "codex",
    maxConcurrentRuns: integerEnv("MAX_CONCURRENT_RUNS", 2),
    networkAccess: process.env.AGENT_NETWORK_ACCESS === "true",
    workspaces: parseWorkspaces(),
  };
}
