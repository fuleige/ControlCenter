# Controller Center

一个用于集中管理多台本地 Codex 节点的控制中心。节点上的 Agent 主动连接控制中心，并通过 `stdio` 驱动本地 `codex app-server`；Codex 登录凭据和工作区文件都不会交给控制中心。

产品、可靠性和公网认证方案见 [产品设计](docs/product-design.md)、[可靠性设计](docs/reliability-design.md) 与 [公网认证及节点接入设计](docs/security-enrollment-design.md)。Agent 可用参数、环境变量、优先级和组合示例见 [Agent 客户端命令与配置](docs/agent-cli.md)。代码按这些边界实施。

## 组成

代码位于同一 npm workspace，但三个应用可以分别构建和部署：

- `apps/control-plane`：节点注册、调度、状态持久化、审批和 SSE API。
- `apps/agent`：部署在受控节点，管理本地 Codex App Server。
- `apps/web`：独立 React Web 控制台，支持桌面和移动端浏览器。
- `packages/protocol`：控制中心与 Agent 共享的版本化协议，不包含业务运行代码。

```text
Mobile/Desktop Web -- REST + SSE --> Control Plane <-- outbound WSS -- Node Agent -- stdio --> Codex App Server
```

控制中心与 Agent 使用自有 `control-protocol/v4`。Codex JSON-RPC 的版本差异只在 Agent 内处理。

## 已实现能力

- Web 使用随机管理员 Token 登录，服务端建立 HttpOnly 会话；管理员原始 Token 不进入前端构建、Local Storage 或 URL。
- Web 可生成 10 分钟有效的节点注册 Token；有效期内可在列表查看、复制和确认注册状态，到期自动删除；Agent 首次注册后使用与固定节点 ID 绑定的独立长期凭证。
- Agent 注册、心跳、断线检测和自动重连；迁移期间仍兼容旧共享 Token。
- Agent 可在启动时显式传入 `--yolo`，以关闭 Codex 审批和沙箱；节点会把当前权限模式上报给中心，Web 在节点名称旁持续显示“全权限”。
- Agent 统一读取 Linux/macOS CLI 常用的代理环境变量；可通过 `--codex-proxy-only` 让控制中心注册、控制通道和附件下载强制直连，同时只让 Codex 子进程继承系统代理。
- Agent 启动目录自动成为不可修改的默认工作空间；还可通过启动配置或 Web 设置为节点登记多个本地路径。
- Web 添加工作空间时由对应 Agent 验证目录存在、可读写并返回规范路径；每次创建会话或新任务前再次验证。
- 每个会话固定绑定一个工作空间；Agent 更换启动目录后，新目录成为默认，仍被会话使用的旧默认目录作为历史工作空间保留。
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
- 全局快速切换支持按节点名称或会话名称搜索所有节点和跨节点历史会话；空关键词不加载历史会话，有关键词时最多返回 10 条会话结果。桌面端可使用 `Ctrl/Cmd + K`，移动端使用顶部搜索入口。
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

首次启动会在 `data/secrets/admin-token` 随机生成管理员 Token。另开终端查询：

```bash
npm run admin -- admin-token show
```

终端二，启动节点 Agent：

```bash
CONTROL_CENTER_URL=ws://127.0.0.1:8787/agent/connect \
AGENT_TOKEN=local-agent-token \
AGENT_NAME=local-dev \
npm run dev:agent -- --yolo --codex-proxy-only
```

`--yolo` 是显式的全权限开关：它会关闭 Codex 的审批与沙箱隔离；不传时仍使用默认的 `workspaceWrite` 安全模式。`--codex-proxy-only` 是进程级网络策略；不传时 Agent 与 Codex 都遵循系统代理环境变量，传入后 Agent 自身强制直连而 Codex 仍继承代理。Agent 启动命令所在目录就是默认工作空间（通过 npm 启动时使用 npm 保留的原始调用目录，而不是 workspace 包目录）。`AGENT_WORKSPACES` 仅用于追加由部署配置维护的工作空间；若其中包含启动目录，该项会被识别为默认项。

终端三，启动 Web：

```bash
npm run dev:web
```

打开 `http://127.0.0.1:5173` 并使用上面的管理员 Token 登录。开发服务器会把同源 `/api`、`/agent/connect`、`/agent/enroll` 和附件下载代理到本机控制中心，因此从其他电脑、手机或 Agent 访问时可以只暴露 `5173`。

