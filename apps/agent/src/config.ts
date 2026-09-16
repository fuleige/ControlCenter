import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkspaceDescriptor } from "@controller-center/protocol";
import { codexProxyOnlyFromArgv } from "./outbound-network.js";

export interface AgentConfig {
  controlUrl: string;
  token: string;
  nodeId: string;
  nodeName: string;
  dataDirectory: string;
  codexBinary: string;
  maxConcurrentRuns: number;
  networkAccess: boolean;
  yolo: boolean;
  codexProxyOnly: boolean;
  workspaces: WorkspaceDescriptor[];
}

export interface SavedAgentConnection {
  controlUrl: string;
  credential: string;
}

function integerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeControlUrl(value: string): string {
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

function parseWorkspaces(dataDirectory: string): WorkspaceDescriptor[] {
  const configured = process.env.AGENT_WORKSPACES;
  let candidates: Array<{ id?: string; name?: string; path?: string }> = [];
  if (configured) {
    const parsed: unknown = JSON.parse(configured);
    if (!Array.isArray(parsed)) throw new Error("AGENT_WORKSPACES must be a JSON array");
    candidates = parsed as Array<{ id?: string; name?: string; path?: string }>;
  }

  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const configuredWorkspaces = candidates.map((candidate, index) => {
    if (!candidate.path) throw new Error(`Workspace at index ${index} is missing path`);
    const absolutePath = realpathSync(path.resolve(candidate.path));
    const id = candidate.id?.trim() || slug(candidate.name || path.basename(absolutePath));
    if (seenIds.has(id)) throw new Error(`Duplicate workspace id: ${id}`);
    if (seenPaths.has(absolutePath)) throw new Error(`Duplicate workspace path: ${absolutePath}`);
    seenIds.add(id);
    seenPaths.add(absolutePath);
    return { id, name: candidate.name?.trim() || path.basename(absolutePath), path: absolutePath };
  });

  // npm workspace scripts change process.cwd() to the package directory. INIT_CWD
  // preserves the directory from which the operator actually started the Agent.
  const startupDirectory = process.env.INIT_CWD?.trim() || process.cwd();
  const currentPath = realpathSync(path.resolve(startupDirectory));
  const identityPath = path.join(dataDirectory, "workspace-identities.json");
  let identities: Record<string, string> = {};
  if (existsSync(identityPath)) {
    const parsed = JSON.parse(readFileSync(identityPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) identities = parsed as Record<string, string>;
  }
  const configuredDefault = configuredWorkspaces.find((workspace) => workspace.path === currentPath);
  if (configuredDefault) {
    const conflictingIdentity = Object.entries(identities)
      .find(([workspacePath, id]) => workspacePath !== currentPath && id === configuredDefault.id);
    if (conflictingIdentity) {
      throw new Error(`Workspace id ${configuredDefault.id} is already assigned to ${conflictingIdentity[0]}`);
    }
    if (identities[currentPath] !== configuredDefault.id) {
      identities[currentPath] = configuredDefault.id;
      writeFileSync(identityPath, `${JSON.stringify(identities, null, 2)}\n`, { mode: 0o600 });
    }
    return [
      { ...configuredDefault, source: "default", isDefault: true },
      ...configuredWorkspaces.filter((workspace) => workspace.id !== configuredDefault.id)
        .map((workspace) => ({ ...workspace, source: "config" as const, isDefault: false })),
    ];
  }

  let defaultId = typeof identities[currentPath] === "string" ? identities[currentPath] : "";
  const reservedIds = new Set([...seenIds, ...Object.values(identities)]);
  if (!defaultId) {
    const baseId = slug(path.basename(currentPath));
    defaultId = reservedIds.has(baseId) ? `${baseId}-${randomUUID().slice(0, 8)}` : baseId;
    identities[currentPath] = defaultId;
    writeFileSync(identityPath, `${JSON.stringify(identities, null, 2)}\n`, { mode: 0o600 });
  }
  if (seenIds.has(defaultId)) throw new Error(`Default workspace id conflicts with AGENT_WORKSPACES: ${defaultId}`);
  return [
    { id: defaultId, name: path.basename(currentPath) || currentPath, path: currentPath, source: "default", isDefault: true },
    ...configuredWorkspaces.map((workspace) => ({ ...workspace, source: "config" as const, isDefault: false })),
  ];
}

export function agentDataDirectory(): string {
  return path.resolve(process.env.AGENT_DATA_DIR ?? path.join(os.homedir(), ".controller-center-agent"));
}

export function loadOrCreateNodeId(dataDirectory: string): string {
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

export function loadSavedConnection(dataDirectory: string): SavedAgentConnection | null {
  const connectionPath = path.join(dataDirectory, "connection.json");
  if (!existsSync(connectionPath)) return null;
  const parsed = JSON.parse(readFileSync(connectionPath, "utf8")) as Partial<SavedAgentConnection>;
  if (typeof parsed.controlUrl !== "string" || typeof parsed.credential !== "string") {
    throw new Error(`Invalid Agent connection file: ${connectionPath}`);
  }
  return { controlUrl: parsed.controlUrl, credential: parsed.credential };
}

export function loadConfig(argv: string[] = process.argv.slice(2)): AgentConfig {
  const dataDirectory = agentDataDirectory();
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  chmodSync(dataDirectory, 0o700);
  const savedConnection = loadSavedConnection(dataDirectory);
  // Once enrollment has produced a node-bound credential it must win over a
  // legacy AGENT_TOKEN left in an existing systemd environment file.
  const token = savedConnection?.credential ?? process.env.AGENT_TOKEN ?? "dev-agent-token";
  return {
    controlUrl: normalizeControlUrl(process.env.CONTROL_CENTER_URL ?? savedConnection?.controlUrl ?? "ws://127.0.0.1:8787/agent/connect"),
    token,
    nodeId: loadOrCreateNodeId(dataDirectory),
    nodeName: process.env.AGENT_NAME?.trim() || os.hostname(),
    dataDirectory,
    codexBinary: process.env.CODEX_BIN ?? "codex",
    maxConcurrentRuns: integerEnv("MAX_CONCURRENT_RUNS", 5),
    networkAccess: process.env.AGENT_NETWORK_ACCESS === "true",
    yolo: argv.includes("--yolo"),
    codexProxyOnly: codexProxyOnlyFromArgv(argv),
    workspaces: parseWorkspaces(dataDirectory),
  };
}
