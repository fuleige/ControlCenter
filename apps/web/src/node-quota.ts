import type { NodeQuotaReport } from "./types";

export type QuotaSeverity = "normal" | "warning" | "critical";

export interface QuotaMeter {
  key: string;
  label: string;
  /** Share of the window used, 0-100. */
  percent: number;
  resetsAt: string | null;
  severity: QuotaSeverity;
}

export interface QuotaNote {
  text: string;
  warning?: boolean;
}

export interface QuotaResetCredit {
  id: string;
  title: string | null;
  description: string | null;
  /** Codex reports `available`, `redeeming`, `redeemed` or `unknown`. */
  status: string;
  grantedAt: string | null;
  /** Null when the credit never expires. */
  expiresAt: string | null;
}

export interface QuotaResetCredits {
  availableCount: number;
  /** Null when the server reported only the count; the list may be shorter than the count. */
  credits: QuotaResetCredit[] | null;
}

export interface QuotaSummary {
  email: string | null;
  plan: string | null;
  organization: string | null;
  /** Set when the login has no plan quota at all, such as an API key. */
  notApplicable: string | null;
  meters: QuotaMeter[];
  notes: QuotaNote[];
  /** Codex rate-limit reset credits; null when the runtime has none to report. */
  resetCredits: QuotaResetCredits | null;
}

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Fields : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function severityOf(percent: number): QuotaSeverity {
  return percent >= 90 ? "critical" : percent >= 75 ? "warning" : "normal";
}

function meter(key: string, label: string, percent: number, resetsAt: string | null, severity?: unknown): QuotaMeter {
  return {
    key,
    label,
    percent: Math.min(100, Math.max(0, percent)),
    resetsAt,
    severity: severity === "warning" || severity === "critical" || severity === "normal" ? severity : severityOf(percent),
  };
}

