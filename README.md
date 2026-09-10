# Controller Center

一个用于集中管理多台本地 Codex 节点的控制中心。节点上的 Agent 主动连接控制中心，并通过 `stdio` 驱动本地 `codex app-server`；Codex 登录凭据和工作区文件都不会交给控制中心。

产品与可靠性方案见 [产品设计](docs/product-design.md) 和 [可靠性设计](docs/reliability-design.md)。两份方案已经确认，代码按该边界实施。

## 组成

代码位于同一 npm workspace，但三个应用可以分别构建和部署：

- `apps/control-plane`：节点注册、调度、状态持久化、审批和 SSE API。
- `apps/agent`：部署在受控节点，管理本地 Codex App Server。
- `apps/web`：独立 React Web 控制台，支持桌面和移动端浏览器。
- `packages/protocol`：控制中心与 Agent 共享的版本化协议，不包含业务运行代码。

```text
Mobile/Desktop Web -- REST + SSE --> Control Plane <-- outbound WSS -- Node Agent -- stdio --> Codex App Server
```

控制中心与 Agent 使用自有 `control-protocol/v3`。Codex JSON-RPC 的版本差异只在 Agent 内处理。

## 已实现能力

- Agent 注册、心跳、断线检测和自动重连。
- Agent 预配置项目目录（内部协议名 Workspace），服务端不能下发任意本地路径。
- 节点默认使用主机名，也可以在 Web 中设置持久化显示名称。
- 节点、工作区、Conversation/Thread 和 Run/Turn 管理；历史会话支持搜索、重命名、置顶、筛选和删除。
- 多节点、多对话；不同工作区在节点并发额度内并行，同一工作区的多个任务接受后按顺序排队。
- 新会话在首次发送时原子创建，使用持久化幂等号避免双击、刷新和重试产生重复会话。
- Agent 通过 `model/list` 发布本机可用模型及思考强度，Web 可按会话选择。
- 只持久化用户消息、Codex 回复和简洁进度；命令输出、Diff、推理增量和原始事件不会发送到中心。
- 命令执行与文件修改的最小必要确认信息，以及 `request_user_input` 表单。
- 任务追加指令、中止当前轮次和失败状态；中止后可在同一历史会话继续发起新轮次。
- 主内容区任务中心只保留全局节点菜单，隐藏依赖当前节点的历史会话栏；仅在用户未查看对应会话时生成未读完成、失败或等待操作通知，并展示会话名与对应任务最新回复摘要。
- 任务中心支持会话名称/节点名称搜索、节点与状态筛选、全部标为已读，以及失败任务幂等重新执行。
- 全局快速切换支持按节点名称或会话名称搜索所有节点和跨节点历史会话；桌面端可使用 `Ctrl/Cmd + K`，移动端使用顶部搜索入口。
- 会话列表使用服务端名称搜索与游标分页，每页 50 条；不会下载或检索消息正文、代码和附件内容。
- 任务中心最多展示 200 条，摘要最多 120 个字符；已读通知保留 30 天、未读通知保留 90 天，通知清理不影响会话历史。
- 全局默认模型和思考强度设置，节点不支持偏好模型时回退本机默认；设置页展示构建版本号。
- 文件上传、拖拽和粘贴图片；分片续传、SHA-256 校验和 Agent 本地缓存。
- Agent 本地 SQLite inbox/outbox、命令去重、消息补发和重连状态协调。
- 浏览器 SSE 使用持久游标重放，刷新或断线后重新拉取权威状态并继续流式显示。
- 回复流式刷新时同步渲染 Markdown 和 KaTeX，兼容 `$...$`、`$$...$$`、`\(...\)` 与 `\[...\]`。
- 长对话使用动态高度虚拟列表，仅渲染视口附近消息，并保持刷新恢复、流式跟随和回到底部行为一致。
- 控制中心 SQLite WAL 持久化与审计数据。
- 手机端分层导航、底部输入区、安全区适配和全宽审批卡片。

## 环境要求

- Node.js 24 或更新版本。
- Agent 节点已安装并登录 `codex` CLI。
- 控制中心到 Agent 不需要入站网络；Agent 只需能访问中心的 WSS 地址。

当前已使用 `codex-cli 0.154.0` 完成联调验证。Agent 同时兼容旧版 `on-request` / `workspace-write` 枚举和新版官方文档中的命名。

## 本地启动

安装和构建：

```bash
npm install
npm run build
```

终端一，启动控制中心：

```bash
AGENT_SHARED_TOKEN=local-agent-token npm run dev:server
```

终端二，启动节点 Agent：

