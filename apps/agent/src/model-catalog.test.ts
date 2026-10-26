import { describe, expect, it } from "vitest";
import { MODEL_CACHE_SCHEMA_VERSION, parseCachedModelCatalog, parseModelCatalog, turnServiceTier } from "./model-catalog.js";

describe("Fast mode", () => {
  it("discovers current, legacy, and cached catalogs without inventing model support", () => {
    const models = parseModelCatalog({ data: [
      { id: "current", serviceTiers: [{ id: "fast" }] },
      { id: "legacy", additionalSpeedTiers: ["fast"] },
      { id: "plain", serviceTiers: [] },
      { id: "uncatalogued" },
      { id: "removed", serviceTiers: [], additionalSpeedTiers: ["fast"] },
    ] });
    expect(models.map((model) => model.supportsFastMode)).toEqual([true, true, false, false, false]);
    expect(parseModelCatalog({ data: models })).toEqual(models);
    expect(turnServiceTier(true, models[0])).toEqual({ serviceTier: "fast" });
  });

  it("explicitly restores standard speed while leaving older requests untouched", () => {
    expect(turnServiceTier(false, undefined)).toEqual({ serviceTier: "default" });
    expect(turnServiceTier(undefined, undefined)).toEqual({});
    expect(() => turnServiceTier(true, undefined)).toThrow("不支持 Fast");
    expect(() => turnServiceTier(true, parseModelCatalog({ data: [{ id: "plain" }] })[0])).toThrow("不支持 Fast");
  });

  it("recognizes the real Codex 0.163 catalog and sends its priority wire id", () => {
    const models = parseModelCatalog({ data: [{
      id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true,
      serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }],
      additionalSpeedTiers: ["fast"],
    }, { id: "other", serviceTiers: [{ id: "flex" }, { id: "ultrafast" }] }] });
    expect(models[0]).toMatchObject({ supportsFastMode: true, fastServiceTier: "priority" });
    expect(models[1]?.supportsFastMode).toBe(false);
    expect(turnServiceTier(true, models[0])).toEqual({ serviceTier: "priority" });
    expect(parseModelCatalog({ data: models })).toEqual(models);
  });

  it("refreshes v0.3.20 caches rather than keeping the false rejection for 24 hours", () => {
    const cached = { codexVersion: "codex-cli 0.163.0", fetchedAt: "2026-10-20T06:18:44.407Z",
      models: [{ id: "gpt-6.1-sol", supportsFastMode: false }] };
    expect(parseCachedModelCatalog(cached, cached.codexVersion)).toBeNull();
    const models = parseModelCatalog({ data: [{ id: "gpt-6.1-sol", serviceTiers: [{ id: "priority", name: "Fast" }] }] });
    const current = { ...cached, schemaVersion: MODEL_CACHE_SCHEMA_VERSION, models };
    expect(parseCachedModelCatalog(current, cached.codexVersion)?.models).toEqual(models);
    expect(parseCachedModelCatalog(current, "codex-cli 0.161.0")).toBeNull();
  });
});
