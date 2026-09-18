import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceFileReadErrorCode } from "@controller-center/protocol";

export interface WorkspaceFileReadInput {
  workspacePath: string;
  requestedPath: string;
  basePath?: string;
  maxBytes: number;
}

export type WorkspaceFileReadResult =
  | {
      ok: true;
      path: string;
      name: string;
      mediaType: string;
      size: number;
      contentBase64: string;
    }
  | {
      ok: false;
      errorCode: WorkspaceFileReadErrorCode;
      error: string;
    };

const mediaTypes = new Map<string, string>([
  [".md", "text/markdown; charset=utf-8"],
  [".markdown", "text/markdown; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".tsv", "text/tab-separated-values; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".log", "text/plain; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".yaml", "application/yaml; charset=utf-8"],
  [".yml", "application/yaml; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".cjs", "text/javascript; charset=utf-8"],
  [".ts", "text/typescript; charset=utf-8"],
  [".tsx", "text/typescript; charset=utf-8"],
  [".jsx", "text/javascript; charset=utf-8"],
  [".sh", "text/x-shellscript; charset=utf-8"],
  [".bash", "text/x-shellscript; charset=utf-8"],
  [".zsh", "text/x-shellscript; charset=utf-8"],
  [".fish", "text/x-shellscript; charset=utf-8"],
  [".py", "text/x-python; charset=utf-8"],
  [".pyw", "text/x-python; charset=utf-8"],
  [".go", "text/x-go; charset=utf-8"],
  [".rs", "text/x-rust; charset=utf-8"],
  [".java", "text/x-java-source; charset=utf-8"],
  [".c", "text/x-c; charset=utf-8"],
  [".h", "text/x-c; charset=utf-8"],
  [".cc", "text/x-c++; charset=utf-8"],
  [".cpp", "text/x-c++; charset=utf-8"],
  [".cxx", "text/x-c++; charset=utf-8"],
  [".hpp", "text/x-c++; charset=utf-8"],
  [".hxx", "text/x-c++; charset=utf-8"],
  [".cs", "text/x-csharp; charset=utf-8"],
  [".rb", "text/x-ruby; charset=utf-8"],
  [".php", "text/x-php; charset=utf-8"],
  [".pl", "text/x-perl; charset=utf-8"],
  [".pm", "text/x-perl; charset=utf-8"],
  [".lua", "text/x-lua; charset=utf-8"],
  [".swift", "text/x-swift; charset=utf-8"],
  [".kt", "text/x-kotlin; charset=utf-8"],
  [".kts", "text/x-kotlin; charset=utf-8"],
  [".scala", "text/x-scala; charset=utf-8"],
  [".sql", "text/x-sql; charset=utf-8"],
  [".r", "text/x-r; charset=utf-8"],
  [".dart", "text/x-dart; charset=utf-8"],
  [".vue", "text/plain; charset=utf-8"],
  [".svelte", "text/plain; charset=utf-8"],
  [".toml", "application/toml; charset=utf-8"],
  [".ini", "text/plain; charset=utf-8"],
  [".conf", "text/plain; charset=utf-8"],
  [".env", "text/plain; charset=utf-8"],
  [".properties", "text/plain; charset=utf-8"],
  [".gradle", "text/plain; charset=utf-8"],
  [".graphql", "text/plain; charset=utf-8"],
  [".gql", "text/plain; charset=utf-8"],
  [".proto", "text/plain; charset=utf-8"],
  [".tf", "text/plain; charset=utf-8"],
  [".tfvars", "text/plain; charset=utf-8"],
  [".diff", "text/x-diff; charset=utf-8"],
  [".patch", "text/x-diff; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".svg", "image/svg+xml"],
  [".pdf", "application/pdf"],
]);

const extensionlessTextFiles = new Set([
  "dockerfile",
  "makefile",
  "gnumakefile",
  "cmakelists.txt",
  "jenkinsfile",
  "procfile",
  "gemfile",
  "rakefile",
  ".gitignore",
  ".dockerignore",
  ".editorconfig",
]);

function looksLikeText(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.byteLength, 8192));
  if (sample.includes(0)) return false;
  let controlCharacters = 0;
  for (const value of sample) {
    if (value < 32 && value !== 9 && value !== 10 && value !== 13) controlCharacters += 1;
  }
  return sample.byteLength === 0 || controlCharacters / sample.byteLength < 0.02;
}

function mediaTypeFor(filePath: string, content: Buffer): string {
  const extensionType = mediaTypes.get(path.extname(filePath).toLowerCase());
  if (extensionType) return extensionType;
  if (extensionlessTextFiles.has(path.basename(filePath).toLowerCase()) || content.subarray(0, 2).toString() === "#!") {
    return "text/plain; charset=utf-8";
  }
  return looksLikeText(content) ? "text/plain; charset=utf-8" : "application/octet-stream";
}

function stripUrlSuffix(value: string): string {
  const suffixIndex = value.search(/[?#]/u);
  return suffixIndex < 0 ? value : value.slice(0, suffixIndex);
}

function decodeFileReference(value: string): string {
  const candidate = value.trim();
  if (/^file:/iu.test(candidate)) return fileURLToPath(new URL(candidate));
  const withoutSuffix = stripUrlSuffix(candidate);
  try {
    return decodeURIComponent(withoutSuffix);
  } catch {
    return withoutSuffix;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isForbiddenPath(candidate: string): boolean {
  if (process.platform === "win32") {
    const normalized = candidate.toLowerCase();
    return normalized.startsWith("\\\\.\\") || normalized.startsWith("\\\\?\\globalroot\\");
  }
  return ["/proc", "/sys", "/dev"].some((root) => isWithin(root, candidate));
}

function failure(errorCode: WorkspaceFileReadErrorCode, error: string): WorkspaceFileReadResult {
  return { ok: false, errorCode, error };
}

export function readWorkspaceFile(input: WorkspaceFileReadInput): WorkspaceFileReadResult {
  const rawPath = input.requestedPath.trim();
  if (!rawPath || rawPath.length > 4096 || rawPath.includes("\0")) return failure("forbidden", "文件路径无效");
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0 || input.maxBytes > 8 * 1024 * 1024) {
    return failure("forbidden", "文件大小限制无效");
  }

  try {
    const requestedPath = decodeFileReference(rawPath);
    const baseDirectory = input.basePath ? path.dirname(input.basePath) : input.workspacePath;
    const candidate = path.isAbsolute(requestedPath)
      ? requestedPath
      : path.resolve(baseDirectory, requestedPath);
    if (isForbiddenPath(candidate)) return failure("forbidden", "不允许访问系统设备或虚拟文件目录");

    const canonicalPath = realpathSync(candidate);
    if (isForbiddenPath(canonicalPath)) return failure("forbidden", "不允许访问系统设备或虚拟文件目录");
    const stats = statSync(canonicalPath);
    if (!stats.isFile()) return failure("not_file", "目标路径不是普通文件");
    if (stats.size > input.maxBytes) return failure("too_large", `文件超过 ${input.maxBytes} 字节的预览限制`);
    accessSync(canonicalPath, constants.R_OK);
    const content = readFileSync(canonicalPath);
    if (content.byteLength > input.maxBytes) return failure("too_large", `文件超过 ${input.maxBytes} 字节的预览限制`);
    return {
      ok: true,
      path: canonicalPath,
      name: path.basename(canonicalPath),
      mediaType: mediaTypeFor(canonicalPath, content),
      size: content.byteLength,
      contentBase64: content.toString("base64"),
    };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return failure("not_found", "文件不存在");
    if (code === "EACCES" || code === "EPERM") return failure("forbidden", "Agent 运行用户没有读取该文件的权限");
    return failure("read_failed", error instanceof Error ? error.message : "读取文件失败");
  }
}
