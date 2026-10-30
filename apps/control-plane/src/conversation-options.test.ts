import { describe, expect, it } from "vitest";
import { fastModeError } from "./conversation-options.js";

const models = [
  { id: "default", displayName: "Default", isDefault: true, supportedReasoningEfforts: [], supportsFastMode: true },
  { id: "plain", displayName: "Plain", isDefault: false, supportedReasoningEfforts: [] },
];

describe("conversation Fast compatibility", () => {
  it("allows old requests and disabling Fast on old nodes", () => {
    expect(fastModeError(undefined, false, [], null)).toBeNull();
    expect(fastModeError(false, false, [], null)).toBeNull();
    expect(fastModeError("false", true, models, null)).toContain("布尔值");
    expect(fastModeError(null, true, models, null)).toContain("布尔值");
  });

  it("requires both node capability and the selected model's catalog support", () => {
    expect(fastModeError(true, false, models, "default")).toContain("升级");
    expect(fastModeError(true, true, models, "plain")).toBe("当前模型或 Codex 账户不支持 Fast 模式");
    expect(fastModeError(true, true, models, "plain", "claude")).toBe("当前模型或 Claude 账户不支持 Fast 模式");
    expect(fastModeError(true, true, models, "missing")).toContain("不支持");
    expect(fastModeError(true, true, models, null)).toBeNull();
    expect(fastModeError(true, true, models, "default")).toBeNull();
  });
});
