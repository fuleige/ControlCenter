import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServerNotification, AppServerRequest } from "./app-server-client.js";
import { parseModelCatalog } from "./model-catalog.js";

type Script = (session: FakeSession) => AsyncGenerator<Record<string, unknown>>;

interface FakeSession {
  options: Record<string, any>;
  nextPrompt(): Promise<Record<string, any> | undefined>;
  interrupted: Promise<void>;
}

const sdk = vi.hoisted(() => ({
  sessions: new Set<string>(),
  script: null as Script | null,
  options: [] as Record<string, any>[],
  deleted: [] as string[],
  renamed: [] as Array<[string, string]>,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<Record<string, any>>; options: Record<string, any> }) => {
    sdk.options.push(options);
    const iterator = prompt[Symbol.asyncIterator]();
    let interrupt!: () => void;
    const session: FakeSession = {
      options,
      nextPrompt: async () => {
        const next = await iterator.next();
        return next.done ? undefined : next.value;
      },
      interrupted: new Promise((resolve) => { interrupt = resolve; }),
    };
    const generator = sdk.script!(session);
    return Object.assign(generator, {
      interrupt: async () => interrupt(),
      close: () => { void iterator.return?.(); },
      supportedModels: async () => [],
      getContextUsage: async () => ({ totalTokens: 0 }),
    });
  },
  getSessionInfo: async (sessionId: string) => sdk.sessions.has(sessionId)
    ? { sessionId, summary: "s", lastModified: 0, cwd: "/workspace" }
    : undefined,
  renameSession: async (sessionId: string, title: string) => { sdk.renamed.push([sessionId, title]); },
  deleteSession: async (sessionId: string) => { sdk.deleted.push(sessionId); sdk.sessions.delete(sessionId); },
}));

const {
  ClaudeCodeClient,
  classifyClaudeCodeError,
  modelCatalogEntry,
  needsSandboxDeclaration,
  permissionFromResponse,
  resolveExecutable,
} = await import("./claude-code-client.js");

const directories: string[] = [];

function createClient(yolo = false) {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "controller-center-claude-"));
  directories.push(dataDirectory);
  // Any executable satisfies the path check; the SDK itself is mocked.
  const client = new ClaudeCodeClient("/bin/sh", yolo, dataDirectory);
  const notifications: AppServerNotification[] = [];
  const requests: AppServerRequest[] = [];
  client.on("notification", (notification: AppServerNotification) => notifications.push(notification));
  client.on("serverRequest", (request: AppServerRequest) => requests.push(request));
  return { client, notifications, requests, dataDirectory };
}

async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function textOf(prompt: Record<string, any> | undefined): string {
  const content = prompt?.message?.content;
  return Array.isArray(content) ? content.map((block: any) => block.text ?? "").join("") : "";
}

function result(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    queued_turn_count: 0,
    modelUsage: {
      "claude-opus-5-5": {
        inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 90, cacheCreationInputTokens: 0,
        webSearchRequests: 0, costUSD: 0, contextWindow: 1_000_000, maxOutputTokens: 64_000,
      },
    },
    ...extra,
  };
}

