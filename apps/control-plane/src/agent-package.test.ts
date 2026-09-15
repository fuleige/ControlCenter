import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findAgentPackage } from "./agent-package.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Agent package discovery", () => {
  it("returns download metadata only for the requested version", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "controller-center-agent-package-test-"));
    temporaryDirectories.push(directory);
    const fileName = "controller-center-agent-v0.3.5.tar.gz";
    writeFileSync(path.join(directory, fileName), "portable-agent-package");

    expect(findAgentPackage(directory, "0.3.5")).toMatchObject({
      version: "0.3.5",
      fileName,
      size: 22,
      sha256: "cb9bd8bd4ff984ee13b78a4f9b1ff9a72b950ed2a468d69e20fc0abe1bda2aa6",
    });
    expect(findAgentPackage(directory, "0.3.3")).toBeNull();
    expect(findAgentPackage(directory, "../secret")).toBeNull();
  });
});
