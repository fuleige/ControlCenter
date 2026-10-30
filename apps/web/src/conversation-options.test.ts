import { describe, expect, it } from "vitest";
import { runtimeDefaults, runtimeLabel } from "./conversation-options";

describe("node runtime label", () => {
  it("names the CLI the node reports", () => {
    expect(runtimeLabel({ runtime: "claude" })).toBe("Claude");
    expect(runtimeLabel({ runtime: "codex" })).toBe("Codex");
  });
});

describe("runtime conversation defaults", () => {
  it("reads the defaults configured for the node's runtime", () => {
    const settings = { defaultModel: "gpt-6-astra", defaultEffort: "high", claudeDefaultModel: "opus", claudeDefaultEffort: "xhigh" } as const;
    expect(runtimeDefaults(settings, "codex")).toEqual({ model: "gpt-6-astra", effort: "high" });
    expect(runtimeDefaults(settings, "claude")).toEqual({ model: "opus", effort: "xhigh" });
    expect(runtimeDefaults(settings, undefined)).toEqual({ model: "gpt-6-astra", effort: "high" });
  });
});
