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

async function mockControlCenter(page: Page) {
  const presenceReports: Array<{ conversationId?: string | null; visible?: boolean }> = [];
  const quickSearchRequests: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem("controller-center:selected-node", "qa-node");
    localStorage.setItem("controller-center:selected-conversation", "qa-conversation");
  });
  await page.route("**/api/**", async (route) => {
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
      await route.fulfill({ json: { data: [conversation] } });
    } else if (url.pathname === `/api/conversations/${conversation.id}`) {
      await route.fulfill({
        json: {
          conversation,
          runs: [run],
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
  return { presenceReports, quickSearchRequests };
}

test("长对话可以滚动并正确渲染代码、公式和移动布局", async ({ page, context }, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:5173" });
  const { presenceReports, quickSearchRequests } = await mockControlCenter(page);
  await page.goto("/");

  const timeline = page.locator(".timeline");
  await expect(page.locator(".node-permission-badge")).toHaveText("全权限");
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
  await timeline.evaluate((element) => { element.scrollTop = 120; });
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "滑动到底部" })).toBeVisible();
  await page.getByRole("button", { name: "滑动到底部" }).click();
  await expect.poll(() => timeline.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2);
  await expect(page.getByRole("button", { name: "滑动到底部" })).toBeHidden();
  await expect(page.getByText("查看原始数据")).toHaveCount(0);

  const codePre = page.locator(".code-block pre").first();
  const codeDimensions = await codePre.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(codeDimensions.scrollWidth).toBeGreaterThan(codeDimensions.clientWidth);
  await page.locator(".code-block-toolbar button").first().click();
  await expect(page.locator(".code-block-toolbar button").first()).toHaveText("已复制");

  const pageWidth = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  expect(pageWidth.document).toBeLessThanOrEqual(pageWidth.viewport);

  const composerInput = page.locator(".composer textarea");
  const initialInputHeight = await composerInput.evaluate((element) => element.getBoundingClientRect().height);
  await composerInput.fill("追加说明\n".repeat(8));
  await expect.poll(() => composerInput.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(initialInputHeight);
  const composerBottom = await page.locator(".composer").evaluate((element) => element.getBoundingClientRect().bottom);
  expect(composerBottom).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
  if (testInfo.project.name !== "desktop") {
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

  await timeline.evaluate((element) => { element.scrollTop = 120; });
  await expect(page.getByRole("button", { name: "滑动到底部" })).toBeVisible();

  await page.screenshot({ path: `/tmp/controller-center-${testInfo.project.name}.png`, fullPage: true });

  const globalNavigation = testInfo.project.name === "desktop" ? page.locator(".node-footer") : page.locator(".mobile-topbar");
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
  await expect(page.locator(".settings-version")).toContainText("v0.3.4");
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
  await globalNavigation.getByRole("button", { name: /任务中心|全局任务中心/ }).click();
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
  await globalNavigation.getByRole("button", { name: /任务中心|全局任务中心/ }).click();
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
    localStorage.setItem("controller-center:selected-node", nodeId);
    localStorage.setItem("controller-center:selected-conversation", conversationId);
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

test("本地缓存的会话已被删除时自动回到当前节点的新会话", async ({ page }) => {
  const missingConversationId = "deleted-conversation";
  await page.addInitScript(({ nodeId, conversationId }) => {
    localStorage.setItem("controller-center:selected-node", nodeId);
    localStorage.setItem("controller-center:selected-conversation", conversationId);
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
  await expect.poll(() => page.evaluate(() => localStorage.getItem("controller-center:selected-conversation"))).toBeNull();
  await expect(page.locator(".node-card").filter({ hasText: node.name })).toHaveClass(/selected/);
});

test("后台刷新显示真实错误上下文并在重试成功后清除", async ({ page }) => {
  let conversationRequests = 0;
  await page.addInitScript((nodeId) => {
    localStorage.setItem("controller-center:selected-node", nodeId);
    localStorage.removeItem("controller-center:selected-conversation");
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
      if (conversationRequests === 1) {
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

  await banner.getByRole("button", { name: "立即重试" }).click();
  await expect(banner).toHaveCount(0);
  await expect.poll(() => conversationRequests).toBeGreaterThanOrEqual(2);
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
    localStorage.setItem("controller-center:selected-node", nodeId);
    localStorage.removeItem("controller-center:selected-conversation");
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
    await page.locator(".node-card").filter({ hasText: node.name }).click();
    await expect(page.locator(".chat-pane")).toBeVisible();
    await expect(page.getByRole("heading", { name: "开始一个新会话" })).toBeVisible();
    await expect(page.locator(".conversations-pane")).toBeHidden();
    await page.getByRole("button", { name: "打开历史会话" }).click();
    await expect(page.locator(".conversations-pane")).toBeVisible();
    await expect(page.locator(".chat-pane")).toBeVisible();
    await expect(page.getByRole("button", { name: "关闭历史会话" })).toBeVisible();
    await page.screenshot({ path: `/tmp/controller-center-history-${testInfo.project.name}.png`, fullPage: true });
    await page.getByRole("button", { name: "新建会话" }).click();
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
