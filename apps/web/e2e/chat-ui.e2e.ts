import { expect, test, type Page } from "@playwright/test";

const now = "2026-09-10T00:00:00.000Z";
const node = {
  id: "qa-node",
  name: "移动工作站",
  reportedName: "qa-node",
  platform: "linux",
  arch: "x64",
  agentVersion: "0.1.0",
  codexVersion: "codex-cli 0.153.0",
  permissionMode: "danger-full-access",
  maxConcurrentRuns: 3,
  activeRuns: 1,
  status: "online",
  lastSeenAt: now,
  workspaces: [{
    id: "qa-workspace",
    nodeId: "qa-node",
    name: "Controller Center",
    path: "/workspace/controller-center",
    source: "default",
    isDefault: true,
    status: "valid",
    validationError: null,
    lastValidatedAt: now,
    archivedAt: null,
    conversationCount: 1,
    createdAt: now,
    updatedAt: now,
  }],
  models: [{
    id: "gpt-6-astra",
    displayName: "GPT-6-Astra",
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort })),
  }],
};

const conversation = {
  id: "qa-conversation",
  nodeId: "qa-node",
  workspaceId: "qa-workspace",
  title: "检查长内容、代码与公式",
  model: "gpt-6-astra",
  effort: "high",
  clientRequestId: "qa-request",
  remoteThreadId: "qa-thread",
  status: "ready",
  error: null,
  pinnedAt: null,
  latestRunStatus: "running",
  tokenUsage: {
    totalTokens: 456_789,
    contextTokens: 123_456,
    modelContextWindow: 400_000,
    updatedAt: now,
  },
  createdAt: now,
  updatedAt: now,
};

const run = {
  id: "qa-run",
  conversationId: conversation.id,
  prompt: "请给出包含代码块、表格和公式的完整说明。",
  model: "gpt-6-astra",
  effort: "high",
  clientRequestId: "qa-run-request",
  remoteTurnId: "qa-turn",
  status: "running",
  progressPhase: "working",
  progressLabel: "正在处理文件",
  progressUpdatedAt: now,
  recoveryDeadlineAt: null,
  error: null,
  createdAt: now,
  startedAt: now,
  finishedAt: null,
};

const markdown = String.raw`# 渲染检查

这是一个包含 **粗体**、列表、表格、行内公式 $E = mc^2$、Codex 常用的公式 \(a^2+b^2=c^2\) 和链接的流式回答。

## 代码块

~~~typescript
export async function scheduleTask(clientId: string, prompt: string) {
  const response = await fetch(\`/api/clients/\${clientId}/tasks\`, { method: "POST", body: JSON.stringify({ prompt, stream: true, veryLongConfigurationName: "abcdefghijklmnopqrstuvwxyz-0123456789" }) });
  return response.json();
}
~~~

## 公式

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

\[
\boxed{\sum_{k=1}^{n} k = \frac{n(n+1)}{2}}
\]

## 状态表

| 状态 | 含义 | 用户操作 |
| --- | --- | --- |
| running | 正在持续接收增量内容 | 可以中止 |
| waiting | 等待用户确认 | 处理审批 |
| completed | 本轮执行完成 | 继续对话 |

> 长内容必须只让消息区域滚动，不能把输入框或整个页面顶出可视区域。

1. 第一项检查滚动。
2. 第二项检查代码横向滚动。
3. 第三项检查移动端宽度。

[打开本地报告](/home/ubuntu/documents/report.md) · [打开脚本](/home/ubuntu/documents/task.py) · [访问外部文档](https://example.com/docs)

${"补充说明：流式内容到达时保持在底部；用户主动向上阅读后停止自动跟随。\n\n".repeat(14)}`;