若临时通过域名反向代理 Vite 开发服务，可用逗号分隔的 `WEB_ALLOWED_HOSTS` 配置 Host 白名单；仓库默认允许 `c.llmdev.cn`。生产部署仍应使用构建后的 Nginx Web 容器，而不是长期运行 Vite。

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
- `AGENT_SHARED_TOKEN`：只用于尚未迁移的旧 Agent；新节点不共享长期令牌。

默认部署只映射 Web 端口，Nginx 同时转发 API、SSE、节点注册、Agent WebSocket 和附件下载，因此访问者不需要单独映射控制中心端口。公网部署必须在外层 Nginx 启用 TLS，并把 `WEB_ORIGIN` 设为实际的 `https://` Origin。

管理员 Token 在首次启动时随机生成到持久化数据卷，不会写入 Web 镜像。可在服务器本机查询、轮换或撤销全部登录会话：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml exec control-plane \
  node apps/control-plane/dist/admin-cli.js admin-token show
docker compose --env-file deploy/.env -f deploy/docker-compose.yml exec control-plane \
  node apps/control-plane/dist/admin-cli.js admin-token rotate
docker compose --env-file deploy/.env -f deploy/docker-compose.yml exec control-plane \
  node apps/control-plane/dist/admin-cli.js sessions revoke-all
```

成功登录后使用 HttpOnly、SameSite=Strict 的服务端会话；空闲有效期 7 天，最长有效期 30 天。轮换管理员 Token 会立即撤销全部现有会话。

### Agent

Agent 需要直接访问本机 Codex、Git 和工作区，因此推荐作为宿主机服务运行，而不是放入容器。构建仓库后，将代码与生产依赖复制到 `/opt/controller-center`，参考：

- `deploy/systemd/controller-center-agent.service`
- `deploy/agent.env.example`

Agent 的运行用户必须对配置的工作区具有适当权限，并且该用户需要完成本地 Codex 登录。`AGENT_DATA_DIR` 不设置时默认使用 `~/.controller-center-agent`，它保存稳定节点身份而不决定默认工作空间；默认工作空间仍由启动目录决定。
systemd 的 `WorkingDirectory` 决定该节点的默认工作空间；示例中为 `/opt/controller-center`。
仓库中的 systemd 示例已在 Agent 启动命令末尾添加 `--yolo --codex-proxy-only`；若节点需要审批和沙箱保护，删除 `--yolo`，若控制中心流量也应使用代理则删除 `--codex-proxy-only`。
客户端运行与注册支持的完整参数列表见 [Agent 客户端命令与配置](docs/agent-cli.md)。

独立客户端和发布压缩包提供快捷脚本，默认连接本项目的公开控制中心，并以全权限、控制链路直连模式启动：

```bash
./agent.sh login
./agent.sh start
./agent.sh status
```

可用 `./agent.sh start --safe` 恢复审批与沙箱，或用 `./agent.sh start --all-proxy` 让控制中心连接也按系统代理规则访问。

新节点首次接入：先在 Web 的“设置 → 节点接入”生成注册 Token，再在节点执行以下命令。命令只要求控制中心域名，Token 会通过不回显的交互输入读取；公网地址必须为 HTTPS。

```bash
AGENT_DATA_DIR=/var/lib/controller-center-agent \
npm run agent:enroll -- --server https://control.example.com --codex-proxy-only
```

注册命令是独立进程，因此若注册也需要绕过系统代理，必须同样传入 `--codex-proxy-only`。注册成功后，中心地址与该节点的独立凭证保存到 `AGENT_DATA_DIR/connection.json`（权限 `0600`），之后启动 Agent 不再需要配置域名或 Token。自动化环境可临时使用 `CONTROLLER_CENTER_ENROLLMENT_TOKEN` 环境变量，避免把 Token 写入命令行参数和 shell 历史。

## 常用配置

控制中心：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CONTROL_PORT` | `8787` | API 与 Agent WSS 端口 |
| `CONTROL_DATA_DIR` | `<启动命令所在目录>/data` | SQLite 数据与附件目录；建议生产环境显式配置绝对路径 |
| `AGENT_SHARED_TOKEN` | `dev-agent-token` | 旧 Agent 迁移用共享令牌；迁移期仍须设为高强度随机值 |
| `ADMIN_TOKEN` | 空 | 仅在管理员 Token 文件尚不存在时作为首次引导值；通常留空自动生成 |
| `ADMIN_TOKEN_FILE` | `<CONTROL_DATA_DIR>/secrets/admin-token` | 本机可查询的管理员原始 Token 文件，权限 `0600` |
| `ENROLLMENT_DISPLAY_KEY_FILE` | `<CONTROL_DATA_DIR>/secrets/enrollment-display-key` | 注册 Token 临时展示内容的本机加密密钥，权限 `0600` |
| `PUBLIC_ORIGIN` | 与 `CORS_ORIGIN` 相同 | 浏览器访问的公开 Origin；HTTPS 时启用 Secure 会话 Cookie |
| `TRUST_PROXY` | `false` | 控制面仅位于可信反向代理之后时设为 `true`，用于正确识别登录限流来源 IP |
| `CORS_ORIGIN` | `http://localhost:5173` | 允许的 Web Origin，逗号分隔 |

