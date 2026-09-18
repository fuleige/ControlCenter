import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkspaceFile } from "./workspace-files.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "controller-center-workspace-file-"));
  directories.push(root);
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  mkdirSync(path.join(workspace, "docs"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(workspace, "docs", "report.md"), "# Report\n\n[next](next.tsv)");
  writeFileSync(path.join(workspace, "docs", "next.tsv"), "name\tvalue\nalpha\t1\n");
  writeFileSync(path.join(outside, "absolute.txt"), "outside workspace");
  writeFileSync(path.join(workspace, "script.py"), "print('hello')\n");
  writeFileSync(path.join(workspace, "Dockerfile"), "FROM node:24\n");
  return { workspace, outside };
}

describe("Agent workspace file reader", () => {
  it("reads relative paths and resolves nested links from an opened file", () => {
    const { workspace } = fixture();
    const markdown = readWorkspaceFile({ workspacePath: workspace, requestedPath: "docs/report.md", maxBytes: 1024 });
    expect(markdown).toMatchObject({ ok: true, name: "report.md", mediaType: "text/markdown; charset=utf-8" });
    if (!markdown.ok) return;

    const nested = readWorkspaceFile({
      workspacePath: workspace,
      requestedPath: "next.tsv",
      basePath: markdown.path,
      maxBytes: 1024,
    });
    expect(nested).toMatchObject({ ok: true, name: "next.tsv", mediaType: "text/tab-separated-values; charset=utf-8" });
  });

  it("allows explicit absolute paths outside the workspace", () => {
    const { workspace, outside } = fixture();
    const result = readWorkspaceFile({
      workspacePath: workspace,
      requestedPath: path.join(outside, "absolute.txt"),
      maxBytes: 1024,
    });
    expect(result).toMatchObject({ ok: true, name: "absolute.txt" });
    if (result.ok) expect(Buffer.from(result.contentBase64, "base64").toString()).toBe("outside workspace");
  });

  it("recognizes common scripts and extensionless build files as text", () => {
    const { workspace } = fixture();
    expect(readWorkspaceFile({ workspacePath: workspace, requestedPath: "script.py", maxBytes: 1024 })).toMatchObject({
      ok: true,
      mediaType: "text/x-python; charset=utf-8",
    });
    expect(readWorkspaceFile({ workspacePath: workspace, requestedPath: "Dockerfile", maxBytes: 1024 })).toMatchObject({
      ok: true,
      mediaType: "text/plain; charset=utf-8",
    });
  });

  it("rejects directories, oversized files, and virtual device paths", () => {
    const { workspace } = fixture();
    expect(readWorkspaceFile({ workspacePath: workspace, requestedPath: "docs", maxBytes: 1024 })).toMatchObject({ ok: false, errorCode: "not_file" });
    expect(readWorkspaceFile({ workspacePath: workspace, requestedPath: "docs/report.md", maxBytes: 2 })).toMatchObject({ ok: false, errorCode: "too_large" });
    if (process.platform !== "win32") {
      expect(readWorkspaceFile({ workspacePath: workspace, requestedPath: "/proc/version", maxBytes: 1024 })).toMatchObject({ ok: false, errorCode: "forbidden" });
    }
  });
});
