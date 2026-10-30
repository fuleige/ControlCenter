import { runtimeLabel } from "./conversation-options";
import type { NodeRecord, Workspace } from "./types";

/** The runtime entries started from one Agent data directory; access is managed per machine. */
export interface NodeMachine {
  id: string;
  /** Names the machine: its Codex entry when present, otherwise its first entry. */
  primary: NodeRecord;
  entries: NodeRecord[];
}

export function groupNodeMachines(nodes: NodeRecord[]): NodeMachine[] {
  const machines = new Map<string, NodeRecord[]>();
  for (const node of nodes) machines.set(node.machineId, [...(machines.get(node.machineId) ?? []), node]);
  return [...machines].map(([id, entries]) => {
    const ordered = [...entries].sort((left, right) => Number(left.runtime !== "codex") - Number(right.runtime !== "codex"));
    return { id, primary: ordered[0]!, entries: ordered };
  });
}

/** "Codex、Claude" for the runtimes running on a machine. */
export function machineRuntimeLabels(machine: NodeMachine): string {
  return machine.entries.map(runtimeLabel).join("、");
}

/**
 * A workspace as its machine lists it. Web workspaces are shared by the machine's
 * runtimes; a startup directory belongs to the runtimes started in it.
 */
export interface MachineWorkspace {
  key: string;
  /** The copy reported by a connected runtime when there is one. */
  workspace: Workspace;
  /** Entries listing it, connected ones first; changes go through the first. */
  nodes: NodeRecord[];
}

export function mergeMachineWorkspaces(lists: Array<{ node: NodeRecord; workspaces: Workspace[] }>): MachineWorkspace[] {
  const merged = new Map<string, MachineWorkspace>();
  for (const { node, workspaces } of lists) for (const workspace of workspaces) {
    const key = `${workspace.source}:${workspace.id}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { key, workspace, nodes: [node] });
      continue;
    }
    // A Web workspace's count already covers the machine; other copies count their own runtime.
    const conversationCount = workspace.source === "web"
      ? existing.workspace.conversationCount
      : existing.workspace.conversationCount + workspace.conversationCount;
    const preferNew = node.status === "online" && existing.nodes[0]!.status !== "online";
    existing.workspace = { ...(preferNew ? workspace : existing.workspace), conversationCount };
    existing.nodes = preferNew ? [node, ...existing.nodes] : [...existing.nodes, node];
  }
  return [...merged.values()].sort((left, right) =>
    Number(right.workspace.isDefault) - Number(left.workspace.isDefault)
    || Number(Boolean(left.workspace.archivedAt)) - Number(Boolean(right.workspace.archivedAt))
    || left.workspace.name.localeCompare(right.workspace.name));
}