const longConversationHistory = Array.from({ length: 160 }, (_, index) => {
  const occurredAt = new Date(Date.parse(now) - (160 - index) * 1_000).toISOString();
  return {
    id: `history-message-${index}`,
    conversationId: conversation.id,
    runId: null,
    role: index % 2 === 0 ? "user" : "assistant",
    content: index % 2 === 0
      ? `历史任务 ${index + 1}：检查第 ${index + 1} 个模块。`
      : `历史回复 ${index + 1}\n\n已完成这一阶段的检查，并保留了简要结果。`,
    revision: 1,
    complete: true,
    attachmentIds: [],
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
});

async function mockControlCenter(page: Page, options: {
  idleConversation?: boolean;
  paginatedHistory?: boolean;
  unopenedNode?: boolean;
  historyCollapsed?: boolean;
} = {}) {
  const presenceReports: Array<{ conversationId?: string | null; visible?: boolean }> = [];
  const quickSearchRequests: string[] = [];
  const compactRequests: Array<{ clientRequestId?: string }> = [];
  const workspaceFileRequests: Array<{ path?: string; baseFileId?: string; recordHistory?: boolean }> = [];
  let workspaceFileHistory: Array<{
    id: string;
    conversationId: string;
    path: string;
    name: string;
    mediaType: string;
    size: number;
    openCount: number;
    firstOpenedAt: string;
    lastOpenedAt: string;
  }> = [];
  let workspaceFileHistoryClock = 0;
  let compactionState: Record<string, unknown> | null = null;
  const conversationResponse = () => ({
    ...conversation,
    latestRunStatus: options.idleConversation ? "completed" : conversation.latestRunStatus,
    compaction: compactionState,
  });
  const runResponse = options.idleConversation
    ? { ...run, status: "completed", remoteTurnId: null, progressPhase: null, progressLabel: null, finishedAt: now }
    : run;
  await page.addInitScript(({ unopenedNode, historyCollapsed }) => {
    sessionStorage.setItem("controller-center:selected-node", "qa-node");
    if (!unopenedNode) sessionStorage.setItem("controller-center:selected-conversation", "qa-conversation");
    if (historyCollapsed) localStorage.setItem("controller-center:history-collapsed", "true");
  }, { unopenedNode: Boolean(options.unopenedNode), historyCollapsed: Boolean(options.historyCollapsed) });
  await page.context().route("https://images.example.test/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    });
  });
  await page.context().route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/session") {
      await route.fulfill({ json: { authenticated: true, expiresAt: "2026-10-10T00:00:00.000Z" } });
    } else if (url.pathname === "/api/stream") {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: ready\ndata: {}\n\n" });
    } else if (url.pathname === "/api/nodes") {
      await route.fulfill({ json: { data: [node] } });
    } else if (url.pathname === `/api/nodes/${node.id}/workspaces`) {
      await route.fulfill({ json: { data: node.workspaces } });
    } else if (url.pathname === "/api/conversations") {
      if (!url.searchParams.has("nodeId")) quickSearchRequests.push(url.search);
      await route.fulfill({ json: { data: [conversationResponse()] } });
    } else if (url.pathname === `/api/conversations/${conversation.id}/workspace-file-history` && route.request().method() === "GET") {
      await route.fulfill({ json: { data: workspaceFileHistory } });
    } else if (url.pathname.startsWith(`/api/conversations/${conversation.id}/workspace-file-history/`) && route.request().method() === "DELETE") {
      const fileId = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf("/") + 1));
      workspaceFileHistory = workspaceFileHistory.filter((file) => file.id !== fileId);
      await route.fulfill({ status: 204 });
    } else if (url.pathname === `/api/conversations/${conversation.id}/workspace-files`) {
      const request = route.request().postDataJSON() as { path?: string; baseFileId?: string; recordHistory?: boolean };
      workspaceFileRequests.push(request);
      const tsv = request.path === "data.tsv";
      const script = request.path === "/home/ubuntu/documents/task.py";
      const image = request.path === "preview.png";
      const html = request.path === "/home/ubuntu/documents/interactive.html";
      const stylesheet = request.path === "theme.css";
      const htmlScript = request.path === "page.js";
      const details = request.path === "details.md";
      const fileInfo = html
        ? { id: "workspace-file-html", historyId: "history-html", path: "/home/ubuntu/documents/interactive.html", name: "interactive.html", mediaType: "text/html; charset=utf-8" }
        : stylesheet
          ? { id: "workspace-file-css", historyId: "history-css", path: "/home/ubuntu/documents/theme.css", name: "theme.css", mediaType: "text/css; charset=utf-8" }
          : htmlScript
            ? { id: "workspace-file-html-script", historyId: "history-html-script", path: "/home/ubuntu/documents/page.js", name: "page.js", mediaType: "text/javascript; charset=utf-8" }
            : details
              ? { id: "workspace-file-details", historyId: "history-details", path: "/home/ubuntu/documents/details.md", name: "details.md", mediaType: "text/markdown; charset=utf-8" }
      : tsv
        ? { id: "workspace-file-tsv", historyId: "history-tsv", path: "/home/ubuntu/documents/data.tsv", name: "data.tsv", mediaType: "text/tab-separated-values; charset=utf-8" }
        : script
          ? { id: "workspace-file-script", historyId: "history-script", path: "/home/ubuntu/documents/task.py", name: "task.py", mediaType: "text/x-python; charset=utf-8" }
          : image
            ? { id: "workspace-file-image", historyId: "history-image", path: "/home/ubuntu/documents/preview.png", name: "preview.png", mediaType: "image/png" }
          : { id: "workspace-file-markdown", historyId: "history-markdown", path: "/home/ubuntu/documents/report.md", name: "report.md", mediaType: "text/markdown; charset=utf-8" };
      let history;
      if (request.recordHistory !== false) {
        workspaceFileHistoryClock += 1;
        const existingHistory = workspaceFileHistory.find((file) => file.path === fileInfo.path);
        const openedAt = new Date(Date.parse(now) + workspaceFileHistoryClock * 1_000).toISOString();
        history = {
          id: existingHistory?.id ?? fileInfo.historyId,
          conversationId: conversation.id,
          path: fileInfo.path,
          name: fileInfo.name,
          mediaType: fileInfo.mediaType,
          size: 64,
          openCount: (existingHistory?.openCount ?? 0) + 1,
          firstOpenedAt: existingHistory?.firstOpenedAt ?? openedAt,
          lastOpenedAt: openedAt,
        };
        workspaceFileHistory = [history, ...workspaceFileHistory.filter((file) => file.path !== fileInfo.path)];
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({ status: 201, json: { file: {
        id: fileInfo.id,
        conversationId: conversation.id,
        name: fileInfo.name,
        path: fileInfo.path,
        mediaType: fileInfo.mediaType,
        size: 64,
        expiresAt: "2026-09-10T00:05:00.000Z",
        contentUrl: `/api/workspace-files/${fileInfo.id}/content`,
      }, ...(history ? { history } : {}) } });
    } else if (url.pathname === "/api/workspace-files/workspace-file-markdown") {
      await route.fulfill({ status: 200, json: { file: {
        id: "workspace-file-markdown",
        conversationId: conversation.id,
        name: "report.md",
        path: "/home/ubuntu/documents/report.md",
        mediaType: "text/markdown; charset=utf-8",
        size: 64,
        expiresAt: "2026-09-10T00:05:00.000Z",
        contentUrl: "/api/workspace-files/workspace-file-markdown/content",
      } } });
    } else if (url.pathname === "/api/workspace-files/workspace-file-tsv") {
      await route.fulfill({ status: 200, json: { file: {
        id: "workspace-file-tsv",
        conversationId: conversation.id,
        name: "data.tsv",
        path: "/home/ubuntu/documents/data.tsv",
        mediaType: "text/tab-separated-values; charset=utf-8",
        size: 64,
        expiresAt: "2026-09-10T00:05:00.000Z",
        contentUrl: "/api/workspace-files/workspace-file-tsv/content",
      } } });
    } else if (url.pathname === "/api/workspace-files/workspace-file-script") {
      await route.fulfill({ status: 200, json: { file: {
        id: "workspace-file-script",
        conversationId: conversation.id,
        name: "task.py",
        path: "/home/ubuntu/documents/task.py",
        mediaType: "text/x-python; charset=utf-8",
        size: 64,
        expiresAt: "2026-09-10T00:05:00.000Z",
        contentUrl: "/api/workspace-files/workspace-file-script/content",
      } } });
    } else if (url.pathname === "/api/workspace-files/workspace-file-image") {
      await route.fulfill({ status: 200, json: { file: {
        id: "workspace-file-image",
        conversationId: conversation.id,
        name: "preview.png",
        path: "/home/ubuntu/documents/preview.png",
        mediaType: "image/png",
        size: 68,
        expiresAt: "2026-09-10T00:05:00.000Z",
        contentUrl: "/api/workspace-files/workspace-file-image/content",
      } } });
    } else if (url.pathname === "/api/workspace-files/workspace-file-svg") {
      await route.fulfill({ status: 200, json: { file: {
        id: "workspace-file-svg",
        conversationId: conversation.id,
        name: "unsafe.svg",
        path: "/home/ubuntu/documents/unsafe.svg",
        mediaType: "image/svg+xml",
        size: 256,
        expiresAt: "2026-09-10T00:05:00.000Z",
        contentUrl: "/api/workspace-files/workspace-file-svg/content",
      } } });
    } else if (url.pathname === "/api/workspace-files/workspace-file-html") {
      await route.fulfill({ status: 200, json: { file: {
        id: "workspace-file-html",
        conversationId: conversation.id,
        name: "interactive.html",
        path: "/home/ubuntu/documents/interactive.html",
        mediaType: "text/html; charset=utf-8",
        size: 256,
        expiresAt: "2026-09-10T00:05:00.000Z",
        contentUrl: "/api/workspace-files/workspace-file-html/content",
      } } });
    } else if (url.pathname === "/api/workspace-files/workspace-file-details") {
      await route.fulfill({ status: 200, json: { file: {
        id: "workspace-file-details",
        conversationId: conversation.id,
        name: "details.md",
        path: "/home/ubuntu/documents/details.md",
        mediaType: "text/markdown; charset=utf-8",
        size: 64,
        expiresAt: "2026-09-10T00:05:00.000Z",
        contentUrl: "/api/workspace-files/workspace-file-details/content",
      } } });
    } else if (url.pathname === "/api/workspace-files/workspace-file-markdown/content") {
      await route.fulfill({ status: 200, contentType: "text/markdown; charset=utf-8", body: "# Agent 报告\n\n这是一份由当前 Agent 生成的示例文档，用于确认文件预览页面的阅读体验。\n\n[跳到本次处理](#本次处理)\n\n## 本次处理\n\n- 文件内容已从 Agent 工作目录安全读取\n- Markdown 保持原有结构和链接能力\n- 较窄内容在页面中居中展示\n\n<details open><summary>安全原生 HTML</summary>白名单内容可见</details><script data-unsafe-script>document.body.dataset.unsafe='true'</script>\n\n![Agent 生成的预览图](preview.png)\n\n![外部图片](https://images.example.test/external.png)\n\n```mermaid\ngraph LR\n  Agent --> Preview\n```\n\n> 文件为只读临时预览，重新打开时会读取最新内容。\n\n[打开相对表格](data.tsv)" });
    } else if (url.pathname === "/api/workspace-files/workspace-file-tsv/content") {
      await route.fulfill({ status: 200, contentType: "text/tab-separated-values; charset=utf-8", body: "名称\t数值\nalpha\t1\nbeta\t2" });
    } else if (url.pathname === "/api/workspace-files/workspace-file-script/content") {
      await route.fulfill({ status: 200, contentType: "text/x-python; charset=utf-8", body: "def main():\n    print('hello')\nmain()\n" });
    } else if (url.pathname === "/api/workspace-files/workspace-file-image/content") {
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
      });
    } else if (url.pathname === "/api/workspace-files/workspace-file-svg/content") {
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"240\" height=\"120\" onload=\"document.body.dataset.svgExecuted='true'\"><script>document.body.dataset.svgExecuted='true'</script><rect width=\"240\" height=\"120\" rx=\"16\" fill=\"#dbeafe\"/><text x=\"120\" y=\"68\" text-anchor=\"middle\" font-size=\"22\">安全 SVG 预览</text></svg>",
      });
    } else if (url.pathname === "/api/workspace-files/workspace-file-html/content") {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><html><head><link rel=\"stylesheet\" href=\"theme.css\"></head><body><main class=\"card\"><h1>交互页面</h1><img src=\"preview.png\" alt=\"HTML 本地图片\"><p id=\"script-status\">等待脚本</p><a href=\"details.md\">打开详情文档</a></main><script src=\"page.js\"></script></body></html>",
      });
    } else if (url.pathname === "/api/workspace-files/workspace-file-css/content") {
      await route.fulfill({ status: 200, contentType: "text/css; charset=utf-8", body: ".card{padding:32px;background:#eef5ff;color:#17365d}img{width:48px;height:48px}" });
    } else if (url.pathname === "/api/workspace-files/workspace-file-html-script/content") {
      await route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: "document.querySelector('#script-status').textContent='脚本已执行';" });
    } else if (url.pathname === "/api/workspace-files/workspace-file-details/content") {
      await route.fulfill({ status: 200, contentType: "text/markdown; charset=utf-8", body: "# 详情文档\n\nHTML 内的相对链接已通过原 Agent 打开。" });
    } else if (url.pathname === `/api/conversations/${conversation.id}/compact`) {
      compactRequests.push(route.request().postDataJSON() as { clientRequestId?: string });
      compactionState = {
        id: "qa-compaction",
        status: "running",
        beforeContextTokens: conversation.tokenUsage.contextTokens,
        afterContextTokens: null,
        errorCode: null,
        error: null,
        requestedAt: now,
        startedAt: now,
        finishedAt: null,
        recoveryDeadlineAt: null,
      };
      await route.fulfill({ status: 202, json: { compaction: compactionState, dispatched: true, deduplicated: false } });
    } else if (url.pathname === `/api/conversations/${conversation.id}`) {
      await route.fulfill({
        json: {
          conversation: conversationResponse(),
          runs: [runResponse],
          approvals: [],
          attachments: [],
          messages: [...longConversationHistory, {
            id: "qa-user-message",
            conversationId: conversation.id,
            runId: run.id,
            role: "user",
            content: run.prompt,
            revision: 1,
            complete: true,
            attachmentIds: [],
            createdAt: now,
            updatedAt: now,
          }, {
            id: "qa-agent-message",
            conversationId: conversation.id,
            runId: run.id,
            role: "assistant",
            content: markdown,
            revision: 4,
            complete: false,
            attachmentIds: [],
            createdAt: "2026-09-10T00:00:01.000Z",
            updatedAt: "2026-09-10T00:00:02.000Z",
          }],
          messagePage: options.paginatedHistory
            ? url.searchParams.has("beforeMessage")
              ? { hasMore: false, before: null }
              : { hasMore: true, before: "older-message-cursor" }
            : { hasMore: false, before: null },
        },
      });
    } else if (url.pathname === "/api/approvals") {
      await route.fulfill({ json: { data: [] } });
    } else if (url.pathname === "/api/settings") {
      await route.fulfill({ json: { settings: { defaultModel: null, defaultEffort: null } } });
    } else if (url.pathname === "/api/task-center") {
      await route.fulfill({ json: {
        data: [{
          id: "notification-1",
          nodeId: node.id,
          nodeName: node.name,
          conversationId: conversation.id,
          conversationTitle: conversation.title,
          runId: run.id,
          status: "completed",
          progressLabel: "任务已完成",
          replyPreview: "这是最新回复的摘要，点击后可以直接返回对应会话。",
          unread: true,
          occurredAt: now,
        }],
        unreadCount: 1,
        policy: { limit: 200, replyPreviewCharacters: 120, readRetentionDays: 30, unreadRetentionDays: 90 },
      } });
    } else if (url.pathname === "/api/ui/presence") {
      presenceReports.push(route.request().postDataJSON() as { conversationId?: string | null; visible?: boolean });
      await route.fulfill({ status: 204 });
    } else {
      await route.fulfill({ status: 204 });
    }
  });
  return { presenceReports, quickSearchRequests, compactRequests, workspaceFileRequests };
}

