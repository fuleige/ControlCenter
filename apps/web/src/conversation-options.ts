import type { NodeRecord } from "./types";

export function supportsFastMode(node: NodeRecord | null, modelId: string): boolean {
  const model = modelId ? node?.models.find((candidate) => candidate.id === modelId) : node?.models.find((candidate) => candidate.isDefault);
  return Boolean(node?.capabilities?.includes("fast_mode_v1") && model?.supportsFastMode);
}