```bash
CONTROL_CENTER_URL=ws://127.0.0.1:8787/agent/connect \
AGENT_TOKEN=local-agent-token \
AGENT_NAME=local-dev \
AGENT_WORKSPACES='[{"id":"controller-center","name":"Controller Center","path":"/absolute/path/to/ControlerCenter"}]' \
npm run dev:agent
```

终端三，启动 Web：

```bash
npm run dev:web
```

打开 `http://127.0.0.1:5173`。开发服务器会把同源 `/api`、`/agent/connect` 和附件下载代理到本机控制中心，因此从其他电脑、手机或 Agent 访问时可以只暴露 `5173`。

## 独立部署

### 控制中心和 Web

复制环境变量模板并启动两个独立容器：

```bash
cp deploy/control.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
```

`control-plane` 和 `web` 是两个容器，可部署到不同主机。分开部署时，设置：

- `PUBLIC_CONTROL_API_URL`：默认留空并使用 Web 容器的同源反向代理；只有 API 单独使用其他域名时才填写。
- `WEB_ORIGIN`：Web 的完整 Origin，用于 CORS。
- `AGENT_SHARED_TOKEN`：Agent 注册使用的高强度随机令牌。

默认部署只映射 Web 端口，Nginx 同时转发 API、SSE、Agent WebSocket 和附件下载，因此访问者不需要单独映射控制中心端口。生产环境必须启用 TLS。若需要用户登录，推荐在 Web/API 前使用统一认证反向代理；内置 `ADMIN_TOKEN` 只适合单管理员内网部署，设置到 Web 构建参数后会存在于浏览器环境中。

### Agent

Agent 需要直接访问本机 Codex、Git 和工作区，因此推荐作为宿主机服务运行，而不是放入容器。构建仓库后，将代码与生产依赖复制到 `/opt/controller-center`，参考：

- `deploy/systemd/controller-center-agent.service`
- `deploy/agent.env.example`

Agent 的运行用户必须对配置的工作区具有适当权限，并且该用户需要完成本地 Codex 登录。

## 常用配置

控制中心：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CONTROL_PORT` | `8787` | API 与 Agent WSS 端口 |
| `CONTROL_DATA_DIR` | `./data` | SQLite 数据目录 |
| `AGENT_SHARED_TOKEN` | `dev-agent-token` | Agent 共享注册令牌，生产必须修改 |
| `ADMIN_TOKEN` | 空 | 可选的单管理员 API Bearer Token |
| `CORS_ORIGIN` | `http://localhost:5173` | 允许的 Web Origin，逗号分隔 |

Agent：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CONTROL_CENTER_URL` | `ws://127.0.0.1:8787/agent/connect` | 中心 Agent 通道 |
| `AGENT_TOKEN` | `dev-agent-token` | 与中心一致的令牌 |
| `AGENT_NAME` | 当前主机名 | 首次注册时报告的节点名称；可在 Web 中设置显示名称 |
| `AGENT_DATA_DIR` | `~/.controller-center-agent` | 本地身份与可靠队列 |
| `AGENT_WORKSPACES` | 当前目录 | 允许使用的工作区 JSON 数组 |
| `MAX_CONCURRENT_RUNS` | `2` | 节点最大活动任务数 |
| `AGENT_NETWORK_ACCESS` | `false` | Codex workspace sandbox 默认网络权限 |
| `CODEX_BIN` | `codex` | Codex CLI 路径 |

## API 概览

- `GET /api/nodes`
- `PATCH /api/nodes/:id`
- `GET/POST /api/conversations`
- `PATCH /api/conversations/:id`（重命名、置顶）
- `POST /api/conversations/start`（首次发送时幂等创建会话和首轮任务）
- `GET /api/conversations/:id`
- `DELETE /api/conversations/:id`
- `POST /api/conversations/:id/runs`
- `POST /api/runs/:id/steer`
- `POST /api/runs/:id/interrupt`
- `POST /api/runs/:id/retry`（失败或中止任务幂等重新执行）
- `GET /api/approvals?status=pending`
- `POST /api/approvals/:id/resolve`
- `GET/PATCH /api/settings`
- `GET /api/task-center`
- `POST /api/notifications/read-all`
- `POST /api/ui/presence`
- `POST/PUT /api/attachments...`（创建、分片上传、完成校验）
- `GET /api/stream?after=<revision>`（可重放 SSE）
- `GET /readyz`

## 安全边界

- 控制中心不能指定任意 `cwd`，只能使用 Agent 显式发布的工作区 ID。
- Agent 使用 `workspaceWrite` sandbox，默认关闭网络访问。
- 不提供绕过 Codex 的远程 Shell API。
- OpenAI/ChatGPT 凭据始终由节点本地的 Codex 管理。
- Git commit、push 和其他远端写操作仍须在任务中得到明确授权。