test("对话本地链接由当前 Agent 读取并在新标签页支持相对 TSV 预览", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "文件预览行为在桌面项目验证一次");
  const { workspaceFileRequests } = await mockControlCenter(page);
  await page.goto("/");

  const externalLink = page.getByRole("link", { name: "访问外部文档" });
  await expect(externalLink).toHaveAttribute("href", "https://example.com/docs");
  await expect(externalLink).toHaveAttribute("target", "_blank");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "打开本地报告" }).click();
  const preview = await popupPromise;
  await expect(preview).toHaveURL(/\/workspace-files\/opening$/u);
  await expect(preview.getByRole("status")).toContainText("正在读取文件");
  await expect(preview).toHaveURL(/\/workspace-files\/workspace-file-markdown$/u);
  await expect(preview.getByRole("heading", { name: "report.md" })).toBeVisible();
  await expect(preview.getByRole("heading", { name: "Agent 报告" })).toBeVisible();
  await expect(preview.getByRole("heading", { name: "本次处理" })).toHaveAttribute("id", "cc-md-本次处理");
  const documentAnchor = preview.getByRole("link", { name: "跳到本次处理" });
  await expect(documentAnchor).toHaveAttribute("href", `#cc-md-${encodeURIComponent("本次处理")}`);
  await expect(documentAnchor).not.toHaveAttribute("target", "_blank");
  await expect(preview.getByLabel("文件信息")).toContainText("Markdown");
  await expect(preview.getByText("安全原生 HTML")).toBeVisible();
  await expect(preview.locator("script[data-unsafe-script]")).toHaveCount(0);
  await expect(preview.getByRole("img", { name: "Agent 生成的预览图" })).toBeVisible();
  await expect(preview.getByRole("img", { name: "外部图片" })).toBeVisible();
  await expect(preview.locator(".mermaid-diagram svg")).toBeVisible();
  expect(workspaceFileRequests.findLast((request) => request.path === "preview.png")).toEqual({
    path: "preview.png",
    baseFileId: "workspace-file-markdown",
    recordHistory: false,
  });
  const previewColors = await preview.locator(".workspace-file-page").evaluate((pageElement) => ({
    canvas: getComputedStyle(pageElement).backgroundColor,
    panel: getComputedStyle(document.querySelector(".workspace-file-content")!).backgroundColor,
  }));
  expect(previewColors).toEqual({ canvas: "rgb(243, 246, 250)", panel: "rgb(255, 255, 255)" });
  await preview.screenshot({ path: "/tmp/controller-center-file-preview-markdown.png", fullPage: true });
  const previewLayout = await preview.locator(".workspace-file-viewer").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  expect(previewLayout.left).toBe(0);
  expect(previewLayout.top).toBe(0);
  expect(previewLayout.width).toBe(previewLayout.viewportWidth);
  expect(previewLayout.height).toBe(previewLayout.viewportHeight);
  expect(workspaceFileRequests[0]).toEqual({ path: "/home/ubuntu/documents/report.md" });

  const fileRail = page.getByRole("button", { name: "展开本会话文件，1 个历史文件" });
  await expect(fileRail).toBeVisible();
  await fileRail.click();
  const filePanel = page.getByRole("complementary", { name: "本会话文件" });
  await expect(filePanel).toBeVisible();
  await expect(filePanel).toContainText("report.md");
  await page.screenshot({ path: "/tmp/controller-center-files-desktop.png", fullPage: true });
  const reopenPromise = page.waitForEvent("popup");
  await filePanel.locator(".conversation-file-open").click();
  const reopenedPreview = await reopenPromise;
  await expect(reopenedPreview).toHaveURL(/\/workspace-files\/workspace-file-markdown$/u);
  await reopenedPreview.close();
  expect(workspaceFileRequests.filter((request) => request.path === "/home/ubuntu/documents/report.md")).toHaveLength(2);
  await filePanel.getByRole("button", { name: "删除 report.md 的查看记录" }).click();
  await expect(filePanel).toContainText("还没有添加文件");

  await filePanel.locator(".conversation-files-add-toggle").click();
  const pathInput = filePanel.getByLabel("Agent 文件路径");
  await page.screenshot({ path: "/tmp/controller-center-files-add-desktop.png", fullPage: true });
  await pathInput.fill("https://example.com/task.py");
  await filePanel.locator(".conversation-files-add-form").getByRole("button", { name: "添加" }).click();
  await expect(filePanel.locator(".conversation-files-add-form").getByRole("alert")).toHaveText("请输入 Agent 本地文件路径，而不是网页地址");
  await pathInput.fill("/home/ubuntu/documents/task.py");
  const pageCountBeforeAdd = page.context().pages().length;
  await filePanel.locator(".conversation-files-add-form").getByRole("button", { name: "添加" }).click();
  await expect(filePanel.locator(".conversation-files-add-form").getByRole("button", { name: "验证中" })).toBeDisabled();
  await expect(filePanel.locator(".conversation-file-row").first()).toContainText("task.py");
  await expect(filePanel.locator(".conversation-files-add-form")).toHaveCount(0);
  expect(page.context().pages()).toHaveLength(pageCountBeforeAdd);
  expect(workspaceFileRequests.findLast((request) => request.path === "/home/ubuntu/documents/task.py")).toEqual({ path: "/home/ubuntu/documents/task.py" });

  const nestedPopupPromise = preview.waitForEvent("popup");
  await preview.getByRole("link", { name: "打开相对表格" }).click();
  const nestedPreview = await nestedPopupPromise;
  await expect(preview).toHaveURL(/\/workspace-files\/workspace-file-markdown$/u);
  await expect(nestedPreview).toHaveURL(/\/workspace-files\/workspace-file-tsv$/u);
  await expect(nestedPreview.getByRole("cell", { name: "alpha" })).toBeVisible();
  await expect(nestedPreview.getByRole("cell", { name: "2" })).toBeVisible();
  await expect(nestedPreview.getByRole("rowheader", { name: "1" })).toBeVisible();
  await expect(nestedPreview.getByRole("rowheader", { name: "2" })).toBeVisible();
  await expect(nestedPreview.locator(".workspace-file-table-summary")).toHaveText("2 条记录 · 2 个字段");
  await nestedPreview.screenshot({ path: "/tmp/controller-center-file-preview-tsv.png", fullPage: true });
  expect(workspaceFileRequests.findLast((request) => request.path === "data.tsv")).toEqual({ path: "data.tsv", baseFileId: "workspace-file-markdown" });
  await nestedPreview.close();

  const scriptPopupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "打开脚本" }).click();
  const scriptPreview = await scriptPopupPromise;
  await expect(scriptPreview).toHaveURL(/\/workspace-files\/workspace-file-script$/u);
  await expect(scriptPreview.locator(".code-line-numbers")).toHaveText("1\n2\n3");
  const sourceLayout = await scriptPreview.locator(".workspace-file-content-source").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const codeStyle = getComputedStyle(element.querySelector(".code-block-content")!);
    return {
      left: bounds.left,
      right: window.innerWidth - bounds.right,
      width: bounds.width,
      viewportWidth: window.innerWidth,
      fontSize: codeStyle.fontSize,
      lineHeight: codeStyle.lineHeight,
    };
  });
  expect(Math.abs(sourceLayout.left - sourceLayout.right)).toBeLessThanOrEqual(2);
  expect(sourceLayout.width).toBeGreaterThanOrEqual(959);
  expect(sourceLayout.width).toBeLessThan(sourceLayout.viewportWidth);
  expect(sourceLayout.fontSize).toBe("13px");
  expect(Number.parseFloat(sourceLayout.lineHeight)).toBeGreaterThanOrEqual(22);
  await scriptPreview.screenshot({ path: "/tmp/controller-center-file-preview-script.png", fullPage: true });
  await scriptPreview.close();

  await filePanel.getByRole("button", { name: "折叠文件侧边栏" }).click();
  await page.evaluate(() => { window.open = () => null; });
  await page.getByRole("link", { name: "打开本地报告" }).click();
  const chatError = page.locator(".composer-error");
  await expect(chatError).toContainText("浏览器阻止了文件预览标签页");
  await chatError.getByRole("button", { name: "关闭对话错误提示" }).click();
  await expect(chatError).toHaveCount(0);
});

