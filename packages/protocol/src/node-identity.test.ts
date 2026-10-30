import { describe, expect, it } from "vitest";
import { runtimeNodeId } from "./node-identity.js";

describe("runtime node identity", () => {
  const machineId = "2b0ebc97-1ac2-4d1f-a435-2b748ce76ecf";

  it("keeps the machine identity for Codex so existing nodes are unchanged", () => {
    expect(runtimeNodeId(machineId, "codex")).toBe(machineId);
  });

  it("derives a stable, distinct UUID for Claude on the same machine", () => {
    const claude = runtimeNodeId(machineId, "claude");
    expect(claude).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(claude).not.toBe(machineId);
    expect(runtimeNodeId(machineId, "claude")).toBe(claude);
    expect(runtimeNodeId("c70a311c-fc55-4072-93cc-339a3323d6bc", "claude")).not.toBe(claude);
  });
});
