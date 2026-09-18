# Controller Center

一个用于集中管理多台本地 Codex 节点的控制中心。节点上的 Agent 主动连接控制中心，并通过 `stdio` 驱动本地 `codex app-server`；Codex 登录凭据始终留在节点本地。工作区文件默认不上传，只有管理员在对话中明确点击文件链接时，所选文件才会经控制中心短时只读转发用于预览。

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

控制中心与 Agent 使用自有 `control-protocol/v5`。Codex JSON-RPC 的版本差异只在 Agent 内处理。

升级到包含新协议的版本时，必须先完成并重启 Control Plane，再启动同版本 Agent；`4400 Protocol mismatch` 表示双方仍运行不同协议版本，不需要重新注册节点。

## 已实现能力

- Web 使用随机管理员 Token 登录，服务端建立 HttpOnly 会话；管理员原始 Token 不进入前端构建、Local Storage 或 URL。
- Web 可生成 10 分钟有效的节点注册 Token；有效期内可在列表查看、复制和确认注册状态，到期自动删除；Agent 首次注册后使用与固定节点 ID 绑定的独立长期凭证。
- “设置 → 节点接入”可下载与控制中心同版本的 Linux/macOS Agent 安装包，并展示文件大小与 SHA-256；下载接口沿用管理员登录态，不公开匿名静态地址。
- Agent 注册、心跳、断线检测和自动重连；迁移期间仍兼容旧共享 Token。
- Agent 可在启动时显式传入 `--yolo`，以关闭 Codex 审批和沙箱；节点会把当前权限模式上报给中心，Web 在节点名称旁持续显示“全权限”。
- Agent 统一读取 Linux/macOS CLI 常用的代理环境变量；可通过 `--codex-proxy-only` 让控制中心注册、控制通道和附件下载强制直连，同时只让 Codex 子进程继承系统代理。
- Agent 启动目录自动成为不可修改的默认工作空间；还可通过启动配置或 Web 设置为节点登记多个本地路径。
- Web 添加工作空间时由对应 Agent 验证目录存在、可读写并返回规范路径；每次创建会话或新任务前再次验证。
- 每个会话固定绑定一个工作空间；Agent 更换启动目录后，新目录成为默认，仍被会话使用的旧默认目录作为历史工作空间保留。
- 节点默认使用主机名，也可以在 Web 中设置持久化显示名称。
- 节点、工作区、Conversation/Thread 和 Run/Turn 管理；历史会话支持搜索、重命名、置顶、筛选和删除。
- 多节点、多对话；单个节点默认最多并行 5 个顶层任务。工作区已有任务时由用户确认是否仍要并发，确认后不再强制排队。
- 新会话在首次发送时原子创建，使用持久化幂等号避免双击、刷新和重试产生重复会话。
- Agent 通过 `model/list` 发布本机可用模型及思考强度，结果按 Codex 版本在本机缓存 24 小时，Web 可按会话选择。
- 只持久化用户消息、Codex 回复和简洁进度；命令输出、Diff、推理增量和原始事件不会发送到中心。
- 命令执行与文件修改的最小必要确认信息，以及 `request_user_input` 表单。
- 任务追加指令、中止当前轮次和失败状态；中止后可在同一历史会话继续发起新轮次。
- 主内容区任务中心只保留全局节点菜单，隐藏依赖当前节点的历史会话栏；仅在用户未查看对应会话时生成未读完成、失败或等待操作通知，并展示会话名与对应任务最新回复摘要。
- 任务中心支持会话名称/节点名称搜索、节点与状态筛选、全部标为已读，以及失败任务幂等重新执行。
- 全局快速切换支持按节点名称或会话名称搜索所有节点和跨节点历史会话；空关键词不加载历史会话，有关键词时最多返回 10 条会话结果。桌面端可使用 `Ctrl/Cmd + K`，移动端底部工具栏按“节点、消息、搜索、设置”排列，节点入口直接显示在线数/总数。
- 会话列表使用服务端名称搜索与游标分页，每页 50 条，浏览器最多缓存 300 条；更早会话继续通过名称搜索访问，不会下载或检索消息正文、代码和附件内容。
- 任务中心最多展示 200 条，摘要最多 120 个字符；已读通知保留 30 天、未读通知保留 90 天，通知清理不影响会话历史。
- 全局默认模型和思考强度设置，节点不支持偏好模型时回退本机默认；设置页展示构建版本号。
- 文件上传、拖拽和粘贴图片；分片续传、SHA-256 校验和 Agent 本地缓存。
- Agent 本地 SQLite inbox/outbox、命令去重、消息补发和重连状态协调。
- 浏览器 SSE 使用持久游标重放并按资源精准刷新；正常连接时每 60 秒权威同步，断线时每 10 秒兜底轮询，页面恢复可见时立即同步。
- 回复流式刷新时同步渲染 Markdown 和 KaTeX，兼容 `$...$`、`$$...$$`、`\(...\)` 与 `\[...\]`。
- 对话中的本地绝对路径和相对路径由当前会话绑定的 Agent 只读打开，并在独立标签页预览；支持 Markdown、沙箱 HTML、CSV、TSV、常见图片、PDF、JSON、常见脚本/配置文件和其他文本文件，外部 URI 不会请求 Agent。
- 每个会话持久保存成功打开过的文件路径，并在可折叠的右侧文件栏按最后查看时间倒序展示；重复打开自动去重，点击时重新读取最新内容，删除只移除查看记录。
- 长对话默认读取最近 60 条消息，可按游标加载更早消息；历史阅读窗口最多保留 500 条，并提供“返回最新消息”，同时使用动态高度虚拟列表，避免长时间挂机或连续翻页导致前端内存无限增长。
- 已就绪且没有运行中任务的会话可在输入框附近手动压缩上下文；操作需要二次确认，压缩状态可跨刷新和短暂断线恢复，聊天记录不会被删除。
- Codex App Server 错误会归类为上下文超限、额度/限流、登录失效、服务或响应流中断、沙箱、安全策略、无效请求等稳定业务类型，同时保留简短上游诊断信息。
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