test("HTML 文件使用全屏隔离网页并加载本地样式脚本图片", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "HTML 网页预览行为在桌面项目验证一次");
  const { workspaceFileRequests } = await mockControlCenter(page);
  await page.goto("/workspace-files/workspace-file-html");

  await expect(page.locator(".workspace-file-viewer-html")).toBeVisible();
  await expect(page.locator(".workspace-file-brand")).toContainText("interactive.html");
  await expect(page.locator(".workspace-file-html")).toHaveAttribute("sandbox", /allow-scripts/u);
  await expect(page.locator(".workspace-file-html")).not.toHaveAttribute("sandbox", /allow-same-origin/u);
  const frame = page.frameLocator(".workspace-file-html");
  await expect(frame.getByRole("heading", { name: "交互页面" })).toBeVisible();
  await expect(frame.getByText("脚本已执行")).toBeVisible();
  await expect(frame.getByRole("img", { name: "HTML 本地图片" })).toBeVisible();
  await expect(frame.locator(".card")).toHaveCSS("background-color", "rgb(238, 245, 255)");

  const layout = await page.locator(".workspace-file-viewer-html").evaluate((viewer) => {
    const header = viewer.querySelector(":scope > header")!.getBoundingClientRect();
    const iframe = viewer.querySelector("iframe")!.getBoundingClientRect();
    return {
      headerHeight: header.height,
      iframeWidth: iframe.width,
      iframeHeight: iframe.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  expect(layout.headerHeight).toBeLessThanOrEqual(50);
  expect(layout.iframeWidth).toBe(layout.viewportWidth);
  expect(layout.iframeHeight).toBeGreaterThanOrEqual(layout.viewportHeight - layout.headerHeight - 1);

  for (const resourcePath of ["theme.css", "page.js", "preview.png"]) {
    expect(workspaceFileRequests.findLast((request) => request.path === resourcePath)).toMatchObject({
      path: resourcePath,
      baseFileId: "workspace-file-html",
      recordHistory: false,
    });
  }

  const popupPromise = page.waitForEvent("popup");
  await frame.getByRole("link", { name: "打开详情文档" }).click();
  const detailsPreview = await popupPromise;
  await expect(detailsPreview).toHaveURL(/\/workspace-files\/workspace-file-details$/u);
  await expect(detailsPreview.getByRole("heading", { name: "详情文档" })).toBeVisible();
  expect(workspaceFileRequests.findLast((request) => request.path === "details.md")).toEqual({
    path: "details.md",
    baseFileId: "workspace-file-html",
  });
  await detailsPreview.close();
});

test("SVG 文件以图片上下文预览且不执行内嵌脚本", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "SVG 文件预览行为在桌面项目验证一次");
  await mockControlCenter(page);
  await page.goto("/workspace-files/workspace-file-svg");

  await expect(page.getByRole("heading", { name: "unsafe.svg" })).toBeVisible();
  const image = page.getByRole("img", { name: "unsafe.svg" });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => {
    const candidate = element as HTMLImageElement;
    return candidate.complete && candidate.naturalWidth === 240 && candidate.naturalHeight === 120;
  })).toBe(true);
  await expect.poll(() => page.evaluate(() => document.body.dataset.svgExecuted ?? null)).toBeNull();
});

test("移动端顶部栏可以打开历史抽屉、新建会话和本会话文件侧栏", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "移动端顶部栏只在标准移动项目验证一次");
  await mockControlCenter(page);
  await page.goto("/");

  const topbar = page.locator(".mobile-chat-topbar");
  await expect(topbar).toBeVisible();
  await expect(topbar.getByRole("button", { name: "打开历史会话" })).toBeVisible();
  await expect(topbar.getByRole("button", { name: "新建会话" })).toBeVisible();
  await topbar.getByRole("button", { name: "打开历史会话" }).click();
  await expect(page.locator(".conversations-pane")).toBeVisible();
  await expect(page.locator(".conversations-pane").getByRole("button", { name: "新建会话" })).toBeVisible();
  await page.locator(".mobile-history-backdrop").click({ position: { x: 380, y: 120 } });

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "打开本地报告" }).click();
  const preview = await popupPromise;
  await expect(preview).toHaveURL(/\/workspace-files\/workspace-file-markdown$/u);
  await preview.close();

  const filesButton = topbar.getByRole("button", { name: "打开本会话文件，1 个历史文件" });
  await expect(filesButton).toBeVisible();
  await filesButton.click();
  const filePanel = page.getByRole("complementary", { name: "本会话文件" });
  await expect(filePanel).toBeVisible();
  await expect(filePanel).toContainText("report.md");
  await filePanel.locator(".conversation-files-add-toggle").click();
  await expect(filePanel.getByLabel("Agent 文件路径")).toBeVisible();
  await page.screenshot({ path: "/tmp/controller-center-files-mobile.png", fullPage: true });
  await page.locator(".conversation-files-backdrop").click({ position: { x: 10, y: 120 } });
  await expect(filePanel).toBeHidden();
});

test("节点进入新会话时默认展开历史且恢复会话后保持原有状态", async ({ page }, testInfo) => {
  test.skip(!["desktop", "mobile"].includes(testInfo.project.name), "分别在桌面和标准移动布局验证一次");
  await mockControlCenter(page, { unopenedNode: true, historyCollapsed: true });
  await page.goto("/");

  const layout = page.locator(".layout");
  await expect(page.locator(".conversations-pane")).toBeVisible();
  if (testInfo.project.name === "desktop") {
    await expect(layout).not.toHaveClass(/history-collapsed/u);
  } else {
    await expect(layout).toHaveClass(/mobile-conversations/u);
  }

  await page.locator(".conversation-card").click();
  await expect(page.locator(".chat-title strong")).toHaveText(conversation.title);
  if (testInfo.project.name === "desktop") {
    await page.getByRole("button", { name: "折叠历史会话" }).click();
    await expect(layout).toHaveClass(/history-collapsed/u);
  } else {
    await expect(layout).toHaveClass(/mobile-chat/u);
  }

  await page.reload();
  if (testInfo.project.name === "desktop") {
    await expect(layout).toHaveClass(/history-collapsed/u);
  } else {
    await expect(layout).toHaveClass(/mobile-chat/u);
  }
});

