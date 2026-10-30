import { describe, expect, it } from "vitest";
import { groupNodeMachines, machineRuntimeLabels, mergeMachineWorkspaces } from "./node-machines";
import type { NodeRecord, Workspace } from "./types";

function entry(id: string, machineId: string, runtime: NodeRecord["runtime"]): NodeRecord {
  return { id, machineId, runtime, name: id } as NodeRecord;
}

describe("node machines", () => {
  it("groups runtime entries by machine in list order and names each machine by its Codex entry", () => {
    const machines = groupNodeMachines([
      entry("build-claude", "build", "claude"),
      entry("laptop", "laptop", "codex"),
      entry("build", "build", "codex"),
    ]);
    expect(machines.map((machine) => [machine.id, machine.primary.id, machine.entries.map((node) => node.id)])).toEqual([
      ["build", "build", ["build", "build-claude"]],
      ["laptop", "laptop", ["laptop"]],
    ]);
    expect(machineRuntimeLabels(machines[0]!)).toBe("Codex、Claude");
  });

  it("names a Claude-only machine by its Claude entry", () => {
    const [machine] = groupNodeMachines([entry("studio-claude", "studio", "claude")]);
    expect(machine?.primary.id).toBe("studio-claude");
    expect(machineRuntimeLabels(machine!)).toBe("Claude");
  });

  it("lists a Web workspace once per machine and keeps each runtime's startup directory", () => {
    const codex = { ...entry("build", "build", "codex"), status: "offline" } as NodeRecord;
    const claude = { ...entry("build-claude", "build", "claude"), status: "online" } as NodeRecord;
    const workspace = (id: string, source: Workspace["source"], conversationCount: number, name = id) =>
      ({ id, name, source, isDefault: source === "default", archivedAt: null, conversationCount }) as Workspace;
    const merged = mergeMachineWorkspaces([
      { node: codex, workspaces: [workspace("repo", "default", 2), workspace("shared", "web", 3)] },
      { node: claude, workspaces: [workspace("repo", "default", 1), workspace("notes", "default", 0), workspace("shared", "web", 3)] },
    ]);
    expect(merged.map((item) => [item.key, item.workspace.conversationCount, item.nodes.map((node) => node.id)])).toEqual([
      ["default:notes", 0, ["build-claude"]],
      ["default:repo", 3, ["build-claude", "build"]],
      ["web:shared", 3, ["build-claude", "build"]],
    ]);
  });
});