完整构建会同时生成 `artifacts/controller-center-agent-v<版本>.tar.gz`。只需重新构建 Agent 安装包时可执行：

```bash
npm run package:agent
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

打开 `http://127.0.0.1:5174` 并使用上面的管理员 Token 登录。开发服务器会把同源 `/api`、`/agent/connect`、`/agent/enroll` 和附件下载代理到本机控制中心。如果开发版使用与控制面配置不同的 Origin，启动时通过 `CONTROL_PROXY_ORIGIN=https://control.example.com` 让开发代理重写 Origin，无需放宽生产控制面的 CORS 白名单。

当共享控制面按 HTTPS 生产域名签发 `Secure` 会话 Cookie 时，5174 开发代理会把它转换为仅供本地 HTTP 使用的 `cc_dev_session` HttpOnly Cookie，并在转发请求时映射回控制面所需名称。因此 `http://localhost:5174` 与 `http://127.0.0.1:5174` 都可登录，且不会改变 5173 的生产 Cookie。

本机非容器部署可以同时保留生产版和开发版：

```bash
# 构建并重启控制中心，固定带上生产域名白名单、公开 Origin 与代理信任配置
npm run deploy:control-plane:production

# 构建后发布到 Nginx，固定监听 5173；只有再次执行此命令才会更新生产页面
npm run deploy:web:production

# 源码热更服务，固定监听 5174
CONTROL_PROXY_ORIGIN=https://control.example.com npm run dev:web
```

两个 Web 入口都代理到同一个 `8787` 控制面，因此共享 SQLite 数据、登录配置、节点、Agent 连接和附件。生产页面使用 `/var/www/controller-center-web/current` 指向的独立 release，编辑工作区源码不会自动改变已发布页面。

生产控制中心不要直接执行 `node apps/control-plane/dist/index.js`。统一使用 `npm run deploy:control-plane:production`，脚本默认设置 `PUBLIC_ORIGIN=https://c.llmdev.cn`、`CORS_ORIGIN=https://c.llmdev.cn` 和 `TRUST_PROXY=true`，并在重启后检查健康状态及 CORS 响应。如需迁移域名，可通过 `CONTROLLER_CENTER_PUBLIC_ORIGIN` 覆盖公开地址，通过 `CONTROLLER_CENTER_CORS_ORIGIN` 配置逗号分隔的额外白名单。

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

