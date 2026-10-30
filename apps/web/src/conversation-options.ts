import type { GlobalSettings, NodeRecord, ReasoningEffort } from "./types";

export function supportsFastMode(node: NodeRecord | null, modelId: string): boolean {
  const model = modelId ? node?.models.find((candidate) => candidate.id === modelId) : node?.models.find((candidate) => candidate.isDefault);
  return Boolean(node?.capabilities?.includes("fast_mode_v1") && model?.supportsFastMode);
}

/** The new-conversation defaults configured for a node's runtime. */
export function runtimeDefaults(settings: GlobalSettings, runtime: NodeRecord["runtime"] | undefined): { model: string | null; effort: ReasoningEffort | null } {
  return runtime === "claude"
    ? { model: settings.claudeDefaultModel ?? null, effort: settings.claudeDefaultEffort ?? null }
    : { model: settings.defaultModel, effort: settings.defaultEffort };
}

/** Display name of the local CLI a node drives. */
export function runtimeLabel(node: Pick<NodeRecord, "runtime">): "Codex" | "Claude" {
  return node.runtime === "claude" ? "Claude" : "Codex";
}