test("手动压缩上下文需要确认并在执行期间锁定输入", async ({ page }) => {
  const { compactRequests } = await mockControlCenter(page, { idleConversation: true });
  await page.goto("/");

  const compactButton = page.getByRole("button", { name: "压缩", exact: true });
  await expect(compactButton).toBeEnabled();
  await compactButton.click();
  const dialog = page.getByRole("dialog", { name: "压缩当前会话？" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("聊天记录仍会保留");
  await expect(dialog).toContainText("会消耗一定 Token");
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeHidden();

  await compactButton.click();
  await dialog.getByRole("button", { name: "确认压缩" }).click();
  await expect.poll(() => compactRequests.length).toBe(1);
  expect(compactRequests[0]?.clientRequestId).toBeTruthy();
  await expect(page.getByRole("button", { name: "正在压缩" })).toBeDisabled();
  await expect(page.locator(".composer textarea")).toBeDisabled();
  await expect(page.locator(".composer textarea")).toHaveAttribute("placeholder", "正在压缩上下文…");
});

test("长对话可以滚动并正确渲染代码、公式和移动布局", async ({ page, context }, testInfo) => {
  const { presenceReports, quickSearchRequests } = await mockControlCenter(page);
  await page.goto("/");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });

  const timeline = page.locator(".timeline");
  await expect(page.locator(".node-permission-badge")).toHaveText("全权限");
  await expect(page.locator(".composer .conversation-usage")).toContainText("总计457k");
  await expect(page.locator(".composer .conversation-usage")).toContainText("窗口400k");
  await expect(page.locator(".composer .conversation-usage")).toContainText("占用31%");
  await expect(page.getByRole("button", { name: "压缩", exact: true })).toBeDisabled();
  await expect(page.locator(".chat-header")).toHaveCount(0);
  await expect(page.locator(".markdown-content").last()).toBeVisible();
  await expect.poll(() => page.locator(".virtual-timeline-row").count()).toBeLessThan(30);
  await expect(page.locator(".katex")).toHaveCount(4);
  const formulaBox = await page.locator(".fbox").first().evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height };
  });
  expect(formulaBox.width).toBeGreaterThan(80);
  expect(formulaBox.height).toBeGreaterThan(20);
  await expect(page.locator(".code-block").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "中止本轮" })).toBeVisible();
  await expect(page.locator(".run-float .status-running .status-spinner")).toBeVisible();
  const currentWorkspace = page.getByRole("group", { name: /当前工作空间：Controller Center/ });
  await expect(currentWorkspace).toContainText("Controller Center");
  await expect(currentWorkspace).toContainText("/workspace/controller-center");
  await expect(page.locator(".composer-toolbar .model-setting > span, .composer-toolbar .effort-setting > span")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "选择模型" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "选择思考强度" })).toBeVisible();
  const composerTypography = await page.locator(".composer textarea").evaluate((element) => {
    const style = getComputedStyle(element);
    return { family: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight };
  });
  const messageTypography = await page.locator(".markdown-content").first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { family: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight };
  });
  const typography = {
    composerFamily: composerTypography.family,
    messageFamily: messageTypography.family,
    composerSize: composerTypography.size,
    messageSize: messageTypography.size,
    composerLineHeight: composerTypography.lineHeight,
    messageLineHeight: messageTypography.lineHeight,
  };
  expect(typography.composerFamily).toBe(typography.messageFamily);
  expect(typography.composerSize).toBe(typography.messageSize);
  expect(typography.composerLineHeight).toBe(typography.messageLineHeight);

  const dimensions = await timeline.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  await timeline.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 160);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect.poll(() => timeline.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeGreaterThanOrEqual(96);
  await expect(page.getByRole("button", { name: "滑动到底部" })).toBeVisible();
  await page.getByRole("button", { name: "滑动到底部" }).click();
  await expect.poll(() => timeline.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2);
  await expect(page.getByRole("button", { name: "滑动到底部" })).toBeHidden();
  await expect(page.getByText("查看原始数据")).toHaveCount(0);

  const codeScroll = page.locator(".code-block-scroll").first();
  const codeDimensions = await codeScroll.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(codeDimensions.scrollWidth).toBeGreaterThan(codeDimensions.clientWidth);
  await page.locator(".code-block-toolbar button").first().click();
  await expect(page.locator(".code-block-toolbar button").first()).toHaveText("已复制");

  const pageWidth = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  expect(pageWidth.document).toBeLessThanOrEqual(pageWidth.viewport);

  const composerInput = page.locator(".composer textarea");
  await timeline.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => timeline.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2);
  const initialInputHeight = await composerInput.evaluate((element) => element.getBoundingClientRect().height);
  await composerInput.fill("追加说明\n".repeat(8));
  await expect.poll(() => composerInput.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(initialInputHeight);
  await expect.poll(() => timeline.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2);
  await expect(page.getByRole("button", { name: "滑动到底部" })).toBeHidden();
  const composerBottom = await page.locator(".composer").evaluate((element) => element.getBoundingClientRect().bottom);
  expect(composerBottom).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
  if (testInfo.project.name !== "desktop") {
    const mobileToolbar = page.locator(".mobile-toolbar");
    await expect(mobileToolbar).toBeVisible();
    const toolbarPosition = await mobileToolbar.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom, viewportHeight: window.innerHeight };
    });
    expect(toolbarPosition.top).toBeGreaterThan(toolbarPosition.viewportHeight / 2);
    expect(toolbarPosition.bottom).toBeLessThanOrEqual(toolbarPosition.viewportHeight);
    await mobileToolbar.getByRole("button", { name: "查看节点" }).click();
    await expect(page.locator(".nodes-pane")).toBeVisible();
    await page.locator(".node-card").filter({ hasText: node.name }).click();
    await expect(page.locator(".chat-title strong")).toHaveText(conversation.title);
    await expect(page.getByRole("button", { name: "打开历史会话" })).toBeVisible();
    const actionBounds = await page.locator(".send-button, .run-float .stop-button").evaluateAll((elements) => elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, viewport: window.innerWidth };
    }));
    expect(actionBounds.every(({ left, right, viewport }) => left >= 0 && right <= viewport)).toBe(true);
    if (testInfo.project.name === "compact-mobile") {
      const toolbar = page.locator(".composer-toolbar");
      const toolbarOverflow = await toolbar.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
      expect(toolbarOverflow.scrollWidth).toBeGreaterThan(toolbarOverflow.clientWidth);
      await toolbar.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      const effortVisible = await page.getByRole("combobox", { name: "选择思考强度" }).evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const toolbarBounds = element.closest(".composer-toolbar")!.getBoundingClientRect();
        return bounds.left >= toolbarBounds.left && bounds.right <= toolbarBounds.right;
      });
      expect(effortVisible).toBe(true);
    }
  }
  await composerInput.fill("");

  await timeline.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 160);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect.poll(() => timeline.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeGreaterThanOrEqual(96);
  await expect(page.getByRole("button", { name: "滑动到底部" })).toBeVisible();
  const readingScrollTop = await timeline.evaluate((element) => element.scrollTop);
  await composerInput.fill("阅读历史消息时继续编辑\n".repeat(8));
  await expect(page.getByRole("button", { name: "滑动到底部" })).toBeVisible();
  await expect.poll(async () => Math.abs(await timeline.evaluate((element) => element.scrollTop) - readingScrollTop)).toBeLessThanOrEqual(2);
  await composerInput.fill("");

  await page.screenshot({ path: `/tmp/controller-center-${testInfo.project.name}.png`, fullPage: true });

  const globalNavigation = testInfo.project.name === "desktop" ? page.locator(".node-footer") : page.locator(".mobile-toolbar");
  await globalNavigation.getByRole("button", { name: /快速切换/ }).click();
  const switcher = page.getByRole("dialog", { name: "快速切换" });
  await expect(switcher).toBeVisible();
  await expect(switcher.getByText("输入节点名称或会话名称开始搜索")).toBeVisible();
  await page.waitForTimeout(250);
  expect(quickSearchRequests).toEqual([]);
  await page.screenshot({ path: `/tmp/controller-center-switcher-${testInfo.project.name}.png`, fullPage: true });
  await switcher.getByRole("textbox", { name: "搜索节点或历史会话" }).fill("检查长内容");
  await expect.poll(() => quickSearchRequests.length).toBe(1);
  expect(new URLSearchParams(quickSearchRequests[0]).get("includeTotal")).toBe("false");
  await switcher.getByRole("button", { name: new RegExp(conversation.title) }).click();
  await expect(switcher).toBeHidden();
  await expect(page.locator(".chat-title strong")).toHaveText(conversation.title);
  await globalNavigation.getByRole("button", { name: "设置" }).click();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
  if (testInfo.project.name !== "desktop") {
    const mobileToolbar = page.locator(".mobile-toolbar");
    await expect(mobileToolbar).toBeVisible();
    await expect(mobileToolbar.locator("button").nth(0)).toContainText("节点1/1");
    await expect(mobileToolbar.locator("button").nth(1)).toContainText("消息");
    await expect(mobileToolbar.locator("button").nth(2)).toContainText("搜索");
    await expect(mobileToolbar.locator("button").nth(3)).toContainText("设置");
    await expect(mobileToolbar.locator(".node-count")).toHaveCount(0);
  }
  await expect(page.locator(".settings-version")).toContainText("v0.3.13");
  await page.locator(".settings-layout nav").getByRole("button", { name: "工作空间" }).click();
  await expect(page.getByRole("region", { name: "工作空间管理" })).toBeVisible();
  await expect(page.locator(".workspace-card")).toContainText("Controller Center");
  await expect(page.locator(".workspace-card")).toContainText("/workspace/controller-center");
  await expect(page.locator(".workspace-card").getByRole("button", { name: "编辑" })).toHaveCount(0);
  await page.getByRole("button", { name: "添加工作空间" }).click();
  await expect(page.getByPlaceholder("例如 /root/codes/project-a")).toBeVisible();
  await page.locator(".workspace-add-form").getByRole("button", { name: "取消" }).click();
  await page.getByRole("button", { name: "关闭设置" }).click();
  if (testInfo.project.name === "desktop") {
    await page.locator(".node-card").filter({ hasText: node.name }).click();
    await expect(page.locator(".chat-title strong")).toHaveText(conversation.title);
  }
  await globalNavigation.getByRole("button", { name: /消息中心|任务中心|全局任务中心/ }).click();
  await expect(page.getByRole("main", { name: "全局任务中心" })).toBeVisible();
  await expect(page.getByText("这是最新回复的摘要，点击后可以直接返回对应会话。")).toBeVisible();
  await expect(page.getByText("最多展示最近 200 条", { exact: false })).toBeVisible();
  await page.getByRole("textbox", { name: "搜索全局任务" }).fill("没有这个任务");
  await expect(page.getByText("这里暂时没有任务")).toBeVisible();
  await page.getByRole("textbox", { name: "搜索全局任务" }).fill("");
  await page.getByRole("combobox", { name: "按节点筛选" }).selectOption(node.id);
  await page.getByRole("button", { name: "全部标为已读" }).click();
  if (testInfo.project.name === "desktop") {
    await expect(page.locator(".nodes-pane")).toBeVisible();
    await expect(page.locator(".conversations-pane")).toBeHidden();
    const taskLayout = await page.locator(".layout").evaluate((layout) => {
      const nodes = layout.querySelector(".nodes-pane")!.getBoundingClientRect();
      const tasks = layout.querySelector(".task-center-page")!.getBoundingClientRect();
      return { nodesRight: nodes.right, tasksLeft: tasks.left };
    });
    expect(Math.abs(taskLayout.nodesRight - taskLayout.tasksLeft)).toBeLessThanOrEqual(1);
  }
  await expect.poll(() => presenceReports.some((report) => report.conversationId === null && report.visible === true)).toBe(true);
  await page.screenshot({ path: `/tmp/controller-center-tasks-${testInfo.project.name}.png`, fullPage: true });
  if (testInfo.project.name === "desktop") {
    await page.locator(".node-card").filter({ hasText: node.name }).click();
    await expect(page.getByRole("main", { name: "全局任务中心" })).toBeHidden();
    await expect(page.locator(".chat-title strong")).toHaveText(conversation.title);
  } else {
    await page.getByRole("button", { name: "返回工作台" }).click();
  }
  await globalNavigation.getByRole("button", { name: /消息中心|任务中心|全局任务中心/ }).click();
  await page.locator(".task-center-item").filter({ hasText: conversation.title }).click();
  await expect(page.locator(".chat-title strong")).toHaveText(conversation.title);
  await expect.poll(() => presenceReports.some((report) => report.conversationId === conversation.id && report.visible === true)).toBe(true);

  if (testInfo.project.name === "desktop") {
    const toggleAlignment = await page.locator(".layout").evaluate((layout) => {
      const nodes = layout.querySelector(".nodes-pane")!.getBoundingClientRect();
      const conversations = layout.querySelector(".conversations-pane")!.getBoundingClientRect();
      const nodeToggle = layout.querySelector(".node-toggle")!.getBoundingClientRect();
      const historyToggle = layout.querySelector(".history-toggle")!.getBoundingClientRect();
      return {
        nodeOffset: Math.abs(nodeToggle.top + nodeToggle.height / 2 - (nodes.top + nodes.height / 2)),
        historyOffset: Math.abs(historyToggle.top + historyToggle.height / 2 - (conversations.top + conversations.height / 2)),
      };
    });
    expect(toggleAlignment.nodeOffset).toBeLessThanOrEqual(1);
    expect(toggleAlignment.historyOffset).toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: "修改 移动工作站 的名称" }).click();
    await expect(page.locator(".node-rename")).toBeVisible();
    expect(Number.parseFloat(await page.locator(".node-rename-field input").evaluate((element) => getComputedStyle(element).fontSize))).toBeLessThanOrEqual(11);
    await page.screenshot({ path: "/tmp/controller-center-desktop-rename.png", fullPage: true });
    await page.getByRole("button", { name: "关闭重命名" }).click();
    await page.getByRole("button", { name: "折叠节点栏" }).click();
    await page.getByRole("button", { name: "折叠历史会话" }).click();
    await expect.poll(async () => (await page.locator(".nodes-pane").boundingBox())?.width ?? Infinity).toBeLessThanOrEqual(72);
    await expect.poll(async () => (await page.locator(".conversations-pane").boundingBox())?.width ?? Infinity).toBeLessThanOrEqual(60);
    await expect(page.locator(".node-identity")).toContainText("移");
    await expect(page.getByRole("button", { name: "新建会话" })).toBeVisible();
    await page.screenshot({ path: "/tmp/controller-center-desktop-collapsed.png", fullPage: true });
  }
});

