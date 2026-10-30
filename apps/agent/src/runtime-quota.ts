import { isRecord, toJsonValue, type AgentRuntime, type JsonValue, type RuntimeQuotaReport } from "@controller-center/protocol";
import { AppServerRpcError } from "./app-server-client.js";
import type { RuntimeClient } from "./claude-code-client.js";

/** Stays below the Control Plane's wait so a slow runtime still gets its error reported. */
export const QUOTA_READ_TIMEOUT_MS = 25_000;

/** Drops the many always-null bucket keys Claude's usage endpoint returns. */
function withoutNullEntries(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
}

function claudeUsage(value: unknown): JsonValue | null {
  if (!isRecord(value)) return null;
  // Session cost belongs to the throwaway probe process, not the account.
  return toJsonValue({
    subscription_type: value.subscription_type ?? null,
    rate_limits_available: value.rate_limits_available === true,
    rate_limits: isRecord(value.rate_limits) ? withoutNullEntries(value.rate_limits) : null,
  });
}

/**
 * Reads the logged-in account and its plan quota through the node's runtime,
 * which owns the credentials, token refresh and proxy settings.
 */
export async function readRuntimeQuota(
  runtime: AgentRuntime,
  client: RuntimeClient,
  timeoutMs = QUOTA_READ_TIMEOUT_MS,
): Promise<RuntimeQuotaReport> {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1_000, deadline - Date.now());
  await client.start();
  if (runtime === "claude") {
    const result = await client.request<unknown>("claude/usage/read", {}, remaining());
    const record = isRecord(result) ? result : {};
    return {
      runtime: "claude",
      account: isRecord(record.account) ? toJsonValue(record.account) : null,
      usage: claudeUsage(record.usage),
    };
  }
  const accountResult = await client.request<unknown>("account/read", {}, remaining());
  const account = isRecord(accountResult) && isRecord(accountResult.account) ? accountResult.account : null;
  if (!account) throw new Error("节点上的 Codex 尚未登录，请先在节点登录 Codex");
  // API key and cloud-provider logins have no ChatGPT plan quota to read.
  if (account.type !== "chatgpt") return { runtime: "codex", account: toJsonValue(account), rateLimits: null };
  // Reads are user-triggered, so the reset-credit detail lookup is worth its extra request.
  const rateLimits = await client.request<unknown>("account/rateLimits/read", { excludeResetCreditDetails: false }, remaining());
  return { runtime: "codex", account: toJsonValue(account), rateLimits: toJsonValue(rateLimits ?? null) };
}

/**
 * Redeems the reset credit the user picked. The idempotency key identifies the
 * attempt, so retrying an attempt whose result was lost cannot spend a second credit.
 */
export async function resetRuntimeQuota(
  runtime: AgentRuntime,
  client: RuntimeClient,
  idempotencyKey: string,
  creditId: string,
  timeoutMs = QUOTA_READ_TIMEOUT_MS,
): Promise<string> {
  if (runtime !== "codex") throw new Error("只有 Codex 节点支持额度重置");
  await client.start();
  const result = await client.request<unknown>("account/rateLimitResetCredit/consume", { idempotencyKey, creditId }, timeoutMs);
  if (!isRecord(result) || typeof result.outcome !== "string") throw new Error("Codex 未返回额度重置结果");
  return result.outcome;
}

/** A short product-facing reason for a failed quota read or reset. */
export function quotaErrorMessage(runtime: AgentRuntime, error: unknown, action = "额度查询"): string {
  const label = runtime === "claude" ? "Claude Code" : "Codex";
  const raw = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  if (error instanceof AppServerRpcError && error.code === -32601
    || /unknown variant|method not found|unsupported control request|unknown (?:control )?(?:request )?subtype|not supported/i.test(raw)) {
    return `当前节点的 ${label} 版本不支持${action}，请升级 ${label}`;
  }
  if (/timed out/i.test(raw)) return `${label} ${action}超时，请稍后重试`;
  if (!raw) return `${label} ${action}失败`;
  return raw.length > 260 ? `${raw.slice(0, 260)}…` : raw;
}
