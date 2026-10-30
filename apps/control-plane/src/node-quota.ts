import { randomUUID } from "node:crypto";
import {
  isRecord,
  QUOTA_READ_CAPABILITY,
  QUOTA_RESET_CAPABILITY,
  type AgentQuotaMessage,
  type AgentQuotaResetMessage,
  type AgentRuntime,
  type RuntimeQuotaReport,
} from "@controller-center/protocol";
import type { NodeQuotaRecord, NodeQuotaResetRecord } from "./database.js";

/** A successful read is reused for this long when the quota dialog is opened again. */
export const QUOTA_CACHE_MS = 15 * 60_000;
/** Manual refresh cooldown after a successful read. */
export const QUOTA_REFRESH_COOLDOWN_MS = 60_000;
/** Manual refresh cooldown after a failed read, which is not cached. */
export const QUOTA_FAILURE_COOLDOWN_MS = 10_000;
/** Longer than the Agent's own runtime timeout so its error reaches us first. */
export const QUOTA_READ_TIMEOUT_MS = 30_000;

type QuotaState = Pick<NodeQuotaRecord, "succeededAt" | "attemptedAt" | "error">;

/** Milliseconds until a manual refresh is allowed. */
export function quotaRefreshWaitMs(state: QuotaState | null, now: number): number {
  if (!state) return 0;
  const cooldown = state.error ? QUOTA_FAILURE_COOLDOWN_MS : QUOTA_REFRESH_COOLDOWN_MS;
  return Math.max(0, Date.parse(state.attemptedAt) + cooldown - now);
}

/**
 * Whether opening the quota dialog reads the node. A success is reused for 15
 * minutes. A failure is not cached, but reopening within its refresh cooldown
 * only shows it again, so open and refresh share one limit.
 */
export function quotaOpenNeedsRead(state: QuotaState | null, now: number): boolean {
  if (!state) return true;
  if (state.succeededAt && now - Date.parse(state.succeededAt) < QUOTA_CACHE_MS) return false;
  return !state.error || quotaRefreshWaitMs(state, now) === 0;
}

export interface QuotaNode {
  id: string;
  runtime: AgentRuntime;
  /** Capabilities from the node's last hello, used while it is offline. */
  capabilities?: string[];
}

export interface NodeQuotaView {
  nodeId: string;
  runtime: AgentRuntime;
  online: boolean;
  /** The node's Agent can answer quota reads. */
  supported: boolean;
  report: RuntimeQuotaReport | null;
  succeededAt: string | null;
  attemptedAt: string | null;
  error: string | null;
  refreshWaitMs: number;
  /** The node's Agent can redeem reset credits; only Codex has them. */
  resetSupported: boolean;
  /** A reset is running on this node, possibly started from another browser. */
  resetting: boolean;
  lastReset: Pick<NodeQuotaResetRecord, "creditId" | "creditLabel" | "requestedAt" | "finishedAt" | "outcome" | "error"> | null;
}

export class QuotaRequestError extends Error {
  constructor(message: string, readonly statusCode: number, readonly quota: NodeQuotaView) {
    super(message);
  }
}

interface NodeQuotaDependencies {
  database: {
    getNodeQuota(nodeId: string): NodeQuotaRecord | null;
    recordNodeQuotaSuccess(nodeId: string, report: RuntimeQuotaReport, at: string): void;
    recordNodeQuotaFailure(nodeId: string, error: string, at: string): void;
    machineIdOf(nodeId: string): string | null;
    latestNodeQuotaReset(nodeId: string): NodeQuotaResetRecord | null;
    unresolvedNodeQuotaReset(nodeId: string, creditId: string): NodeQuotaResetRecord | null;
    startNodeQuotaReset(input: { id: string; nodeId: string; creditId: string; creditLabel?: string | null; requestedAt: string }): void;
    finishNodeQuotaReset(id: string, result: { outcome: string } | { error: string }, at: string): void;
  };
  connections: {
    has(nodeId: string): boolean;
    hasCapability(nodeId: string, capability: string): boolean;
    readQuota(nodeId: string, timeoutMs: number): Promise<AgentQuotaMessage>;
    resetQuota(nodeId: string, idempotencyKey: string, creditId: string, timeoutMs: number): Promise<AgentQuotaResetMessage>;
  };
  now?: () => number;
}

function validReport(value: unknown): value is RuntimeQuotaReport {
  return isRecord(value) && (value.runtime === "codex" || value.runtime === "claude");
}

/**
 * Reads plan quota only when a person opens the dialog or presses refresh; there
 * is no background polling or retry. Concurrent requests for a node share one read.
 */