/** Codex reports windows positionally; only the duration says which window it is. */
export function codexWindowLabel(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return "额度窗口";
  if (minutes === 7 * 1440) return "每周";
  if (minutes === 1440) return "每天";
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

const CODEX_LIMIT_REACHED: Record<string, string> = {
  rate_limit_reached: "已达到额度上限",
  workspace_owner_credits_depleted: "工作区所有者的 Credits 已用完",
  workspace_member_credits_depleted: "工作区成员的 Credits 已用完",
  workspace_owner_usage_limit_reached: "工作区所有者已达到用量上限",
  workspace_member_usage_limit_reached: "工作区成员已达到用量上限",
};

function summarizeCodex(report: Extract<NodeQuotaReport, { runtime: "codex" }>): QuotaSummary {
  const account = fields(report.account) ?? {};
  const summary: QuotaSummary = {
    email: stringField(account.email),
    plan: stringField(account.planType),
    organization: null,
    notApplicable: null,
    meters: [],
    notes: [],
    resetCredits: null,
  };
  if (account.type !== "chatgpt") {
    summary.notApplicable = account.type === "apiKey"
      ? "此节点的 Codex 使用 API Key 登录，按 API 用量计费，没有套餐额度"
      : "此节点的 Codex 未使用 ChatGPT 账号登录，没有套餐额度";
    return summary;
  }
  const limits = fields(report.rateLimits);
  if (!limits) return summary;
  const byId = fields(limits.rateLimitsByLimitId);
  const buckets: Array<[string, unknown]> = byId && Object.keys(byId).length > 0
    ? Object.entries(byId)
    : [[stringField(fields(limits.rateLimits)?.limitId) ?? "codex", limits.rateLimits]];
  for (const [id, value] of buckets) {
    const snapshot = fields(value);
    if (!snapshot) continue;
    // The default bucket needs no name; extra buckets are per-model quotas.
    const name = buckets.length > 1 && id !== "codex"
      ? stringField(snapshot.limitName) ?? stringField(snapshot.normalModelSlug) ?? id
      : null;
    const windows = (["primary", "secondary"] as const).flatMap((slot) => {
      const window = fields(snapshot[slot]);
      const percent = numberField(window?.usedPercent);
      if (!window || percent === null) return [];
      const minutes = numberField(window.windowDurationMins);
      const resetsAt = numberField(window.resetsAt);
      return [{ slot, minutes, percent, resetsAt: resetsAt === null ? null : new Date(resetsAt * 1000).toISOString() }];
    }).sort((left, right) => (left.minutes ?? Infinity) - (right.minutes ?? Infinity));
    for (const window of windows) {
      const label = codexWindowLabel(window.minutes);
      summary.meters.push(meter(`${id}:${window.slot}`, name ? `${name} · ${label}` : label, window.percent, window.resetsAt));
    }
  }

  const main = fields(limits.rateLimits) ?? {};
  if (limits.ordinaryUsageAllowed === false) summary.notes.push({ text: "普通额度当前不可用", warning: true });
  const reached = stringField(main.rateLimitReachedType);
  if (reached) summary.notes.push({ text: CODEX_LIMIT_REACHED[reached] ?? reached, warning: true });
  if (main.spendControlReached === true) summary.notes.push({ text: "已达到工作区设置的支出上限", warning: true });
  const individual = fields(main.individualLimit);
  if (individual && stringField(individual.limit)) {
    summary.notes.push({ text: `个人支出上限：已用 ${stringField(individual.used) ?? "0"} / ${stringField(individual.limit)}` });
  }
  const credits = fields(main.credits);
  if (credits) summary.notes.push({ text: credits.unlimited === true ? "Credits：不限" : `Credits 余额：${stringField(credits.balance) ?? "0"}` });
  summary.resetCredits = codexResetCredits(limits.rateLimitResetCredits);
  if (summary.meters.length === 0) summary.notes.push({ text: "服务端未返回额度窗口" });
  return summary;
}

function unixTime(value: unknown): string | null {
  const seconds = numberField(value);
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

function codexResetCredits(value: unknown): QuotaResetCredits | null {
  const summary = fields(value);
  const availableCount = numberField(summary?.availableCount);
  if (!summary || availableCount === null) return null;
  if (!Array.isArray(summary.credits)) return { availableCount, credits: null };
  const credits = summary.credits.flatMap((entry) => {
    const credit = fields(entry);
    const id = stringField(credit?.id);
    if (!credit || !id) return [];
    return [{
      id,
      title: stringField(credit.title),
      description: stringField(credit.description),
      status: stringField(credit.status) ?? "unknown",
      grantedAt: unixTime(credit.grantedAt),
      expiresAt: unixTime(credit.expiresAt),
    }];
  });
  // Soonest to expire first; credits that never expire last.
  credits.sort((left, right) => (left.expiresAt ? Date.parse(left.expiresAt) : Infinity) - (right.expiresAt ? Date.parse(right.expiresAt) : Infinity));
  return { availableCount, credits };
}

const RESET_OUTCOMES: Record<string, string> = {
  reset: "已重置额度",
  nothingToReset: "服务端表示当前没有需要重置的额度",
  noCredit: "服务端表示没有可用的重置券",
  alreadyRedeemed: "这张重置券此前已经兑换",
};

export function resetOutcomeText(outcome: string): string {
  return RESET_OUTCOMES[outcome] ?? `重置结果：${outcome}`;
}

export const RESET_CREDIT_STATUS: Record<string, string> = {
  available: "可用",
  redeeming: "兑换中",
  redeemed: "已兑换",
  unknown: "状态未知",
};

function claudeLimitLabel(kind: string, group: string, scope: string | null): string {
  if (kind === "session") return "5 小时";
  if (kind === "weekly_all") return "每周 · 全部模型";
  if (kind === "weekly_scoped") return `每周 · ${scope ?? "指定模型"}`;
  if (group === "weekly") return `每周 · ${scope ?? kind}`;
  if (group === "session") return `5 小时 · ${scope ?? kind}`;
  return scope ?? kind;
}

const CLAUDE_BUCKETS: Array<[string, string]> = [
  ["five_hour", "5 小时"],
  ["seven_day", "每周 · 全部模型"],
  ["seven_day_opus", "每周 · Opus"],
  ["seven_day_sonnet", "每周 · Sonnet"],
  ["seven_day_oauth_apps", "每周 · OAuth 应用"],
];

function summarizeClaude(report: Extract<NodeQuotaReport, { runtime: "claude" }>): QuotaSummary {
  const account = fields(report.account) ?? {};
  const usage = fields(report.usage);
  const summary: QuotaSummary = {
    email: stringField(account.email),
    plan: stringField(account.subscriptionType) ?? stringField(usage?.subscription_type),
    organization: stringField(account.organization),
    notApplicable: null,
    meters: [],
    notes: [],
    resetCredits: null,
  };
  const limits = fields(usage?.rate_limits);
  if (usage?.rate_limits_available !== true || !limits) {
    const provider = stringField(account.apiProvider);
    summary.notApplicable = provider && provider !== "firstParty"
      ? `此节点的 Claude Code 通过 ${provider} 访问，没有 Claude 套餐额度`
      : stringField(account.apiKeySource)
        ? "此节点的 Claude Code 使用 API Key 登录，按 API 用量计费，没有套餐额度"
        : "此节点的 Claude Code 未使用 Claude 订阅登录，或登录缺少读取额度的权限";
    return summary;
  }
  // Server-driven rows cover meters this page does not know about yet.
  if (Array.isArray(limits.limits)) {
    limits.limits.forEach((value, index) => {
      const row = fields(value);
      const percent = numberField(row?.percent);
      if (!row || percent === null) return;
      const scope = fields(row.scope);
      const scopeName = stringField(fields(scope?.model)?.display_name) ?? stringField(fields(scope?.surface)?.display_name);
      const kind = stringField(row.kind) ?? "limit";
      summary.meters.push(meter(`${kind}:${index}`, claudeLimitLabel(kind, stringField(row.group) ?? "", scopeName), percent, stringField(row.resets_at), row.severity));
    });
  } else {
    for (const [key, label] of CLAUDE_BUCKETS) {
      const bucket = fields(limits[key]);
      const percent = numberField(bucket?.utilization);
      if (percent !== null) summary.meters.push(meter(key, label, percent, stringField(bucket?.resets_at)));
    }
    if (Array.isArray(limits.model_scoped)) {
      limits.model_scoped.forEach((value, index) => {
        const bucket = fields(value);
        const percent = numberField(bucket?.utilization);
        if (bucket && percent !== null) {
          summary.meters.push(meter(`model_scoped:${index}`, `每周 · ${stringField(bucket.display_name) ?? "指定模型"}`, percent, stringField(bucket.resets_at)));
        }
      });
    }
  }
  const extra = fields(limits.extra_usage);
  if (extra) {
    const used = numberField(extra.utilization);
    summary.notes.push({ text: extra.is_enabled === true ? `额外用量：已开启${used === null ? "" : `，本期已用 ${Math.round(used)}%`}` : "额外用量：未开启" });
  }
  if (summary.meters.length === 0) summary.notes.push({ text: "服务端未返回额度窗口" });
  return summary;
}

export function summarizeQuota(report: NodeQuotaReport): QuotaSummary {
  return report.runtime === "claude" ? summarizeClaude(report) : summarizeCodex(report);
}

/** "3 小时 20 分钟后" style distance to a reset time. */
export function resetDistance(resetsAt: string, now: number): string {
  const minutes = Math.ceil((Date.parse(resetsAt) - now) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes <= 0) return "已到重置时间";
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分钟后` : `${hours} 小时后`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} 天 ${hours % 24} 小时后` : `${days} 天后`;
}