test("历史消息使用有界阅读模式并可返回最新消息", async ({ page }) => {
  await mockControlCenter(page, { idleConversation: true, paginatedHistory: true });
  await page.goto("/");

  const timeline = page.locator(".timeline");
  await expect(page.locator(".markdown-content").last()).toBeVisible();
  await timeline.evaluate((element) => { element.scrollTop = 0; });
  const loadEarlier = page.getByRole("button", { name: "加载更早消息" });
  await expect(loadEarlier).toBeVisible();
  await loadEarlier.click();

  const returnLatest = page.getByRole("button", { name: "历史阅读模式 · 返回最新消息" });
  await expect(returnLatest).toBeVisible();
  await expect(returnLatest).toHaveAttribute("title", /最多保留 500 条/);
  await returnLatest.click();

  await expect(returnLatest).toBeHidden();
  await expect.poll(() => timeline.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2);
});

test("后台运行会话的延迟刷新不会抢回当前会话", async ({ page }, testInfo) => {
  const backgroundConversation = {
    ...conversation,
    id: "background-conversation",
    title: "后台正在运行的会话",
  };
  const selectedConversation = {
    ...conversation,
    id: "selected-conversation",
    title: "我正在查看的会话",
    latestRunStatus: "completed",
  };

  await page.addInitScript(({ nodeId, conversationId }) => {
    if (!sessionStorage.getItem("controller-center:selected-node")) {
      sessionStorage.setItem("controller-center:selected-node", nodeId);
      sessionStorage.setItem("controller-center:selected-conversation", conversationId);
    }
  }, { nodeId: node.id, conversationId: backgroundConversation.id });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/session") {
      await route.fulfill({ json: { authenticated: true, expiresAt: "2026-10-10T00:00:00.000Z" } });
    } else if (url.pathname === "/api/stream") {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: "id: 1\nevent: update\ndata: {\"revision\":1}\n\nid: 2\nevent: update\ndata: {\"revision\":2}\n\n",
      });
    } else if (url.pathname === "/api/nodes") {
      await route.fulfill({ json: { data: [node] } });
    } else if (url.pathname === "/api/conversations" && url.searchParams.has("nodeId")) {
      await route.fulfill({ json: { data: [backgroundConversation, selectedConversation] } });
    } else if (url.pathname === `/api/conversations/${backgroundConversation.id}`) {
      await new Promise((resolve) => setTimeout(resolve, 450));
      await route.fulfill({
        json: { conversation: backgroundConversation, runs: [run], messages: [], attachments: [], approvals: [] },
      });
    } else if (url.pathname === `/api/conversations/${selectedConversation.id}`) {
      await route.fulfill({
        json: {
          conversation: selectedConversation,
          runs: [],
          attachments: [],
          approvals: [],
          messages: [{
            id: "selected-message",
            conversationId: selectedConversation.id,
            runId: null,
            role: "assistant",
            content: "这是当前会话的内容",
            revision: 1,
            complete: true,
            attachmentIds: [],
            createdAt: now,
            updatedAt: now,
          }],
        },
      });
    } else if (url.pathname === "/api/approvals") {
      await route.fulfill({ json: { data: [] } });
    } else if (url.pathname === "/api/settings") {
      await route.fulfill({ json: { settings: { defaultModel: null, defaultEffort: null } } });
    } else if (url.pathname === "/api/task-center") {
      await route.fulfill({ json: { data: [], unreadCount: 0 } });
    } else {
      await route.fulfill({ status: 204 });
    }
  });

  await page.goto("/");
  if (testInfo.project.name !== "desktop") {
    await page.getByRole("button", { name: "打开历史会话" }).click();
  }
  await page.locator(".conversation-card").filter({ hasText: selectedConversation.title }).click();
  await expect(page.locator(".chat-title strong")).toHaveText(selectedConversation.title);
  await expect(page.getByText("这是当前会话的内容")).toBeVisible();

  for (let index = 0; index < 3; index += 1) {
    if (testInfo.project.name !== "desktop") await page.getByRole("button", { name: "打开历史会话" }).click();
    await page.locator(".conversation-card").filter({ hasText: backgroundConversation.title }).click();
    await expect(page.locator(".chat-title strong")).toHaveText(backgroundConversation.title);
    if (testInfo.project.name !== "desktop") await page.getByRole("button", { name: "打开历史会话" }).click();
    await page.locator(".conversation-card").filter({ hasText: selectedConversation.title }).click();
    await expect(page.locator(".chat-title strong")).toHaveText(selectedConversation.title);
  }

  await page.waitForTimeout(800);
  await expect(page.locator(".chat-title strong")).toHaveText(selectedConversation.title);
  await expect(page.locator(".conversation-card").filter({ hasText: backgroundConversation.title })).not.toHaveClass(/selected/);
});

test("在不同节点之间切换时恢复各自最后打开的会话", async ({ page }, testInfo) => {
  const secondNode = {
    ...node,
    id: "build-node",
    name: "构建节点",
    reportedName: "build-node",
    workspaces: node.workspaces.map((workspace) => ({
      ...workspace,
      id: "build-workspace",
      nodeId: "build-node",
      name: "构建工作区",
      path: "/workspace/build",
    })),
  };
  const firstConversation = {
    ...conversation,
    id: "node-a-conversation",
    title: "节点 A 上次打开的会话",
    latestRunStatus: "completed",
  };
  const secondConversation = {
    ...conversation,
    id: "node-b-conversation",
    nodeId: secondNode.id,
    workspaceId: secondNode.workspaces[0]!.id,
    title: "节点 B 上次打开的会话",
    latestRunStatus: "completed",
  };
  const detailFor = (selected: typeof firstConversation) => ({
    conversation: selected,
    runs: [],
    approvals: [],
    attachments: [],
    messagePage: { hasMore: false, before: null },
    messages: [{
      id: `${selected.id}-message`,
      conversationId: selected.id,
      runId: null,
      role: "assistant",
      content: `${selected.title}的内容`,
      revision: 1,
      complete: true,
      attachmentIds: [],
      createdAt: now,
      updatedAt: now,
    }],
  });

  await page.addInitScript(({ nodeId, conversationId }) => {
    if (!sessionStorage.getItem("controller-center:selected-node")) {
      sessionStorage.setItem("controller-center:selected-node", nodeId);
      sessionStorage.setItem("controller-center:selected-conversation", conversationId);
    }
  }, { nodeId: node.id, conversationId: firstConversation.id });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/session") {
      await route.fulfill({ json: { authenticated: true, expiresAt: "2026-10-10T00:00:00.000Z" } });
    } else if (url.pathname === "/api/stream") {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: ready\ndata: {}\n\n" });
    } else if (url.pathname === "/api/nodes") {
      await route.fulfill({ json: { data: [node, secondNode] } });
    } else if (url.pathname === "/api/conversations") {
      const nodeId = url.searchParams.get("nodeId");
      const data = nodeId === node.id ? [firstConversation] : nodeId === secondNode.id ? [secondConversation] : [];
      await route.fulfill({ json: { data, total: data.length, nextCursor: null } });
    } else if (url.pathname === `/api/conversations/${firstConversation.id}`) {
      await route.fulfill({ json: detailFor(firstConversation) });
    } else if (url.pathname === `/api/conversations/${secondConversation.id}`) {
      await route.fulfill({ json: detailFor(secondConversation) });
    } else if (url.pathname === "/api/approvals") {
      await route.fulfill({ json: { data: [] } });
    } else if (url.pathname === "/api/settings") {
      await route.fulfill({ json: { settings: { defaultModel: null, defaultEffort: null } } });
    } else if (url.pathname === "/api/task-center") {
      await route.fulfill({ json: { data: [], unreadCount: 0 } });
    } else {
      await route.fulfill({ status: 204 });
    }
  });

  async function switchNode(name: string): Promise<void> {
    const trigger = testInfo.project.name === "desktop"
      ? page.locator(".node-footer").getByRole("button", { name: /快速切换/ })
      : page.locator(".mobile-toolbar").getByRole("button", { name: "快速切换" });
    await trigger.click();
    const switcher = page.getByRole("dialog", { name: "快速切换" });
    await switcher.getByRole("textbox", { name: "搜索节点或历史会话" }).fill(name);
    await switcher.locator("button").filter({ hasText: name }).click();
  }

  await page.goto("/");
  await expect(page.locator(".chat-title strong")).toHaveText(firstConversation.title);

  await switchNode(secondNode.name);
  await expect(page.getByRole("heading", { name: "开始一个新会话" })).toBeVisible();
  const secondConversationCard = page.locator(".conversation-card").filter({ hasText: secondConversation.title });
  await expect(secondConversationCard).toBeVisible();
  await secondConversationCard.click();
  await expect(page.locator(".chat-title strong")).toHaveText(secondConversation.title);

  await switchNode(node.name);
  await expect(page.locator(".chat-title strong")).toHaveText(firstConversation.title);
  await switchNode(secondNode.name);
  await expect(page.locator(".chat-title strong")).toHaveText(secondConversation.title);

  expect(await page.evaluate((nodeId) => sessionStorage.getItem(`controller-center:selected-conversation-by-node:${encodeURIComponent(nodeId)}`), node.id)).toBe(firstConversation.id);
  expect(await page.evaluate((nodeId) => sessionStorage.getItem(`controller-center:selected-conversation-by-node:${encodeURIComponent(nodeId)}`), secondNode.id)).toBe(secondConversation.id);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("controller-center:selected-node"))).toBe(secondNode.id);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("controller-center:selected-conversation"))).toBe(secondConversation.id);
  await page.reload();
  await expect(page.locator(".chat-title strong")).toHaveText(secondConversation.title);
});