beforeEach(() => {
  sdk.sessions.clear();
  sdk.options.length = 0;
  sdk.deleted.length = 0;
  sdk.renamed.length = 0;
  sdk.script = null;
});

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Claude Code runtime client", () => {
  it("translates a streamed turn, permission prompts and usage into Codex notifications", async () => {
    const decisions: unknown[] = [];
    sdk.script = async function* (session) {
      const prompt = await session.nextPrompt();
      expect(textOf(prompt)).toBe("list files");
      yield { type: "system", subtype: "init", model: "claude-opus-5-5", session_id: "s" };
      yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 10, cache_read_input_tokens: 90 } } } };
      yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
      yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } };
      yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } };
      yield { type: "assistant", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "text", text: "Hello" }] } };
      yield { type: "assistant", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] } };
      const signal = new AbortController().signal;
      decisions.push(await session.options.canUseTool("Bash", { command: "ls", description: "List files" }, { signal, toolUseID: "tu1", requestId: "r1" }));
      decisions.push(await session.options.canUseTool("Bash", { command: "ls" }, { signal, toolUseID: "tu2", requestId: "r2" }));
      yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "a" }] } };
      yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_delta", usage: { output_tokens: 5 } } };
      yield result();
      expect(await session.nextPrompt()).toBeUndefined();
    };
    const { client, notifications, requests } = createClient();

    const thread = await client.request<{ thread: { id: string } }>("thread/start", { cwd: "/workspace", model: "opus" });
    await client.request("thread/name/set", { threadId: thread.thread.id, name: "Fix bug" });
    const turn = await client.request<{ turn: { id: string } }>("turn/start", {
      threadId: thread.thread.id,
      input: [{ type: "text", text: "list files", text_elements: [] }],
      model: "default",
      effort: "high",
      serviceTier: "fast",
    });

    const approval = await waitFor(() => requests[0], "approval request");
    expect(approval).toMatchObject({
      method: "item/commandExecution/requestApproval",
      params: { threadId: thread.thread.id, turnId: turn.turn.id, command: "ls", reason: "List files" },
    });
    client.respond(approval.id, { decision: "acceptForSession" });
    await waitFor(() => notifications.find((entry) => entry.method === "turn/completed"), "turn completion");

    expect(requests).toHaveLength(1);
    expect(decisions).toEqual([
      { behavior: "allow", updatedInput: { command: "ls", description: "List files" } },
      { behavior: "allow", updatedInput: { command: "ls" } },
    ]);
    const options = sdk.options[0]!;
    expect(options).toMatchObject({
      cwd: "/workspace",
      sessionId: thread.thread.id,
      title: "Fix bug",
      effort: "high",
      settings: { fastMode: true },
      permissionMode: "acceptEdits",
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code" },
    });
    expect(options.model).toBeUndefined();
    expect(options.resume).toBeUndefined();

    const methods = notifications.map((entry) => entry.method);
    expect(methods[0]).toBe("turn/started");
    expect(notifications.filter((entry) => entry.method === "item/agentMessage/delta").map((entry: any) => [entry.params.itemId, entry.params.delta]))
      .toEqual([["m1:text:0", "Hel"], ["m1:text:0", "lo"]]);
    expect(notifications).toContainEqual({ method: "item/completed", params: { threadId: thread.thread.id, turnId: turn.turn.id, item: { type: "agentMessage", id: "m1:text:0", text: "Hello" } } });
    expect(notifications).toContainEqual({ method: "item/started", params: { threadId: thread.thread.id, turnId: turn.turn.id, item: { type: "commandExecution", id: "tu1" } } });
    expect(notifications).toContainEqual({ method: "item/completed", params: { threadId: thread.thread.id, turnId: turn.turn.id, item: { type: "commandExecution", id: "tu1" } } });
    const usage = notifications.filter((entry) => entry.method === "thread/tokenUsage/updated").at(-1) as any;
    expect(usage.params.tokenUsage).toEqual({
      total: { totalTokens: 105, outputTokens: 5 },
      last: { totalTokens: 105 },
      modelContextWindow: 1_000_000,
    });
    expect(notifications.at(-1)).toEqual({ method: "turn/completed", params: { threadId: thread.thread.id, turn: { id: turn.turn.id, status: "completed" } } });

    // A resumed thread reports stored usage, as Codex does when a thread is loaded.
    sdk.sessions.add(thread.thread.id);
    notifications.length = 0;
    await client.request("thread/resume", { threadId: thread.thread.id, excludeTurns: true });
    await waitFor(() => notifications.find((entry) => entry.method === "thread/tokenUsage/updated"), "stored usage");
  });

  it("resumes existing sessions, folds steering into the turn and reports interrupts", async () => {
    let releaseInterrupt!: () => void;
    let steerSeen!: () => void;
    const steered = new Promise<void>((resolve) => { steerSeen = resolve; });
    sdk.script = async function* (session) {
      expect(textOf(await session.nextPrompt())).toBe("first");
      expect(textOf(await session.nextPrompt())).toBe("also this");
      steerSeen();
      await session.interrupted;
      releaseInterrupt();
      yield result({ subtype: "error_during_execution", is_error: true, errors: ["interrupted"] });
    };
    const { client, notifications } = createClient(true);
    const thread = await client.request<{ thread: { id: string } }>("thread/start", { cwd: "/workspace" });
    sdk.sessions.add(thread.thread.id);
    const turn = await client.request<{ turn: { id: string } }>("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "first" }] });
    await expect(client.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "again" }] }))
      .rejects.toMatchObject({ errorCode: "active_turn_busy" });
    await client.request("turn/steer", { threadId: thread.thread.id, expectedTurnId: turn.turn.id, input: [{ type: "text", text: "also this" }] });
    await steered;
    const interrupted = new Promise<void>((resolve) => { releaseInterrupt = resolve; });
    await client.request("turn/interrupt", { threadId: thread.thread.id, turnId: turn.turn.id });
    await interrupted;
    await waitFor(() => notifications.find((entry) => entry.method === "turn/completed"), "interrupted turn");

    expect(sdk.options[0]).toMatchObject({ resume: thread.thread.id, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true });
    expect(sdk.options[0]!.sessionId).toBeUndefined();
    expect(notifications.at(-1)).toEqual({ method: "turn/completed", params: { threadId: thread.thread.id, turn: { id: turn.turn.id, status: "interrupted" } } });
    await expect(client.request("turn/steer", { threadId: thread.thread.id, expectedTurnId: turn.turn.id, input: [{ type: "text", text: "late" }] }))
      .rejects.toMatchObject({ errorCode: "active_turn_busy" });

    await client.request("thread/delete", { threadId: thread.thread.id });
    expect(sdk.deleted).toEqual([thread.thread.id]);
  });

  it("fails turns with classified errors and rejects threads it does not own", async () => {
    sdk.script = async function* (session) {
      await session.nextPrompt();
      yield { type: "assistant", parent_tool_use_id: null, error: "authentication_failed", message: { id: "m1", content: [{ type: "text", text: "Invalid API key · Please run /login" }] } };
      yield result({ is_error: true, result: "Invalid API key · Please run /login", modelUsage: {} });
    };
    const { client, notifications } = createClient();
    const thread = await client.request<{ thread: { id: string } }>("thread/start", { cwd: "/workspace" });
    await client.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "hi" }] });
    const completed = await waitFor(() => notifications.find((entry) => entry.method === "turn/completed"), "failed turn") as any;
    expect(completed.params.turn).toMatchObject({ status: "failed", error: { claudeErrorType: "authentication_failed" } });
    expect(classifyClaudeCodeError({ error: completed.params.turn.error }).code).toBe("authentication_failed");
    expect(notifications.some((entry) => entry.method === "item/completed")).toBe(false);

    await expect(client.request("thread/resume", { threadId: "019a0000-0000-7000-8000-000000000000" }))
      .rejects.toThrow("不是由当前节点的 Claude Code 运行时创建");
    await expect(client.request("thread/resume", { threadId: "../../etc" })).rejects.toThrow("无效");
    await expect(client.request("unknown/method", {})).rejects.toMatchObject({ code: -32601 });
  });
});

