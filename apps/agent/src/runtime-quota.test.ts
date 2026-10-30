import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { AppServerRpcError } from "./app-server-client.js";
import type { RuntimeClient } from "./claude-code-client.js";
import { quotaErrorMessage, readRuntimeQuota, resetRuntimeQuota } from "./runtime-quota.js";

function fakeClient(responses: Record<string, unknown>) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client = Object.assign(new EventEmitter(), {
    start: async () => {},
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (!(method in responses)) throw new AppServerRpcError(`unexpected ${method}`, -32601, null);
      return responses[method];
    },
    respond: () => {},
    respondError: () => {},
    close: () => {},
  }) as unknown as RuntimeClient;
  return { client, calls };
}

describe("runtime quota", () => {
  it("reads a ChatGPT account's rate limits with reset-credit details", async () => {
    // A real plan that reports only a weekly window, in the primary slot.
    const rateLimits = {
      ordinaryUsageAllowed: true,
      rateLimits: { limitId: "codex", primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1793774135 }, secondary: null },
      rateLimitsByLimitId: null,
    };
    const { client, calls } = fakeClient({
      "account/read": { account: { type: "chatgpt", email: "dev@example.com", planType: "prolite" }, requiresOpenaiAuth: true },
      "account/rateLimits/read": rateLimits,
    });
    await expect(readRuntimeQuota("codex", client)).resolves.toEqual({
      runtime: "codex",
      account: { type: "chatgpt", email: "dev@example.com", planType: "prolite" },
      rateLimits,
    });
    expect(calls[1]).toEqual({ method: "account/rateLimits/read", params: { excludeResetCreditDetails: false } });
  });

  it("does not ask an API key login for plan limits", async () => {
    const { client, calls } = fakeClient({ "account/read": { account: { type: "apiKey" }, requiresOpenaiAuth: true } });
    await expect(readRuntimeQuota("codex", client)).resolves.toEqual({ runtime: "codex", account: { type: "apiKey" }, rateLimits: null });
    expect(calls.map((call) => call.method)).toEqual(["account/read"]);
  });

  it("reports a Codex node that is not logged in as a failure", async () => {
    const { client } = fakeClient({ "account/read": { account: null, requiresOpenaiAuth: true } });
    await expect(readRuntimeQuota("codex", client)).rejects.toThrow("尚未登录");
  });

  it("keeps Claude's account and non-empty limit buckets but not the probe session", async () => {
    const { client } = fakeClient({
      "claude/usage/read": {
        account: { email: "dev@example.com", subscriptionType: "Claude Pro", apiProvider: "firstParty" },
        usage: {
          session: { total_cost_usd: 0 },
          subscription_type: "pro",
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 3, resets_at: "2026-10-30T12:40:00Z" },
            seven_day_opus: null,
            tangelo: null,
            limits: [{ kind: "session", group: "session", percent: 3, resets_at: "2026-10-30T12:40:00Z", severity: "normal" }],
          },
          behaviors: null,
        },
      },
    });
    await expect(readRuntimeQuota("claude", client)).resolves.toEqual({
      runtime: "claude",
      account: { email: "dev@example.com", subscriptionType: "Claude Pro", apiProvider: "firstParty" },
      usage: {
        subscription_type: "pro",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 3, resets_at: "2026-10-30T12:40:00Z" },
          limits: [{ kind: "session", group: "session", percent: 3, resets_at: "2026-10-30T12:40:00Z", severity: "normal" }],
        },
      },
    });
  });

  it("redeems exactly the picked credit under the given idempotency key", async () => {
    const { client, calls } = fakeClient({ "account/rateLimitResetCredit/consume": { outcome: "reset" } });
    await expect(resetRuntimeQuota("codex", client, "attempt-1", "credit-1")).resolves.toBe("reset");
    expect(calls).toEqual([{ method: "account/rateLimitResetCredit/consume", params: { idempotencyKey: "attempt-1", creditId: "credit-1" } }]);
    await expect(resetRuntimeQuota("claude", client, "attempt-2", "credit-1")).rejects.toThrow("只有 Codex");
    expect(calls).toHaveLength(1);
    const { client: silent } = fakeClient({ "account/rateLimitResetCredit/consume": {} });
    await expect(resetRuntimeQuota("codex", silent, "attempt-3", "credit-1")).rejects.toThrow("未返回额度重置结果");
  });

  it("explains runtimes too old to report quota", () => {
    expect(quotaErrorMessage("codex", new AppServerRpcError("unknown variant `account/rateLimitResetCredit/consume`", -32600, null), "额度重置"))
      .toBe("当前节点的 Codex 版本不支持额度重置，请升级 Codex");
    expect(quotaErrorMessage("codex", new AppServerRpcError("Invalid request: unknown variant `account/rateLimits/read`", -32600, null)))
      .toBe("当前节点的 Codex 版本不支持额度查询，请升级 Codex");
    expect(quotaErrorMessage("claude", new Error("Unsupported control request subtype: get_usage")))
      .toBe("当前节点的 Claude Code 版本不支持额度查询，请升级 Claude Code");
    expect(quotaErrorMessage("claude", new Error("Claude Code usage read timed out"))).toBe("Claude Code 额度查询超时，请稍后重试");
    expect(quotaErrorMessage("codex", new Error("network unreachable"))).toBe("network unreachable");
  });
});
