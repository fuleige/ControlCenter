import path from "node:path";

function integerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface ControlPlaneConfig {
  host: string;
  port: number;
  dataDirectory: string;
  databasePath: string;
  agentToken: string;
  adminToken: string | null;
  adminTokenPath: string;
  enrollmentDisplayKeyPath: string;
  publicOrigin: string;
  corsOrigin: string;
  trustProxy: boolean;
  heartbeatIntervalMs: number;
  offlineAfterMs: number;
  attachmentDirectory: string;
  agentArtifactDirectory: string;
}

export function loadConfig(): ControlPlaneConfig {
  // npm workspace scripts execute inside the package directory. INIT_CWD keeps
  // the operator's invocation directory so the default database does not move
  // when switching between root-level and workspace-level start commands.
  const startupDirectory = process.env.INIT_CWD?.trim() || process.cwd();
  const dataDirectory = path.resolve(process.env.CONTROL_DATA_DIR ?? path.join(startupDirectory, "data"));
  return {
    host: process.env.CONTROL_HOST ?? "0.0.0.0",
    port: integerEnv("CONTROL_PORT", 8787),
    dataDirectory,
    databasePath: process.env.CONTROL_DATABASE_PATH ?? path.join(dataDirectory, "control-center.db"),
    agentToken: process.env.AGENT_SHARED_TOKEN ?? "dev-agent-token",
    adminToken: process.env.ADMIN_TOKEN || null,
    adminTokenPath: process.env.ADMIN_TOKEN_FILE ?? path.join(dataDirectory, "secrets", "admin-token"),
    enrollmentDisplayKeyPath: process.env.ENROLLMENT_DISPLAY_KEY_FILE ?? path.join(dataDirectory, "secrets", "enrollment-display-key"),
    publicOrigin: (process.env.PUBLIC_ORIGIN ?? process.env.CORS_ORIGIN ?? "http://localhost:5173").replace(/\/$/, ""),
    corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
    trustProxy: process.env.TRUST_PROXY === "true",
    heartbeatIntervalMs: integerEnv("HEARTBEAT_INTERVAL_MS", 15_000),
    offlineAfterMs: integerEnv("OFFLINE_AFTER_MS", 45_000),
    attachmentDirectory: path.join(dataDirectory, "attachments"),
    agentArtifactDirectory: path.resolve(process.env.AGENT_ARTIFACT_DIR ?? path.join(startupDirectory, "artifacts")),
  };
}