test("本地缓存的会话已被删除时自动回到当前节点的新会话", async ({ page }) => {
  const missingConversationId = "deleted-conversation";
  await page.addInitScript(({ nodeId, conversationId }) => {
    sessionStorage.setItem("controller-center:selected-node", nodeId);
    sessionStorage.setItem("controller-center:selected-conversation", conversationId);
  }, { nodeId: node.id, conversationId: missingConversationId });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/session") {
      await route.fulfill({ json: { authenticated: true, expiresAt: "2026-10-10T00:00:00.000Z" } });
    } else if (url.pathname === "/api/stream") {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: ready\ndata: {}\n\n" });
    } else if (url.pathname === "/api/nodes") {
      await route.fulfill({ json: { data: [node] } });
    } else if (url.pathname === "/api/conversations" && url.searchParams.has("nodeId")) {
      await route.fulfill({ json: { data: [conversation], total: 1, nextCursor: null } });
    } else if (url.pathname === `/api/conversations/${missingConversationId}`) {
      await route.fulfill({ status: 404, json: { error: "Conversation not found" } });
    } else if (url.pathname === "/api/approvals") {
      await route.fulfill({ json: { data: [] } });
    } else if (url.pathname === "/api/settings") {
      await route.fulfill({ json: { settings: { defaultModel: null, defaultEffort: null } } });
    } else if (url.pathname === "/api/task-center") {
      await route.fulfill({ json: { data: [], unreadCount: 0 } });
    } else {
      await route.fulfill({ status: 204 });
    }
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "开始一个新会话" })).toBeVisible();
  await expect(page.locator(".connection-banner")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("controller-center:selected-conversation"))).toBeNull();
  await expect.poll(() => page.evaluate((nodeId) => sessionStorage.getItem(`controller-center:selected-conversation-by-node:${encodeURIComponent(nodeId)}`), node.id)).toBeNull();
  await expect(page.locator(".node-card").filter({ hasText: node.name })).toHaveClass(/selected/);
});

test("后台刷新显示真实错误上下文，支持关闭并在重试成功后清除", async ({ page }) => {
  let conversationRequests = 0;
  await page.addInitScript((nodeId) => {
    sessionStorage.setItem("controller-center:selected-node", nodeId);
    sessionStorage.removeItem("controller-center:selected-conversation");
  }, node.id);

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/session") {
      await route.fulfill({ json: { authenticated: true, expiresAt: "2026-10-10T00:00:00.000Z" } });
    } else if (url.pathname === "/api/stream") {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: ready\ndata: {}\n\n" });
    } else if (url.pathname === "/api/nodes") {
      await route.fulfill({ json: { data: [node] } });
    } else if (url.pathname === "/api/conversations" && url.searchParams.has("nodeId")) {
      conversationRequests += 1;
      if (conversationRequests === 1 || conversationRequests === 3) {
        await route.fulfill({
          status: 503,
          headers: { "X-Request-Id": "conversation-refresh-503" },
          json: { error: "会话数据库暂时不可用" },
        });
      } else {
        await route.fulfill({ json: { data: [conversation], total: 1, nextCursor: null } });
      }
    } else if (url.pathname === "/api/approvals") {
      await route.fulfill({ json: { data: [] } });
    } else if (url.pathname === "/api/settings") {
      await route.fulfill({ json: { settings: { defaultModel: null, defaultEffort: null } } });
    } else if (url.pathname === "/api/task-center") {
      await route.fulfill({ json: { data: [], unreadCount: 0 } });
    } else {
      await route.fulfill({ status: 204 });
    }
  });

  await page.goto("/");
  const banner = page.locator(".connection-banner");
  await expect(banner).toContainText("刷新会话列表失败：会话数据库暂时不可用");
  await expect(banner).toContainText("HTTP 503");
  await expect(banner).toContainText("请求 ID conversation-refresh-503");
  await expect(banner).not.toContainText("无法连接控制中心：");

  await banner.getByRole("button", { name: "关闭错误提示" }).click();
  await expect(banner).toHaveCount(0);

  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => conversationRequests).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(banner).toContainText("刷新会话列表失败：会话数据库暂时不可用");
  await banner.getByRole("button", { name: "立即重试" }).click();
  await expect(banner).toHaveCount(0);
  await expect.poll(() => conversationRequests).toBeGreaterThanOrEqual(4);
});

test("同工作区已有任务时确认后才并发启动", async ({ page }, testInfo) => {
  const createdConversation = {
    ...conversation,
    id: "workspace-concurrent-conversation",
    title: "同工作区并发任务",
  };
  const createdRun = { ...run, id: "workspace-concurrent-run", conversationId: createdConversation.id };
  const submissions: Array<Record<string, unknown>> = [];
  let conversationCreated = false;

  await page.addInitScript((nodeId) => {
    sessionStorage.setItem("controller-center:selected-node", nodeId);
    sessionStorage.removeItem("controller-center:selected-conversation");
  }, node.id);

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/session") {
      await route.fulfill({ json: { authenticated: true, expiresAt: "2026-10-10T00:00:00.000Z" } });
    } else if (url.pathname === "/api/stream") {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: ready\ndata: {}\n\n" });
    } else if (url.pathname === "/api/nodes") {
      await route.fulfill({ json: { data: [node] } });
    } else if (url.pathname === "/api/conversations" && url.searchParams.has("nodeId")) {
      await route.fulfill({ json: { data: conversationCreated ? [createdConversation] : [] } });
    } else if (url.pathname === "/api/conversations/start") {
      const submission = route.request().postDataJSON() as Record<string, unknown>;
      submissions.push(submission);
      if (submission.allowWorkspaceConcurrency !== true) {
        await route.fulfill({ status: 409, json: { code: "workspace_busy", error: "工作空间已有正在运行或排队的任务" } });
      } else {
        conversationCreated = true;
        await route.fulfill({ json: { conversation: createdConversation, run: createdRun, deduplicated: false } });
      }
    } else if (url.pathname === `/api/conversations/${createdConversation.id}`) {
      await route.fulfill({ json: {
        conversation: createdConversation,
        runs: [createdRun],
        messages: [],
        attachments: [],
        approvals: [],
        messagePage: { hasMore: false, before: null },
      } });
    } else if (url.pathname === "/api/approvals") {
      await route.fulfill({ json: { data: [] } });
    } else if (url.pathname === "/api/settings") {
      await route.fulfill({ json: { settings: { defaultModel: null, defaultEffort: null } } });
    } else if (url.pathname === "/api/task-center") {
      await route.fulfill({ json: { data: [], unreadCount: 0 } });
    } else {
      await route.fulfill({ status: 204 });
    }
  });

  await page.goto("/");
  if (testInfo.project.name !== "desktop") {
    const historyPane = page.locator(".conversations-pane");
    await expect(historyPane).toBeVisible();
    await historyPane.getByRole("button", { name: "新建会话" }).click();
  }
  const composer = page.locator(".composer textarea");
  await composer.fill("允许同工作区并发执行这个任务");
  await page.getByRole("button", { name: "发送" }).click();

  const dialog = page.getByRole("dialog", { name: "当前工作区已有任务" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Controller Center");
  await expect(dialog).toContainText("/workspace/controller-center");
  await expect(dialog).toContainText("文件覆盖、补丁冲突或测试结果互相影响");
  await expect(composer).toHaveValue("允许同工作区并发执行这个任务");
  expect(submissions).toHaveLength(1);
  expect(submissions[0]?.allowWorkspaceConcurrency).toBeUndefined();

  await dialog.getByRole("button", { name: "仍然继续" }).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1]?.allowWorkspaceConcurrency).toBe(true);
  expect(submissions[1]?.clientRequestId).toBe(submissions[0]?.clientRequestId);
  await expect(dialog).toBeHidden();
});