describe("Claude Code runtime thread state", () => {
  it("keeps the thread model, refuses lost transcripts and drops recovered errors", async () => {
    let turns = 0;
    sdk.script = async function* (session) {
      await session.nextPrompt();
      turns += 1;
      if (turns === 2) {
        // A recovered error must not label a later, unrelated failure.
        yield { type: "assistant", parent_tool_use_id: null, error: "max_output_tokens", message: { id: "m2", content: [{ type: "text", text: "cut" }] } };
        yield { type: "assistant", parent_tool_use_id: null, message: { id: "m3", content: [{ type: "text", text: "recovered" }] } };
        yield result({ is_error: true, result: "Something else failed" });
      } else {
        yield result();
      }
      await session.nextPrompt();
    };
    const { client, notifications } = createClient();
    const { thread } = await client.request<{ thread: { id: string } }>("thread/start", { cwd: "/workspace", model: "sonnet" });
    const runTurn = async (extra: Record<string, unknown> = {}) => {
      const before = notifications.filter((entry) => entry.method === "turn/completed").length;
      await client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "go" }], ...extra });
      return waitFor(() => notifications.filter((entry) => entry.method === "turn/completed")[before] as any, "turn completion");
    };

    await runTurn();
    sdk.sessions.add(thread.id);
    const failed = await runTurn({ model: "haiku" });
    expect(failed.params.turn).toMatchObject({ status: "failed", error: { message: "Something else failed" } });
    expect(failed.params.turn.error.claudeErrorType).toBeUndefined();
    await runTurn();
    expect(sdk.options.map((options) => options.model)).toEqual(["sonnet", "haiku", "haiku"]);

    sdk.sessions.delete(thread.id);
    const lost = await runTurn();
    expect(lost.params.turn).toMatchObject({ status: "failed" });
    expect(lost.params.turn.error.message).toContain("会话记录已不存在");
    expect(sdk.options).toHaveLength(3);
  });
});

