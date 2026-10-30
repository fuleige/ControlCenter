import { createHash } from "node:crypto";
import type { AgentRuntime } from "./index.js";

/**
 * Node-list identity of one runtime on a machine. Codex keeps the machine
 * identity itself, so nodes registered before runtimes were selectable keep
 * their id; every other runtime gets a stable name-based UUID (RFC 9562
 * version 5 layout) derived from it. Node-only: the Web bundle never needs it.
 */
export function runtimeNodeId(machineId: string, runtime: AgentRuntime): string {
  if (runtime === "codex") return machineId;
  const bytes = createHash("sha1").update(`controller-center:${machineId}:${runtime}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
