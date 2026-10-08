import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentPackageVersion, assertAgentPackageRuntime } from "./package-runtime.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function metadata(target?: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "controller-center-package-runtime-"));
  directories.push(directory);
  const file = path.join(directory, "BUILD-INFO.json");
  writeFileSync(file, JSON.stringify({ target }));
  return file;
}

describe("standalone Agent compatibility", () => {
  it("reports the package version across independent releases and rejects missing versions", () => {
    const file = metadata("linux-x64-glibc");
    writeFileSync(file, JSON.stringify({ version: "0.3.18" }));
    expect(agentPackageVersion(file)).toBe("0.3.18");
    writeFileSync(file, JSON.stringify({ version: "0.4.1" }));
    expect(agentPackageVersion(file)).toBe("0.4.1");
    writeFileSync(file, JSON.stringify({ version: null }));
    expect(() => agentPackageVersion(file)).toThrow(/缺少有效版本/);
  });
  it("rejects the Linux package on Apple Silicon before enrollment or startup", () => {
    expect(() => assertAgentPackageRuntime(metadata("linux-x64-glibc"), { target: "darwin-arm64", nodeMajor: 24 }))
      .toThrow(/安装包目标为 linux-x64-glibc.*当前运行环境为 darwin-arm64.*请下载 darwin-arm64/);
  });
  it("rejects the wrong CPU, libc and Node.js major", () => {
    const macOS = metadata("darwin-arm64");
    expect(() => assertAgentPackageRuntime(macOS, { target: "darwin-x64", nodeMajor: 24 })).toThrow(/darwin-x64/);
    expect(() => assertAgentPackageRuntime(metadata("linux-x64-glibc"), { target: "linux-x64-musl", nodeMajor: 24 })).toThrow(/linux-x64-musl/);
    expect(() => assertAgentPackageRuntime(macOS, { target: "darwin-arm64", nodeMajor: 25 })).toThrow(/需要 Node.js 24.x/);
  });
  it("allows matching targets and source checkouts without build metadata", () => {
    const file = metadata("darwin-arm64");
    expect(() => assertAgentPackageRuntime(file, { target: "darwin-arm64", nodeMajor: 24 })).not.toThrow();
    expect(() => assertAgentPackageRuntime(file + ".missing", { target: "darwin-arm64", nodeMajor: 24 })).not.toThrow();
  });
  it("rejects damaged build metadata", () => {
    const file = metadata("darwin-arm64");
    writeFileSync(file, "{");
    expect(() => assertAgentPackageRuntime(file, { target: "darwin-arm64", nodeMajor: 24 })).toThrow(/无法读取安装包/);
  });
});
