import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  QUOTA_READ_CAPABILITY,
  QUOTA_RESET_CAPABILITY,
  type AgentQuotaMessage,
  type AgentQuotaResetMessage,
  type RuntimeQuotaReport,
} from "@controller-center/protocol";
import { ControlDatabase } from "./database.js";
import { NodeQuotas, QuotaRequestError, quotaOpenNeedsRead, quotaRefreshWaitMs } from "./node-quota.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const report: RuntimeQuotaReport = { runtime: "codex", account: { type: "chatgpt", planType: "plus" }, rateLimits: { rateLimits: {} } };
const start = Date.parse("2026-10-30T08:00:00.000Z");
const node = { id: "node-1", runtime: "codex" as const, capabilities: [QUOTA_READ_CAPABILITY, QUOTA_RESET_CAPABILITY] };

function setup() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "control-plane-quota-test-"));
  directories.push(directory);
  const database = new ControlDatabase(path.join(directory, "test.db"));
  database.upsertNode({
    id: "node-1", name: "Build host", platform: "linux", arch: "x64", agentVersion: "0.3.25", runtime: "codex",
    codexVersion: "codex-cli 0.163.0", maxConcurrentRuns: 1, workspaces: [], capabilities: [QUOTA_READ_CAPABILITY],
  }, "boot-1", new Date(start).toISOString());
  const state = {
    now: start, online: true, capable: true, reads: 0,
    answer: { ok: true, report } as Omit<AgentQuotaMessage, "type" | "requestId">,
    resets: [] as Array<{ idempotencyKey: string; creditId: string }>,
    resetAnswer: { ok: true, outcome: "reset" } as Omit<AgentQuotaResetMessage, "type" | "requestId"> | Error,
  };
  let release: (() => void) | null = null;
  const quotas = new NodeQuotas({
    database,
    connections: {
      has: () => state.online,
      hasCapability: (_id, capability) => state.online && state.capable && [QUOTA_READ_CAPABILITY, QUOTA_RESET_CAPABILITY].includes(capability),
      readQuota: async () => {
        state.reads += 1;
        if (release === null) return { type: "agent.quota", requestId: "r", ...state.answer };
        await new Promise<void>((resolve) => { release = resolve; });
        return { type: "agent.quota", requestId: "r", ...state.answer };
      },
      resetQuota: async (_id, idempotencyKey, creditId) => {
        state.resets.push({ idempotencyKey, creditId });
        if (state.resetAnswer instanceof Error) throw state.resetAnswer;
        return { type: "agent.quotaReset", requestId: "r", ...state.resetAnswer };
      },
    },
    now: () => state.now,
  });
  return { database, quotas, state, hold: () => { release = () => {}; }, release: () => release?.() };
}

describe("quota limits", () => {
  it("reuses a success for 15 minutes and lets refresh run once a minute", () => {
    const success = { succeededAt: new Date(start).toISOString(), attemptedAt: new Date(start).toISOString(), error: null };
    expect(quotaOpenNeedsRead(null, start)).toBe(true);
    expect(quotaOpenNeedsRead(success, start + 14 * 60_000)).toBe(false);
    expect(quotaOpenNeedsRead(success, start + 15 * 60_000)).toBe(true);
    expect(quotaRefreshWaitMs(success, start + 20_000)).toBe(40_000);
    expect(quotaRefreshWaitMs(success, start + 60_000)).toBe(0);
  });

  it("does not cache failures but holds both open and refresh for 10 seconds after one", () => {
    const failure = { succeededAt: null, attemptedAt: new Date(start).toISOString(), error: "boom" };
    expect(quotaOpenNeedsRead(failure, start + 5_000)).toBe(false);
    expect(quotaRefreshWaitMs(failure, start + 5_000)).toBe(5_000);
    expect(quotaOpenNeedsRead(failure, start + 10_000)).toBe(true);
    // A recent success still answers the dialog even when a later refresh failed.
    expect(quotaOpenNeedsRead({ ...failure, succeededAt: new Date(start - 60_000).toISOString() }, start + 30_000)).toBe(false);
  });
});