describe("Claude Code runtime mapping", () => {
  it("classifies Claude failures into the shared error codes", () => {
    const code = (error: Record<string, unknown>, willRetry = false) => classifyClaudeCodeError({ error, willRetry }).code;
    expect(code({ message: "Prompt is too long" })).toBe("context_window_exceeded");
    expect(code({ message: "x", claudeErrorType: "rate_limit" })).toBe("rate_limit_exceeded");
    expect(code({ message: "Claude AI usage limit reached" })).toBe("usage_limit_exceeded");
    expect(code({ message: "x", claudeErrorType: "overloaded" })).toBe("service_unavailable");
    expect(code({ message: "x", httpStatusCode: 401 })).toBe("authentication_failed");
    expect(code({ message: "x", claudeErrorType: "error_max_turns" })).toBe("session_budget_exceeded");
    expect(code({ message: "spawn claude ENOENT", claudeErrorType: "spawn_failed" })).toBe("service_unavailable");
    expect(code({ message: "5-hour limit reached ∙ resets 3pm" })).toBe("usage_limit_exceeded");
    expect(code({ message: "Rate limit reached", claudeErrorType: "rate_limit" })).toBe("rate_limit_exceeded");
    expect(code({ message: "Error: --input-format=stream-json requires --output-format=stream-json" })).toBe("unknown");
    expect(code({ message: "API Error: Connection error." })).toBe("stream_interrupted");
    expect(classifyClaudeCodeError({ error: { message: "x", claudeErrorType: "server_error" }, willRetry: true }).willRetry).toBe(true);
  });

  it("maps AskUserQuestion answers and generic tool approvals", () => {
    const input = { questions: [{ question: "Which DB?", header: "DB", options: [{ label: "SQLite", description: "" }], multiSelect: false }] };
    expect(permissionFromResponse("item/tool/requestUserInput", input, { answers: { 0: { answers: ["SQLite"] } } }).result)
      .toEqual({ behavior: "allow", updatedInput: { ...input, answers: { "Which DB?": "SQLite" } } });
    expect(permissionFromResponse("item/tool/requestUserInput", input, { answers: {} }).result.behavior).toBe("deny");
    expect(permissionFromResponse("item/permissions/requestApproval", {}, { permissions: { tool: "WebFetch" }, scope: "session" }))
      .toEqual({ result: { behavior: "allow", updatedInput: {} }, rememberForSession: true });
    expect(permissionFromResponse("item/permissions/requestApproval", {}, { permissions: {}, scope: "turn" }).result.behavior).toBe("deny");
    expect(permissionFromResponse("item/fileChange/requestApproval", {}, { decision: "decline" }).result.behavior).toBe("deny");
    expect(permissionFromResponse("item/fileChange/requestApproval", {}, null).result.behavior).toBe("deny");
  });

  it("publishes Claude models in the Codex catalog shape", () => {
    expect(parseModelCatalog({
      data: [
        modelCatalogEntry({ value: "default", displayName: "Default (recommended)", description: "", supportedEffortLevels: ["low", "max"], supportsFastMode: true }),
        modelCatalogEntry({ value: "haiku", displayName: "Haiku 5.5", description: "" }),
      ],
    })).toEqual([
      {
        id: "default", displayName: "Default (recommended)", isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "max" }],
        supportsFastMode: true, fastServiceTier: "fast",
      },
      { id: "haiku", displayName: "Haiku 5.5", isDefault: false, supportedReasoningEfforts: [], supportsFastMode: false },
    ]);
  });

  it("declares a sandbox only for root --yolo runs the operator has not configured", () => {
    expect(needsSandboxDeclaration(true, 0, {})).toBe(true);
    expect(needsSandboxDeclaration(true, 0, { IS_SANDBOX: "0" })).toBe(false);
    expect(needsSandboxDeclaration(true, 1000, {})).toBe(false);
    expect(needsSandboxDeclaration(false, 0, {})).toBe(false);
  });

  it("resolves executables from PATH like a shell", () => {
    expect(resolveExecutable("sh", "/nonexistent:/bin")).toBe("/bin/sh");
    expect(resolveExecutable("definitely-not-a-claude-binary", "/bin")).toBeNull();
  });
});
