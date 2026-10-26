import type { AgentPackageInfo } from "./types";

// Acceptance belongs to an exact artifact; rebuilding never inherits its status.
const macOSVerifications = [
  {
    version: "0.3.19",
    sha256: "d4a9981ea1ab7c0fd391ed0570e1b33f058d541018727ed41469f5628620d852",
    label: "macOS 直连下载已实机验证",
    title: "2026-10-08 用户确认当前 ARM64 安装包可正常直连下载",
  },
  {
    version: "0.3.22",
    sha256: "3988ed0d267a4e47cd7c77eb5557a8dffcd5c0e79d73e6fe2e427d66baad22ed",
    label: "macOS 已实机测试",
    title: "2026-10-26 用户反馈当前 ARM64 安装包已在 macOS 实测，未发现异常",
  },
];

export function macOSPackageVerification(info: AgentPackageInfo): { label: string; title: string } | null {
  return info.target === "darwin-arm64"
    ? macOSVerifications.find((entry) => entry.version === info.version && entry.sha256 === info.sha256) ?? null
    : null;
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
