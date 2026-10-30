import { describe, expect, it } from "vitest";
import { codexWindowLabel, resetDistance, resetOutcomeText, summarizeQuota } from "./node-quota";

describe("node quota summary", () => {
  it("names Codex windows by duration, even a weekly window in the primary slot", () => {
    const summary = summarizeQuota({
      runtime: "codex",
      account: { type: "chatgpt", email: "dev@example.com", planType: "prolite" },
      rateLimits: {
        ordinaryUsageAllowed: true,
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1793774135 },
          secondary: null,
          credits: { hasCredits: false, unlimited: false, balance: "0" },
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: { codex: {
          limitId: "codex",
          primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1793774135 },
          secondary: null,
        } },
        rateLimitResetCredits: { availableCount: 0, credits: null },
      },
    });
    expect(summary).toMatchObject({ email: "dev@example.com", plan: "prolite", notApplicable: null });
    expect(summary.meters).toEqual([{
      key: "codex:primary", label: "每周", percent: 40, resetsAt: new Date(1793774135 * 1000).toISOString(), severity: "normal",
    }]);
    expect(summary.notes).toEqual([{ text: "Credits 余额：0" }]);
  });

  it("orders Codex windows by length and prefixes extra model buckets", () => {
    const summary = summarizeQuota({
      runtime: "codex",
      account: { type: "chatgpt", planType: "pro" },
      rateLimits: {
        ordinaryUsageAllowed: false,
        rateLimits: { limitId: "codex", rateLimitReachedType: "rate_limit_reached" },
        rateLimitsByLimitId: {
          codex: {
            primary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: null },
            secondary: { usedPercent: 95, windowDurationMins: 300, resetsAt: null },
          },
          spark: { limitName: "GPT Spark", primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: null }, secondary: null },
        },
      },
    });
    expect(summary.meters.map((meter) => [meter.label, meter.severity])).toEqual([
      ["5 小时", "critical"],
      ["每周", "normal"],
      ["GPT Spark · 5 小时", "warning"],
    ]);
    expect(summary.notes).toEqual([{ text: "普通额度当前不可用", warning: true }, { text: "已达到额度上限", warning: true }]);
  });

  it("lists Codex reset credits soonest-expiring first and keeps count-only answers", () => {
    const base = { runtime: "codex" as const, account: { type: "chatgpt", planType: "pro" } };
    const summary = summarizeQuota({ ...base, rateLimits: { rateLimits: {}, rateLimitResetCredits: { availableCount: 3, credits: [
      { id: "never", resetType: "codexRateLimits", status: "available", grantedAt: 1793000000, expiresAt: null, title: null, description: null },
      { id: "later", resetType: "codexRateLimits", status: "available", grantedAt: 1793000000, expiresAt: 1795000000, title: "额度重置", description: "任务奖励" },
      { id: "soon", resetType: "codexRateLimits", status: "redeeming", grantedAt: 1793000000, expiresAt: 1794000000, title: null, description: null },
    ] } } });
    expect(summary.resetCredits?.availableCount).toBe(3);
    expect(summary.resetCredits?.credits?.map((credit) => [credit.id, credit.status])).toEqual([["soon", "redeeming"], ["later", "available"], ["never", "available"]]);
    expect(summary.resetCredits?.credits?.[1]).toMatchObject({ title: "额度重置", description: "任务奖励", expiresAt: new Date(1795000000 * 1000).toISOString() });
    expect(summarizeQuota({ ...base, rateLimits: { rateLimits: {}, rateLimitResetCredits: { availableCount: 1, credits: null } } }).resetCredits)
      .toEqual({ availableCount: 1, credits: null });
    expect(resetOutcomeText("reset")).toBe("已重置额度");
    expect(resetOutcomeText("somethingNew")).toBe("重置结果：somethingNew");
  });

  it("explains Codex logins without plan quota", () => {
    expect(summarizeQuota({ runtime: "codex", account: { type: "apiKey" }, rateLimits: null }).notApplicable)
      .toContain("API Key");
  });

  it("uses Claude's server-driven rows and the server's severity", () => {
    const summary = summarizeQuota({
      runtime: "claude",
      account: { email: "dev@example.com", organization: "Acme", subscriptionType: "Claude Pro", apiProvider: "firstParty" },
      usage: {
        subscription_type: "pro",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 3, resets_at: "2026-10-30T12:40:00+00:00" },
          extra_usage: { is_enabled: false, utilization: null },
          limits: [
            { kind: "session", group: "session", percent: 3, severity: "normal", resets_at: "2026-10-30T12:40:00+00:00", scope: null },
            { kind: "weekly_all", group: "weekly", percent: 58, severity: "normal", resets_at: "2026-10-31T01:00:00+00:00", scope: null },
            { kind: "weekly_scoped", group: "weekly", percent: 70, severity: "warning", resets_at: null, scope: { model: { display_name: "Fable" } } },
          ],
        },
      },
    });
    expect(summary).toMatchObject({ email: "dev@example.com", plan: "Claude Pro", organization: "Acme" });
    expect(summary.meters.map((meter) => [meter.label, meter.percent, meter.severity])).toEqual([
      ["5 小时", 3, "normal"],
      ["每周 · 全部模型", 58, "normal"],
      ["每周 · Fable", 70, "warning"],
    ]);
    expect(summary.notes).toEqual([{ text: "额外用量：未开启" }]);
  });

  it("falls back to Claude's named buckets when rows are missing", () => {
    const summary = summarizeQuota({
      runtime: "claude",
      account: {},
      usage: {
        rate_limits_available: true,
        rate_limits: {
          seven_day: { utilization: 58, resets_at: null },
          seven_day_opus: { utilization: 10, resets_at: null },
          model_scoped: [{ display_name: "Fable", utilization: 5, resets_at: null }],
        },
      },
    });
    expect(summary.meters.map((meter) => meter.label)).toEqual(["每周 · 全部模型", "每周 · Opus", "每周 · Fable"]);
  });

  it("explains Claude logins without plan quota", () => {
    expect(summarizeQuota({ runtime: "claude", account: { apiProvider: "bedrock" }, usage: { rate_limits_available: false, rate_limits: null } }).notApplicable)
      .toContain("bedrock");
  });

  it("formats window lengths and reset distances", () => {
    expect([300, 1440, 10080, 43200, 90, null].map(codexWindowLabel)).toEqual(["5 小时", "每天", "每周", "30 天", "90 分钟", "额度窗口"]);
    const now = Date.parse("2026-10-30T08:00:00Z");
    expect(resetDistance("2026-10-30T08:30:00Z", now)).toBe("30 分钟后");
    expect(resetDistance("2026-10-30T11:20:00Z", now)).toBe("3 小时 20 分钟后");
    expect(resetDistance("2026-11-02T10:00:00Z", now)).toBe("3 天 2 小时后");
    expect(resetDistance("2026-10-30T07:00:00Z", now)).toBe("已到重置时间");
  });
});