export class NodeQuotas {
  private readonly reads = new Map<string, Promise<void>>();
  private readonly resets = new Map<string, Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly dependencies: NodeQuotaDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async read(node: QuotaNode, mode: "open" | "refresh"): Promise<NodeQuotaView> {
    const pending = this.reads.get(node.id);
    if (pending) {
      await pending;
      return this.view(node);
    }
    const state = this.dependencies.database.getNodeQuota(node.id);
    const current = this.view(node, state);
    if (mode === "refresh") {
      if (!current.online) throw new QuotaRequestError("节点当前离线，无法刷新额度", 409, current);
      if (!current.supported) throw new QuotaRequestError("该节点的 Agent 版本不支持额度查询，请升级 Agent", 409, current);
      if (current.refreshWaitMs > 0) {
        throw new QuotaRequestError(`请在 ${Math.ceil(current.refreshWaitMs / 1000)} 秒后再刷新`, 429, current);
      }
    } else if (!current.online || !current.supported || !quotaOpenNeedsRead(state, this.now())) {
      return current;
    }
    const read = this.readNode(node.id).finally(() => this.reads.delete(node.id));
    this.reads.set(node.id, read);
    await read;
    return this.view(node);
  }

  /**
   * Redeems the credit the user picked and confirmed, then reads the node once to
   * show the result. That read follows the confirmation, so it skips the cooldown.
   */
  async reset(node: QuotaNode, creditId: string, creditLabel: string | null = null): Promise<NodeQuotaView> {
    const current = this.view(node);
    if (node.runtime !== "codex") throw new QuotaRequestError("只有 Codex 节点支持额度重置", 400, current);
    if (current.resetting) throw new QuotaRequestError("该节点已有重置操作正在进行", 409, current);
    if (!current.online) throw new QuotaRequestError("节点当前离线，无法重置额度", 409, current);
    if (!current.resetSupported) throw new QuotaRequestError("该节点的 Agent 版本不支持额度重置，请升级 Agent", 409, current);
    const redeem = this.redeem(node.id, creditId, creditLabel).finally(() => this.resets.delete(node.id));
    this.resets.set(node.id, redeem);
    await redeem;
    // A read that started before the reset would show the old usage.
    for (let pending = this.reads.get(node.id); pending; pending = this.reads.get(node.id)) await pending;
    if (this.dependencies.connections.has(node.id)) {
      const read = this.readNode(node.id).finally(() => this.reads.delete(node.id));
      this.reads.set(node.id, read);
      await read;
    }
    return this.view(node);
  }

  private async redeem(nodeId: string, creditId: string, creditLabel: string | null): Promise<void> {
    const { database } = this.dependencies;
    // An attempt without an outcome may already have spent the credit; reusing its
    // key lets the runtime answer that attempt instead of redeeming again.
    const id = database.unresolvedNodeQuotaReset(nodeId, creditId)?.id ?? randomUUID();
    database.startNodeQuotaReset({ id, nodeId, creditId, creditLabel, requestedAt: this.timestamp() });
    let result: { outcome: string } | { error: string };
    try {
      const message = await this.dependencies.connections.resetQuota(nodeId, id, creditId, QUOTA_READ_TIMEOUT_MS);
      result = message.ok && message.outcome ? { outcome: message.outcome } : { error: message.error?.trim() || "节点未返回重置结果" };
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    database.finishNodeQuotaReset(id, result, this.timestamp());
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private async readNode(nodeId: string): Promise<void> {
    let outcome: { report: RuntimeQuotaReport } | { error: string };
    try {
      const message = await this.dependencies.connections.readQuota(nodeId, QUOTA_READ_TIMEOUT_MS);
      outcome = message.ok && validReport(message.report)
        ? { report: message.report }
        : { error: message.error?.trim() || "节点未返回有效的额度信息" };
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error) };
    }
    // The node may have been deleted while it was being read.
    if (!this.dependencies.database.machineIdOf(nodeId)) return;
    const at = this.timestamp();
    if ("report" in outcome) this.dependencies.database.recordNodeQuotaSuccess(nodeId, outcome.report, at);
    else this.dependencies.database.recordNodeQuotaFailure(nodeId, outcome.error, at);
  }

  private view(node: QuotaNode, state = this.dependencies.database.getNodeQuota(node.id)): NodeQuotaView {
    const online = this.dependencies.connections.has(node.id);
    // Offline nodes keep the capabilities of their last hello.
    const capable = (capability: string) => online
      ? this.dependencies.connections.hasCapability(node.id, capability)
      : Boolean(node.capabilities?.includes(capability));
    const reset = this.dependencies.database.latestNodeQuotaReset(node.id);
    const resetting = this.resets.has(node.id);
    return {
      nodeId: node.id,
      runtime: node.runtime,
      online,
      supported: capable(QUOTA_READ_CAPABILITY),
      report: state?.report ?? null,
      succeededAt: state?.succeededAt ?? null,
      attemptedAt: state?.attemptedAt ?? null,
      error: state?.error ?? null,
      refreshWaitMs: quotaRefreshWaitMs(state, this.now()),
      resetSupported: node.runtime === "codex" && capable(QUOTA_RESET_CAPABILITY),
      resetting,
      lastReset: reset && {
        creditId: reset.creditId,
        creditLabel: reset.creditLabel,
        requestedAt: reset.requestedAt,
        finishedAt: reset.finishedAt,
        outcome: reset.outcome,
        // An attempt still open without a running reset was cut off by a restart.
        error: reset.finishedAt === null && !resetting ? "控制中心在等待重置结果时重启，结果未知" : reset.error,
      },
    };
  }
}
