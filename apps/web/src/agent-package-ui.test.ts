import { describe, expect, it } from "vitest";
import { selectAgentPackage } from "./agent-package-ui";
import type { AgentPackageInfo } from "./types";

const linux: AgentPackageInfo = {
  available: true, target: "linux-x64-glibc", version: "0.3.16",
  fileName: "controller-center-agent-v0.3.16-linux-x64-glibc.tar.gz", size: 100, sha256: "test", builtAt: null,
};

describe("Agent download selection", () => {
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
