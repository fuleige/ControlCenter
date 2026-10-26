import { isRecord, type ModelDescriptor, type ReasoningEffort } from "@controller-center/protocol";

const efforts = new Set<ReasoningEffort>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const MODEL_CACHE_SCHEMA_VERSION = 2;

function fastTierId(value: unknown): "fast" | "priority" | undefined {
  return value === "fast" || value === "priority" ? value : undefined;
}

export function parseModelCatalog(result: { data?: unknown[] }): ModelDescriptor[] {
  if (!Array.isArray(result.data)) return [];
  return result.data.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = typeof entry.id === "string" ? entry.id : typeof entry.model === "string" ? entry.model : "";
    if (!id) return [];
    const supportedReasoningEfforts = Array.isArray(entry.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts.flatMap((option) => {
          if (!isRecord(option) || typeof option.reasoningEffort !== "string" || !efforts.has(option.reasoningEffort as ReasoningEffort)) return [];
          return [{
            reasoningEffort: option.reasoningEffort as ReasoningEffort,
            ...(typeof option.description === "string" ? { description: option.description } : {}),
          }];
        })
      : [];
    const defaultReasoningEffort = typeof entry.defaultReasoningEffort === "string" && efforts.has(entry.defaultReasoningEffort as ReasoningEffort)
      ? entry.defaultReasoningEffort as ReasoningEffort : undefined;
    // Codex 0.163 calls the Fast tier "priority". Preserve the catalog's wire id;
    // older catalogs advertise the "fast" alias through additionalSpeedTiers.
    const fastServiceTier = Array.isArray(entry.serviceTiers)
      ? entry.serviceTiers.flatMap((tier) => isRecord(tier) && fastTierId(tier.id) ? [fastTierId(tier.id)!] : [])[0]
      : Array.isArray(entry.additionalSpeedTiers)
        ? entry.additionalSpeedTiers.includes("fast") ? "fast" : undefined
        : entry.supportsFastMode === true ? fastTierId(entry.fastServiceTier) ?? "fast" : undefined;
    return [{
      id,
      displayName: typeof entry.displayName === "string" ? entry.displayName : id,
      isDefault: entry.isDefault === true,
      supportedReasoningEfforts,
      supportsFastMode: fastServiceTier !== undefined,
      ...(fastServiceTier ? { fastServiceTier } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    }];
  });
}

export function parseCachedModelCatalog(value: unknown, codexVersion: string): { models: ModelDescriptor[]; fetchedAt: string } | null {
  // Invalidate v0.3.20 caches: they may have persisted a false Fast rejection.
  if (!isRecord(value) || value.schemaVersion !== MODEL_CACHE_SCHEMA_VERSION
    || value.codexVersion !== codexVersion || typeof value.fetchedAt !== "string" || !Array.isArray(value.models)
    || value.models.some((model) => !isRecord(model) || typeof model.supportsFastMode !== "boolean"
      || model.supportsFastMode && !fastTierId(model.fastServiceTier))) return null;
  return { models: parseModelCatalog({ data: value.models }), fetchedAt: value.fetchedAt };
}

export function turnServiceTier(fastMode: boolean | undefined, model: ModelDescriptor | undefined): { serviceTier?: string } {
  if (fastMode === true && !model?.supportsFastMode) throw new Error("当前模型或 Codex 账户不支持 Fast 模式");
  // Omission preserves older nodes' local configuration. Explicit off must reset
  // a thread that previously used Fast rather than inheriting its service tier.
  return fastMode === undefined ? {} : { serviceTier: fastMode ? model?.fastServiceTier ?? "fast" : "default" };
}