Agent 需要直接访问本机 Codex、Git 和工作区，因此推荐作为宿主机服务运行，而不是放入容器。登录 Web 后进入“设置 → 节点接入”，可直接下载当前版本的完整客户端安装包；该包已经包含编译结果和生产依赖，无需在节点上执行 `npm install` 或 TypeScript 编译。

```bash
cc_agent_archive=controller-center-agent-v0.3.13.tar.gz
cc_agent_directory=${cc_agent_archive%.tar.gz}
tar -xzf "$cc_agent_archive"
sudo mv "$cc_agent_directory" /opt/controller-center-agent
/opt/controller-center-agent/agent.sh login
```

也可以在仓库执行 `npm run package:agent` 后，从 `artifacts/` 取得同一压缩包。服务部署参考：

- `deploy/systemd/controller-center-agent.service`
- `deploy/agent.env.example`

Agent 的运行用户必须对配置的工作区具有适当权限，并且该用户需要完成本地 Codex 登录。`AGENT_DATA_DIR` 不设置时默认使用 `~/.controller-center-agent`，它保存稳定节点身份而不决定默认工作空间；默认工作空间仍由启动目录决定。
systemd 的 `WorkingDirectory` 决定该节点的默认工作空间；独立包中的示例默认为 `/opt/controller-center-agent`，正式部署时应改成希望交给 Codex 使用的工作目录。
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
| `AGENT_ARTIFACT_DIR` | `<启动命令所在目录>/artifacts` | 供已登录管理员下载的 Agent 安装包目录；文件名必须与当前 Agent 版本一致 |
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
| `MAX_CONCURRENT_RUNS` | `5` | 单个节点的最大活动任务总数；超过后排队 |
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
- `GET /api/conversations/:id?messageLimit=60&beforeMessage=<cursor>`（最近消息与向前分页）
- `DELETE /api/conversations/:id`
- `GET /api/conversations/:id/workspace-file-history`（按最后查看时间读取当前会话的全部文件历史）
- `DELETE /api/conversations/:id/workspace-file-history/:fileId`（仅删除文件查看记录）
- `POST /api/conversations/:id/workspace-files`（从会话绑定的 Agent 创建短时只读文件预览）
- `GET /api/workspace-files/:id`（登录后读取短时预览元数据）
- `GET /api/workspace-files/:id/content`（登录后读取短时预览内容）
- `POST /api/conversations/:id/runs`
- `POST /api/runs/:id/steer`
- `POST /api/runs/:id/interrupt`
- `POST /api/runs/:id/retry`（失败或中止任务幂等重新执行）
- `GET /api/approvals?status=pending`
- `POST /api/approvals/:id/resolve`
- `GET/PATCH /api/settings`
- `GET /api/agent-package`（当前 Agent 安装包版本、大小和 SHA-256）
- `GET /api/agent-package/download`（登录后下载当前版本安装包）
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
- 对话文件预览只由明确点击触发：相对路径从会话工作空间或当前已打开文件目录解析，绝对路径可位于工作空间外，因此其读取边界同样是 Agent 运行用户的操作系统权限。仅普通文件可读，拒绝 `/proc`、`/sys`、`/dev` 和设备路径，单文件限制为 8 MiB。
- 预览文件内容只在控制面内存中保留 5 分钟并使用随机 ID，不写入 SQLite；成功打开后只持久保存会话、规范路径、类型、大小和查看时间。删除文件历史只删除这条元数据，不会请求 Agent 删除实际文件。每个会话限流且每个 Agent 限制并发读取。HTML 在无脚本、无同源权限的 iframe sandbox 中渲染，SVG 不直接渲染。
- 默认工作空间只能由 Agent 的进程启动目录决定，不能通过 Web 改名、迁移、停用或删除。
- Agent 默认使用 `workspaceWrite` sandbox 并关闭网络访问；只有在本机启动命令显式传入 `--yolo` 时才切换为无审批、无沙箱的全权限模式，Web 会持续标识该状态。
- 默认情况下 Agent 自身网络与 Codex 都遵循代理环境变量及 `NO_PROXY`；显式传入 `--codex-proxy-only` 后，Agent 自身连接强制直连，代理变量只由 Codex 子进程继承。
- 不提供绕过 Codex 的远程 Shell API。
- OpenAI/ChatGPT 凭据始终由节点本地的 Codex 管理。
- Git commit、push 和其他远端写操作仍须在任务中得到明确授权。