test("新会话创建结果不会抢占用户后来选择的会话", async ({ page }, testInfo) => {
  const existingConversation = {
    ...conversation,
    id: "existing-conversation",
    title: "用户后来选择的会话",
    latestRunStatus: "completed",
  };
  const createdConversation = {
    ...conversation,
    id: "delayed-created-conversation",
    title: "延迟创建的会话",
  };
  const createdRun = { ...run, id: "delayed-created-run", conversationId: createdConversation.id };
  let conversationCreated = false;

  await page.addInitScript((nodeId) => {
    sessionStorage.setItem("controller-center:selected-node", nodeId);
    sessionStorage.removeItem("controller-center:selected-conversation");
  }, node.id);

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/session") {
      await route.fulfill({ json: { authenticated: true, expiresAt: "2026-10-10T00:00:00.000Z" } });
    } else if (url.pathname === "/api/stream") {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: ready\ndata: {}\n\n" });
    } else if (url.pathname === "/api/nodes") {
      await route.fulfill({ json: { data: [node] } });
    } else if (url.pathname === "/api/conversations" && url.searchParams.has("nodeId")) {
      await route.fulfill({ json: { data: conversationCreated ? [createdConversation, existingConversation] : [existingConversation] } });
    } else if (url.pathname === "/api/conversations/start") {
      await new Promise((resolve) => setTimeout(resolve, 450));
      conversationCreated = true;
      await route.fulfill({ json: { conversation: createdConversation, run: createdRun, deduplicated: false } });
    } else if (url.pathname === `/api/conversations/${existingConversation.id}`) {
      await route.fulfill({ json: { conversation: existingConversation, runs: [], messages: [], attachments: [], approvals: [] } });
    } else if (url.pathname === "/api/approvals") {
      await route.fulfill({ json: { data: [] } });
    } else if (url.pathname === "/api/settings") {
      await route.fulfill({ json: { settings: { defaultModel: null, defaultEffort: null } } });
    } else if (url.pathname === "/api/task-center") {
      await route.fulfill({ json: { data: [], unreadCount: 0 } });
    } else {
      await route.fulfill({ status: 204 });
    }
  });

  await page.goto("/");
  if (testInfo.project.name !== "desktop") {
    const historyPane = page.locator(".conversations-pane");
    await expect(historyPane).toBeVisible();
    await expect(page.locator(".chat-pane")).toBeVisible();
    await expect(page.getByRole("button", { name: "关闭历史会话" })).toBeVisible();
    await page.screenshot({ path: `/tmp/controller-center-history-${testInfo.project.name}.png`, fullPage: true });
    await historyPane.getByRole("button", { name: "新建会话" }).click();
    await expect(page.getByRole("heading", { name: "开始一个新会话" })).toBeVisible();
    const draftAlignment = await page.locator(".draft-welcome").evaluate((element) => {
      const graphic = element.querySelector(".empty-visual")!.getBoundingClientRect();
      const timeline = element.closest(".timeline")!.getBoundingClientRect();
      return Math.abs(graphic.left + graphic.width / 2 - (timeline.left + timeline.width / 2));
    });
    expect(draftAlignment).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `/tmp/controller-center-draft-${testInfo.project.name}.png`, fullPage: true });
  }
  await expect(page.getByRole("combobox", { name: "选择工作空间" })).toHaveValue("qa-workspace");
  await page.locator(".composer textarea").fill("创建一个后台会话");
  await page.getByRole("button", { name: "发送" }).click();

  if (testInfo.project.name !== "desktop") await page.getByRole("button", { name: "打开历史会话" }).click();
  await page.locator(".conversation-card").filter({ hasText: existingConversation.title }).click();
  await expect(page.locator(".chat-title strong")).toHaveText(existingConversation.title);

  await page.waitForTimeout(800);
  await expect(page.locator(".chat-title strong")).toHaveText(existingConversation.title);
  await expect(page.locator(".conversation-card").filter({ hasText: createdConversation.title })).not.toHaveClass(/selected/);
});

test("未认证访问会进入 Token 登录且登录后不在浏览器保存原始 Token", async ({ page }) => {
  let authenticated = false;
  let submittedToken = "";
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/session") {
      await route.fulfill({ json: { authenticated } });
    } else if (url.pathname === "/api/auth/login") {
      submittedToken = (route.request().postDataJSON() as { token: string }).token;
      authenticated = submittedToken === "cca_test-admin-token";
      await route.fulfill({ status: authenticated ? 200 : 401, json: authenticated ? { authenticated: true } : { error: "管理员 Token 无效" } });
    } else if (url.pathname === "/api/stream") {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: ready\ndata: {}\n\n" });
    } else if (url.pathname === "/api/nodes" || url.pathname === "/api/approvals") {
      await route.fulfill({ json: { data: [] } });
    } else if (url.pathname === "/api/settings") {
      await route.fulfill({ json: { settings: { defaultModel: null, defaultEffort: null } } });
    } else if (url.pathname === "/api/task-center") {
      await route.fulfill({ json: { data: [], unreadCount: 0 } });
    } else {
      await route.fulfill({ status: 204 });
    }
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录控制中心" })).toBeVisible();
  await page.getByLabel("管理员 Token").fill("cca_test-admin-token");
  await page.getByRole("button", { name: "进入控制中心" }).click();
  await expect(page.locator(".nodes-pane")).toBeVisible();
  expect(submittedToken).toBe("cca_test-admin-token");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("cca_test-admin-token");
});

test("设置页在列表展示注册 Token、状态和到期倒计时", async ({ page }) => {
  const registrationToken = "cce_00000000-0000-4000-8000-000000000001.test-registration-secret-value";
  let created = false;
  let registrationStatus: "pending" | "used" = "pending";
  const expiresAt = new Date(Date.now() + 15_000).toISOString();
  const enrollment = () => ({
    id: "00000000-0000-4000-8000-000000000001",
    token: registrationToken,
    status: registrationStatus,
    createdAt: now,
    expiresAt,
    usedAt: registrationStatus === "used" ? now : null,
    nodeId: registrationStatus === "used" ? node.id : null,
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/session") {
      await route.fulfill({ json: { authenticated: true } });
    } else if (url.pathname === "/api/stream") {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: ready\ndata: {}\n\n" });
    } else if (url.pathname === "/api/nodes") {
      await route.fulfill({ json: { data: [node] } });
    } else if (url.pathname === "/api/conversations") {
      await route.fulfill({ json: { data: [conversation] } });
    } else if (url.pathname === `/api/conversations/${conversation.id}`) {
      await route.fulfill({ json: { conversation, runs: [], messages: [], attachments: [], approvals: [] } });
    } else if (url.pathname === "/api/approvals") {
      await route.fulfill({ json: { data: [] } });
    } else if (url.pathname === "/api/settings") {
      await route.fulfill({ json: { settings: { defaultModel: null, defaultEffort: null } } });
    } else if (url.pathname === "/api/task-center") {
      await route.fulfill({ json: { data: [], unreadCount: 0 } });
    } else if (url.pathname === "/api/agent-package/download") {
      await route.fulfill({
        contentType: "application/gzip",
        headers: { "Content-Disposition": "attachment; filename=\"controller-center-agent-v0.3.13.tar.gz\"" },
        body: "portable-agent-package",
      });
    } else if (url.pathname === "/api/agent-package") {
      await route.fulfill({ json: { package: {
        available: true,
        version: "0.3.13",
        fileName: "controller-center-agent-v0.3.13.tar.gz",
        size: 580_000,
        sha256: "cb9bd8bd4ff984ee13b78a4f9b1ff9a72b950ed2a468d69e20fc0abe1bda2aa6",
        builtAt: now,
      } } });
    } else if (url.pathname === "/api/enrollment-tokens" && route.request().method() === "POST") {
      created = true;
      await route.fulfill({ status: 201, json: { enrollment: enrollment(), token: registrationToken } });
    } else if (url.pathname === "/api/enrollment-tokens") {
      await route.fulfill({ json: { data: created ? [enrollment()] : [], lifetimeSeconds: 600 } });
    } else {
      await route.fulfill({ status: 204 });
    }
  });

  await page.goto("/");
  await page.locator('button[aria-label="设置"]:visible, button[title="设置"]:visible').first().click();
  await page.getByRole("button", { name: "节点接入" }).click();
  await expect(page.getByText("v0.3.13 · 566 KB · Linux / macOS")).toBeVisible();
  const downloadStarted = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载客户端" }).click();
  await expect((await downloadStarted).suggestedFilename()).toBe("controller-center-agent-v0.3.13.tar.gz");
  await page.getByRole("button", { name: "生成注册 Token" }).click();
  await expect(page.getByRole("dialog", { name: "一次性注册 Token" })).toHaveCount(0);
  await expect(page.getByText(registrationToken)).toBeVisible();
  await expect(page.getByText("未注册", { exact: true })).toBeVisible();
  await expect(page.getByText(/剩余 0:(0[1-9]|1[0-5])/)).toBeVisible();
  await expect(page.getByRole("button", { name: "复制" })).toBeVisible();

  registrationStatus = "used";
  await expect(page.getByText("已注册", { exact: true })).toBeVisible({ timeout: 12_000 });
  await expect(page.getByText(registrationToken)).toHaveCount(0, { timeout: 8_000 });
  await expect(page.getByText("当前没有有效的注册 Token")).toBeVisible();
});
