import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface AgentPackageDescriptor {
  version: string;
  fileName: string;
  filePath: string;
  size: number;
  sha256: string;
  builtAt: string;
}

export function findAgentPackage(directory: string, version: string): AgentPackageDescriptor | null {
  if (!/^[0-9A-Za-z.+-]+$/.test(version)) return null;
  const fileName = `controller-center-agent-v${version}.tar.gz`;
  const filePath = path.join(directory, fileName);
  try {
    const status = statSync(filePath);
    if (!status.isFile()) return null;
    return {
      version,
      fileName,
      filePath,
      size: status.size,
      sha256: createHash("sha256").update(readFileSync(filePath)).digest("hex"),
      builtAt: status.mtime.toISOString(),
    };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    if (code === "ENOENT") return null;
    throw error;
  }
}
