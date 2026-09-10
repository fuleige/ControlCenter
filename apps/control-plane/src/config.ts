import path from "node:path";

function integerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface ControlPlaneConfig {
  host: string;
  port: number;
  databasePath: string;
  agentToken: string;
  adminToken: string | null;
  corsOrigin: string;
  heartbeatIntervalMs: number;
  offlineAfterMs: number;
  attachmentDirectory: string;
}

export function loadConfig(): ControlPlaneConfig {
  const dataDirectory = process.env.CONTROL_DATA_DIR ?? path.resolve("data");
  return {
    host: process.env.CONTROL_HOST ?? "0.0.0.0",
    port: integerEnv("CONTROL_PORT", 8787),
    databasePath: process.env.CONTROL_DATABASE_PATH ?? path.join(dataDirectory, "control-center.db"),
    agentToken: process.env.AGENT_SHARED_TOKEN ?? "dev-agent-token",
    adminToken: process.env.ADMIN_TOKEN || null,
    corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
    heartbeatIntervalMs: integerEnv("HEARTBEAT_INTERVAL_MS", 15_000),
    offlineAfterMs: integerEnv("OFFLINE_AFTER_MS", 45_000),
    attachmentDirectory: path.join(dataDirectory, "attachments"),
  };
}