describe("NodeQuotas", () => {
  it("reads on the first open and serves the stored result afterwards", async () => {
    const { quotas, state } = setup();
    const first = await quotas.read(node, "open");
    expect(first).toMatchObject({ online: true, supported: true, report, error: null, refreshWaitMs: 60_000 });
    state.now += 5 * 60_000;
    await expect(quotas.read(node, "open")).resolves.toMatchObject({ report, refreshWaitMs: 0 });
    expect(state.reads).toBe(1);
    await quotas.read(node, "refresh");
    expect(state.reads).toBe(2);
  });

  it("rejects refreshes during the cooldown and keeps the last valid report after a failure", async () => {
    const { quotas, state } = setup();
    await quotas.read(node, "open");
    state.now += 30_000;
    await expect(quotas.read(node, "refresh")).rejects.toMatchObject({ statusCode: 429, message: "请在 30 秒后再刷新" });
    state.now += 30_000;
    state.answer = { ok: false, error: "当前节点的 Codex 版本不支持额度查询，请升级 Codex" };
    const failed = await quotas.read(node, "refresh");
    expect(failed).toMatchObject({ report, error: "当前节点的 Codex 版本不支持额度查询，请升级 Codex", refreshWaitMs: 10_000 });
    expect(failed.succeededAt).toBe(new Date(start).toISOString());
    state.now += 10_000;
    await quotas.read(node, "refresh");
    expect(state.reads).toBe(3);
  });

  it("shares one read between concurrent requests", async () => {
    const { quotas, state, hold, release } = setup();
    hold();
    const opened = quotas.read(node, "open");
    const refreshed = quotas.read(node, "refresh");
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await expect(Promise.all([opened, refreshed])).resolves.toHaveLength(2);
    expect(state.reads).toBe(1);
  });

  it("shows stored data for an offline node without reading it", async () => {
    const { quotas, state } = setup();
    await quotas.read(node, "open");
    state.online = false;
    state.now += 60 * 60_000;
    await expect(quotas.read(node, "open")).resolves.toMatchObject({ online: false, supported: true, report });
    const refresh = quotas.read(node, "refresh");
    await expect(refresh).rejects.toBeInstanceOf(QuotaRequestError);
    await expect(refresh).rejects.toMatchObject({ statusCode: 409 });
    expect(state.reads).toBe(1);
  });

  it("does not read nodes whose Agent lacks the capability", async () => {
    const { quotas, state } = setup();
    state.capable = false;
    await expect(quotas.read({ ...node, capabilities: [] }, "open")).resolves.toMatchObject({ supported: false, report: null });
    await expect(quotas.read(node, "refresh")).rejects.toMatchObject({ statusCode: 409 });
    expect(state.reads).toBe(0);
  });

  it("removes stored quota with the machine", async () => {
    const { quotas, database } = setup();
    await quotas.read(node, "open");
    expect(database.getNodeQuota("node-1")?.report).toEqual(report);
    database.deleteMachine("node-1");
    expect(database.getNodeQuota("node-1")).toBeNull();
  });

  it("redeems the picked credit and rereads quota despite the refresh cooldown", async () => {
    const { quotas, state } = setup();
    await quotas.read(node, "open");
    state.now += 5_000;
    const view = await quotas.reset(node, "credit-1", "限时重置券");
    expect(state.resets).toEqual([{ idempotencyKey: expect.any(String), creditId: "credit-1" }]);
    expect(state.reads).toBe(2);
    expect(view).toMatchObject({
      resetSupported: true, resetting: false, lastReset: { creditId: "credit-1", creditLabel: "限时重置券", outcome: "reset", error: null },
    });
  });

  it("retries an unknown result with the same key and only then starts a new attempt", async () => {
    const { quotas, state } = setup();
    state.resetAnswer = new Error("节点未在 30 秒内返回重置结果，结果未知");
    const unknown = await quotas.reset(node, "credit-1");
    expect(unknown.lastReset).toMatchObject({ outcome: null, error: "节点未在 30 秒内返回重置结果，结果未知" });
    state.resetAnswer = { ok: true, outcome: "alreadyRedeemed" };
    await quotas.reset(node, "credit-1");
    await quotas.reset(node, "credit-1");
    const [first, retry, next] = state.resets.map((reset) => reset.idempotencyKey);
    expect(retry).toBe(first);
    expect(next).not.toBe(first);
  });

  it("refuses resets for Claude, offline or outdated nodes and while one is running", async () => {
    const { quotas, state, database } = setup();
    await expect(quotas.reset({ ...node, runtime: "claude" }, "credit-1")).rejects.toMatchObject({ statusCode: 400 });
    state.capable = false;
    await expect(quotas.reset(node, "credit-1")).rejects.toMatchObject({ statusCode: 409, message: "该节点的 Agent 版本不支持额度重置，请升级 Agent" });
    state.capable = true;
    state.online = false;
    await expect(quotas.reset(node, "credit-1")).rejects.toMatchObject({ statusCode: 409 });
    state.online = true;
    let finish!: () => void;
    state.resetAnswer = { ok: true, outcome: "reset" };
    const slow = new NodeQuotas({
      database,
      connections: {
        has: () => true,
        hasCapability: () => true,
        readQuota: async () => ({ type: "agent.quota", requestId: "r", ok: true, report }),
        resetQuota: async () => {
          await new Promise<void>((resolve) => { finish = resolve; });
          return { type: "agent.quotaReset", requestId: "r", ok: true, outcome: "reset" };
        },
      },
    });
    const running = slow.reset(node, "credit-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(slow.reset(node, "credit-2")).rejects.toMatchObject({ statusCode: 409, message: "该节点已有重置操作正在进行" });
    finish();
    await running;
    expect(state.resets).toHaveLength(0);
  });

  it("reports an attempt cut off by a restart as unknown", async () => {
    const { quotas, database } = setup();
    database.startNodeQuotaReset({ id: "attempt-1", nodeId: "node-1", creditId: "credit-1", requestedAt: new Date(start).toISOString() });
    const view = await quotas.read(node, "open");
    expect(view.lastReset).toMatchObject({ creditId: "credit-1", finishedAt: null, error: "控制中心在等待重置结果时重启，结果未知" });
    database.deleteMachine("node-1");
    expect(database.latestNodeQuotaReset("node-1")).toBeNull();
  });
});
