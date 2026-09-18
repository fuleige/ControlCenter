import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, dismissRunError, formatErrorMessage, isWorkspaceConcurrencyConflict, listNodes, openWorkspaceFile } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API errors", () => {
  it("preserves business errors with HTTP and request diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "节点当前离线" }), {
      status: 409,
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "request-409",
      },
    })));

    let captured: unknown;
    try {
      await listNodes();
    } catch (reason) {
      captured = reason;
    }

    expect(captured).toBeInstanceOf(ApiError);
    expect(captured).toMatchObject({
      kind: "http",
      status: 409,
      method: "GET",
      path: "/api/nodes",
      requestId: "request-409",
      message: "节点当前离线",
    });
    expect(formatErrorMessage(captured, "刷新节点状态"))
      .toBe("刷新节点状态失败：节点当前离线（HTTP 409 · GET /api/nodes · 请求 ID request-409）");
  });

  it("classifies fetch failures as network errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));

    await expect(listNodes()).rejects.toMatchObject({
      kind: "network",
      status: null,
      method: "GET",
      path: "/api/nodes",
    });

    try {
      await listNodes();
    } catch (reason) {
      expect(formatErrorMessage(reason, "刷新节点状态"))
        .toContain("无法连接控制中心，请检查当前网络、HTTPS 域名或反向代理（GET /api/nodes）");
    }
  });

  it("preserves workspace concurrency conflict codes for confirmation flows", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "工作空间已有正在运行或排队的任务",
      code: "workspace_busy",
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    })));

    let captured: unknown;
    try {
      await listNodes();
    } catch (reason) {
      captured = reason;
    }

    expect(captured).toMatchObject({ status: 409, code: "workspace_busy" });
    expect(isWorkspaceConcurrencyConflict(captured)).toBe(true);
  });

  it("does not expose an HTML proxy error page as a business error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Bad Gateway</html>", {
      status: 502,
      headers: { "Content-Type": "text/html" },
    })));

    let captured: unknown;
    try {
      await listNodes();
    } catch (reason) {
      captured = reason;
    }

    expect(captured).toMatchObject({ kind: "http", status: 502, message: "控制中心服务异常" });
    expect(formatErrorMessage(captured, "刷新节点状态")).not.toContain("<html>");
  });

  it("reports malformed successful responses separately", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    })));

    let captured: unknown;
    try {
      await listNodes();
    } catch (reason) {
      captured = reason;
    }

    expect(captured).toMatchObject({ kind: "invalid-response", status: 200 });
    expect(formatErrorMessage(captured, "刷新节点状态"))
      .toContain("请检查反向代理是否返回了错误页面");
  });
});

describe("workspace file API", () => {
  it("marks automatically embedded resources as excluded from file history", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _request?: RequestInit) => new Response(JSON.stringify({
      file: {
        id: "file-image",
        conversationId: "conversation-1",
        name: "preview.png",
        path: "/workspace/preview.png",
        mediaType: "image/png",
        size: 12,
        expiresAt: "2026-09-18T12:00:00.000Z",
        contentUrl: "/api/workspace-files/file-image/content",
      },
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await openWorkspaceFile("conversation-1", "preview.png", "file-markdown", { recordHistory: false });

    const [, request] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(request?.body))).toEqual({
      path: "preview.png",
      baseFileId: "file-markdown",
      recordHistory: false,
    });
  });
});

describe("run error API", () => {
  it("persists dismissal through the run error endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await dismissRunError("run-restarted");

    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-restarted/error/dismiss", expect.objectContaining({
      method: "POST",
      credentials: "include",
    }));
  });
});
