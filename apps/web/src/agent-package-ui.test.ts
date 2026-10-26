import { describe, expect, it } from "vitest";
import { macOSPackageVerification, selectAgentPackage } from "./agent-package-ui";
import type { AgentPackageInfo } from "./types";

const linux: AgentPackageInfo = {
  available: true, target: "linux-x64-glibc", version: "0.3.16",
  fileName: "controller-center-agent-v0.3.16-linux-x64-glibc.tar.gz", size: 100, sha256: "test", builtAt: null,
};

describe("Agent download selection", () => {
  it("limits macOS verification and its scope to the accepted artifacts", () => {
    const legacy = { ...linux, target: "darwin-arm64", version: "0.3.19",
      sha256: "d4a9981ea1ab7c0fd391ed0570e1b33f058d541018727ed41469f5628620d852" };
    const current = { ...linux, target: "darwin-arm64", version: "0.3.22",
      sha256: "3988ed0d267a4e47cd7c77eb5557a8dffcd5c0e79d73e6fe2e427d66baad22ed" };
    expect(macOSPackageVerification(legacy)?.label).toBe("macOS 直连下载已实机验证");
    expect(macOSPackageVerification(current)).toMatchObject({ label: "macOS 已实机测试", title: expect.stringContaining("2026-10-26") });
    for (const accepted of [legacy, current]) {
      expect(macOSPackageVerification({ ...accepted, sha256: "rebuilt" })).toBeNull();
      expect(macOSPackageVerification({ ...accepted, version: "0.3.23" })).toBeNull();
      expect(macOSPackageVerification({ ...accepted, target: "darwin-x64" })).toBeNull();
      expect(macOSPackageVerification({ ...accepted, target: "linux-arm64-glibc" })).toBeNull();
    }
  });
  it("requires explicit selection even when the only package is Linux", () => {
    const info = { ...linux, packages: [linux] };
    expect(selectAgentPackage(info, "")).toBeNull();
    expect(selectAgentPackage(info, "darwin-arm64")).toBeNull();
    expect(selectAgentPackage(info, "linux-x64-glibc")).toBe(linux);
  });
  it("chooses the exact macOS artifact rather than the default Linux descriptor", () => {
    const macOS = { ...linux, target: "darwin-arm64", fileName: "controller-center-agent-v0.3.16-darwin-arm64.tar.gz" };
    expect(selectAgentPackage({ ...linux, packages: [linux, macOS] }, "darwin-arm64")).toBe(macOS);
  });
  it("keeps old portable downloads usable without inventing a platform target", () => {
    const { target: _target, ...legacy } = linux;
    expect(selectAgentPackage(legacy, "")).toBe(legacy);
  });
});
