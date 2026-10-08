import type { AgentPackageInfo } from "./types";

// User acceptance on 2026-10-08 covers this exact ARM64 artifact's direct download.
// A rebuilt archive, a different target or a later version needs its own verification.
export function macOSPackageDownloadVerified(info: AgentPackageInfo): boolean {
  return info.target === "darwin-arm64" && info.version === "0.3.19"
    && info.sha256 === "d4a9981ea1ab7c0fd391ed0570e1b33f058d541018727ed41469f5628620d852";
}

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