Agent：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CONTROL_CENTER_URL` | 注册记录或 `ws://127.0.0.1:8787/agent/connect` | 显式覆盖中心 Agent 通道；注册后通常无需设置 |
| `AGENT_TOKEN` | 注册凭证或 `dev-agent-token` | 仅未注册节点使用的旧共享 Token；本机已有独立注册凭证时自动忽略 |
| `AGENT_NAME` | 当前主机名 | 首次注册时报告的节点名称；可在 Web 中设置显示名称 |
| `AGENT_DATA_DIR` | `~/.controller-center-agent` | 本地身份与可靠队列 |
| `AGENT_WORKSPACES` | 空数组 | 可选的附加工作空间 JSON 数组；不能覆盖由进程当前目录决定的默认工作空间 |
| `MAX_CONCURRENT_RUNS` | `2` | 节点最大活动任务数 |
| `AGENT_NETWORK_ACCESS` | `false` | Codex workspace sandbox 默认网络权限 |
| `CODEX_BIN` | `codex` | Codex CLI 路径 |
| `HTTP_PROXY` / `HTTPS_PROXY` | 空 | 系统 HTTP(S) 代理；支持大写和小写变量 |
| `ALL_PROXY` | 空 | 未配置协议专用代理时的后备代理；当前支持 HTTP(S) 代理地址 |
| `NO_PROXY` | 空 | 默认模式下不使用代理的地址；支持大写和小写变量 |

Agent 日常运行支持 `--yolo` 和 `--codex-proxy-only`；首次注册支持 `--server`、`--token` 和 `--codex-proxy-only`。详细说明、安全注意事项及环境变量优先级见 [Agent 客户端命令与配置](docs/agent-cli.md)。

## API 概览

- `GET /api/nodes`
- `PATCH /api/nodes/:id`
- `POST /api/nodes/:id/access/revoke`（撤销节点独立凭证并断开连接）
- `GET/POST /api/nodes/:id/workspaces`
- `PATCH/DELETE /api/nodes/:nodeId/workspaces/:workspaceId`
- `POST /api/nodes/:nodeId/workspaces/:workspaceId/validate`
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
- `GET/POST /api/enrollment-tokens`（管理员创建与查看注册状态）
- `DELETE /api/enrollment-tokens/:id`（撤销尚未使用的注册 Token）
- `GET /api/task-center`
- `POST /api/notifications/read-all`
- `POST /api/ui/presence`
- `POST/PUT /api/attachments...`（创建、分片上传、完成校验）
- `GET /api/stream?after=<revision>`（可重放 SSE）
- `GET /readyz`

## 安全边界

- Web 管理员可以登记 Agent 运行用户有权访问的任意本地目录；这等同于授予后续 Codex 会话在该目录中工作的能力。
- 管理员 Token 原文仅保存在控制中心本机权限为 `0600` 的文件；数据库只保存哈希，浏览器登录后只持有 HttpOnly Cookie。
- 节点注册 Token 在 10 分钟有效期内可由已登录管理员查看和复制，但仍只能成功使用一次；数据库保存校验哈希及由本机独立密钥加密的临时展示内容，到期自动删除整条记录。节点长期凭证与固定节点 ID 绑定。
- Agent 在保存和实际执行前都验证路径，并始终使用规范绝对路径；目录权限边界由 Agent 的操作系统用户决定。
- 默认工作空间只能由 Agent 的进程启动目录决定，不能通过 Web 改名、迁移、停用或删除。
- Agent 默认使用 `workspaceWrite` sandbox 并关闭网络访问；只有在本机启动命令显式传入 `--yolo` 时才切换为无审批、无沙箱的全权限模式，Web 会持续标识该状态。
- 默认情况下 Agent 自身网络与 Codex 都遵循代理环境变量及 `NO_PROXY`；显式传入 `--codex-proxy-only` 后，Agent 自身连接强制直连，代理变量只由 Codex 子进程继承。
- 不提供绕过 Codex 的远程 Shell API。
- OpenAI/ChatGPT 凭据始终由节点本地的 Codex 管理。
- Git commit、push 和其他远端写操作仍须在任务中得到明确授权。
