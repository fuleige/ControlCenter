import { readFileSync } from "node:fs";

interface PackageRuntime {
  target: string;
  nodeMajor: number;
}

export function agentPackageVersion(packagePath: string | URL = new URL("../package.json", import.meta.url)): string {
  const info = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  if (!info || typeof info.version !== "string" || !info.version.trim()) throw new Error("Agent 安装包缺少有效版本，请重新下载完整安装包");
  return info.version;
}

function currentRuntime(): PackageRuntime {
  const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
  const libc = process.platform === "linux" ? (report.header.glibcVersionRuntime ? "glibc" : "musl") : null;
  return {
    target: [process.platform, process.arch, libc].filter(Boolean).join("-"),
    nodeMajor: Number(process.versions.node.split(".")[0]),
  };
}

export function assertAgentPackageRuntime(
  buildInfoPath: string | URL = new URL("../BUILD-INFO.json", import.meta.url),
  runtime: PackageRuntime = currentRuntime(),
  warn: (message: string) => void = console.warn,
): void {
  let info: { target?: unknown };
  try {
    info = JSON.parse(readFileSync(buildInfoPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // Source checkout.
    throw new Error("无法读取安装包 BUILD-INFO.json，请重新下载完整安装包", { cause: error });
  }
  if (!info || typeof info !== "object" || Array.isArray(info)) throw new Error("安装包 BUILD-INFO.json 格式无效，请重新下载完整安装包");
  if (info.target === undefined) return; // Older packages without native modules.
  if (typeof info.target !== "string" || !info.target) throw new Error("安装包缺少有效的构建目标，请重新下载完整安装包");
  if (info.target !== runtime.target) {
    throw new Error(`安装包目标为 ${info.target}，当前运行环境为 ${runtime.target}。请下载 ${runtime.target} 的 Agent 安装包；Linux 与 macOS 安装包不能混用`);
  }
  if (!Number.isSafeInteger(runtime.nodeMajor) || runtime.nodeMajor < 24) {
    throw new Error(`此安装包需要 Node.js 24 或以上版本，当前为 Node.js ${runtime.nodeMajor}.x，请升级 Node.js 后启动`);
  }
  if (runtime.nodeMajor > 24) {
    warn(`[agent] 当前 Node.js ${runtime.nodeMajor}.x 高于打包基线 24.x，继续运行；终端与直连能力以启动检测结果为准`);
  }
}

export function requireAgentPackageRuntime(): void {
  try {
    assertAgentPackageRuntime();
  } catch (error) {
    console.error(`[agent] 安装检查失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
