import type { AgentPackageInfo } from "./types";

export function agentPackageTargetLabel(target: string): string {
  const labels: Record<string, string> = {
    "linux-x64-glibc": "Linux · x64 · glibc",
    "linux-arm64-glibc": "Linux · ARM64 · glibc",
    "linux-x64-musl": "Linux · x64 · musl",
    "linux-arm64-musl": "Linux · ARM64 · musl",
    "darwin-arm64": "macOS · ARM64（Apple 芯片）",
    "darwin-x64": "macOS · x64（Intel / Rosetta）",
  };
  return labels[target] ?? target;
}

export function selectAgentPackage(info: AgentPackageInfo | null, target: string): AgentPackageInfo | null {
  if (!info) return null;
  if (!info.target && !info.packages?.length) return info; // Legacy portable package.
  if (!target) return null;
  return info.packages?.find((item) => item.target === target) ?? (info.target === target ? info : null);
}
