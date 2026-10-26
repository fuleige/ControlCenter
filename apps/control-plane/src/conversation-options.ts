import type { ModelDescriptor } from "@controller-center/protocol";

export function fastModeError(fastMode: unknown, supported: boolean, models: ModelDescriptor[], modelId: string | null): string | null {
  if (fastMode !== undefined && typeof fastMode !== "boolean") return "Fast 模式必须为布尔值";
  if (!fastMode) return null;
  if (!supported) return "当前节点尚不支持 Fast 模式，请先升级该节点的 Agent 和支持 Fast 的 Codex";
  const model = modelId ? models.find((candidate) => candidate.id === modelId) : models.find((candidate) => candidate.isDefault);
  return model?.supportsFastMode ? null : "当前模型或 Codex 账户不支持 Fast 模式";
}
