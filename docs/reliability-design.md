# Controller Center 可靠性设计

> 状态：核心链路已实施，持续进行故障注入验证
> 目标：避免重复任务、丢失消息、虚假完成、永久卡住和附件不一致

## 1. 可靠性边界

系统由四个独立故障域组成：

```text
Browser ⇄ Control Plane ⇄ Node Agent ⇄ Codex App Server
```

必须假设任意一段网络会断开、任意进程会重启、消息会重复、确认消息会丢失。设计目标不是依赖“连接一直存在”，而是让持久状态可以重新协调。

## 2. 交付语义

### 2.1 浏览器写请求

- 新建会话并首轮发送继续使用持久 `clientRequestId`。
- 每次新轮次增加独立 `clientRequestId`，由 Control Plane 建唯一索引。
- 附件提交使用上传会话 ID 和分片 ID，重复提交不重复占用存储。
- 浏览器只对网络错误和明确可重试状态自动重试；业务冲突直接展示。
- 失败任务的“重新执行”使用由源 Run ID 派生的稳定 `clientRequestId`；对同一个失败 Run 重复点击或 HTTP 响应丢失时返回同一个新 Run，不重复执行。

目标语义：用户操作“效果一次”，即使 HTTP 响应在返回前丢失。

### 2.2 Control Plane 到 Agent

- 每条控制命令具有稳定 `commandId`。
- Control Plane 在发送前持久化命令。
- Agent 在产生任何副作用前持久化命令日志。
- 重复命令返回已有状态，不重复执行。
- Control Plane 只有收到完成确认或状态协调结果后，才进入最终状态。

### 2.3 Agent 到 Control Plane

- 使用 `bootId + sequence` 作为耐久消息唯一键。
- Agent 先写 SQLite Outbox，再发送。
- Control Plane 在事务提交后才发送 Delivery Ack。
- Agent 收到 Ack 后删除 Outbox 记录。

### 2.4 出站代理策略

- 默认模式下，注册 HTTP 请求、Agent 附件下载和 WSS 控制通道使用相同的环境代理解析规则，并遵循 `NO_PROXY`。
- `--codex-proxy-only` 模式为 Agent 的上述连接显式选择直连 Dispatcher/Agent，不能依赖各网络库是否隐式读取环境变量。
- 代理环境不被删除或改写，Codex App Server 子进程始终继承原始环境；这样切换只影响 Agent 自身网络，不影响 Codex。
- 注册 CLI 是独立进程，必须独立解析同名参数。代理地址、用户名和密码不进入日志、协议或数据库。
- Control Plane 对重复序列去重。

### 2.5 对话文件预览

- 文件读取是有 15 秒超时的非耐久请求—响应，不进入命令表或 Agent Outbox；断线、进程重启或超时后直接失败，不自动重放读取。
- Agent 通过可选 capability 宣告支持，Control Plane 只向支持该能力的在线 Agent 发送请求，便于旧 Agent 滚动升级。
- 同一 Agent 最多同时处理 4 个读取请求。成功内容经 WSS 返回后只在 Control Plane 内存缓存 5 分钟；缓存丢失只要求用户重新点击，不影响会话状态。
- 浏览器后续相对链接只提交短时文件 ID，Control Plane 校验其会话和节点归属后才把服务端保存的规范路径作为基准传给 Agent，避免浏览器伪造另一个会话的基准文件。
- Agent 成功返回后，Control Plane 以会话和规范绝对路径为唯一键持久保存文件查看元数据，并发布可重放 UI 事件；其他标签页打开相对文件时，原聊天页也能刷新文件栏。文件内容仍不落库。
- 文件历史删除只操作 Control Plane 元数据。重新打开历史记录时再次执行受限的 Agent 文件读取，因此文件修改、删除、Agent 离线和权限变化都会反映为当次真实结果。

当前实现已具备该基础；协议 v5 使用产品级消息、进度和会话压缩事件，并增加工作空间同步与在线验证。

## 3. 协议 v5

### 3.1 Agent 上报消息

保留：

- `conversation.bound`
- `run.started`
- `run.progress`
- `message.snapshot`
- `conversation.tokenUsage`
- `conversation.compaction`
- `run.finished`
- `interaction.requested`
- `interaction.resolved`
- `agent.error`
- `agent.stateReport`

移除产品链路中的通用 `codex.event`。调试模式可在 Agent 本机输出日志，但不经过耐久 Outbox，也不传到 Control Plane。

### 3.2 `run.progress`

```ts
interface RunProgressPayload {
  type: "run.progress";
  runId: string;
  conversationId: string;
  phase: "analyzing" | "working" | "verifying" | "waiting_user" | "finalizing" | "compacting" | "retrying";
  label: string;
  occurredAt: string;
}
```

`label` 必须由 Agent 的固定映射表产生，不直接携带命令、文件路径、工具参数或输出。Control Plane 只保留每个 Run 的最新进度，不保存完整进度事件历史。

### 3.3 `message.snapshot`

```ts
interface MessageSnapshotPayload {
  type: "message.snapshot";
  messageId: string;
  conversationId: string;
  runId: string;
  role: "assistant";
  revision: number;
  content: string;
  complete: boolean;
  occurredAt: string;
}
```

- Agent 在内存中聚合 token delta。
- 最多每 250ms 或累计 2KB 后发送一次快照。
- 同一 `messageId` 的 `revision` 单调递增。
- Control Plane 只接受更高 revision，重复和乱序快照不会覆盖新内容。
- 完成、失败、停止和进程退出前必须发送最终快照。

### 3.4 工作空间同步与验证

- `agent.hello` 只发布 Agent 本地决定的默认工作空间和启动配置工作空间。
- `agent.hello` 同时发布进程级权限模式；Control Plane 持久化最后一次握手值，旧 Agent 未上报时按 `workspace-write` 处理。
- Control Plane 持久保存 Web 添加及历史保留工作空间，并在握手成功后通过 `control.workspaceSync` 下发到 Agent 内存注册表。
- `control.workspaceValidate` / `agent.workspaceValidation` 使用独立 `requestId` 做一次性请求响应，默认 10 秒超时；节点断线或连接被替换时立即拒绝所有挂起验证。
- Agent 返回 `realpath` 解析后的规范绝对路径，只认可存在、为目录且当前运行用户可读写的路径。
- 工作空间验证消息不进入耐久任务 Outbox；只有验证成功后的配置和任务创建才持久化，断线时由调用方明确失败并保留用户输入。
- 每次创建会话、开始新轮次或重试前由 Control Plane 在线复验；Agent 在 `thread/start` / `turn/start` 前再次本地复验，避免验证后目录被删除、换成链接或失去权限。

### 3.5 `conversation.tokenUsage`

```ts
interface ConversationTokenUsagePayload {
  type: "conversation.tokenUsage";
  conversationId: string;
  remoteThreadId: string;
  tokenUsage: {
    totalTokens: number;
    contextTokens: number;
    modelContextWindow: number | null;
    updatedAt: string;
  };
}
```

- Agent 复用 Codex App Server 主动推送的 `thread/tokenUsage/updated`，不增加模型目录轮询或额外 OpenAI 请求。
- `totalTokens` 来自 Thread 累计统计；`contextTokens` 来自最近一轮统计，用于计算当前上下文占用比例；`modelContextWindow` 缺失时显示未知。
- Agent 对相同 Thread 的相同统计值去重后再进入耐久 Outbox，Control Plane 只接受会话所属节点和远端 Thread ID 均匹配且时间不早于已有记录的数据。
- Token 更新只刷新当前打开会话的详情，不改变会话排序，也不触发全量会话列表刷新。
- 首次升级到支持该字段的版本时，Control Plane 在 Agent 握手响应中只下发 `token_usage_json` 为空的旧会话；Agent 顺序执行本地 `thread/resume` 并立即取消订阅以触发一次统计回填。回填成功后该会话不再进入后续握手任务，新会话始终使用实时通知。

### 3.6 `conversation.compaction`

- Web 使用稳定 `clientRequestId` 发起压缩，Control Plane 先持久化会话级压缩状态和 `conversation.compact` 命令，再向 Agent 投递。
- Agent 调用 Codex App Server 的 `thread/compact/start`；进度通过 `turn/*` 与 `contextCompaction` item 生命周期确认，不根据 RPC 的空响应提前判定完成。
- 压缩状态为 `queued / dispatching / running / recovering / completed / failed`，与普通 Run 分离。活动压缩期间禁止开始新 Run、追加指令和删除会话。
- 节点短暂断线时进入 `recovering`；Agent 重连上报活动压缩 ID 后恢复为 `running`。无法确认或超过 120 秒时明确失败，不自动重复压缩。
- 会话消息不会因压缩被删除；压缩前后上下文 Token 仅作为状态快照，权威 Token 指标仍来自 `thread/tokenUsage/updated`。

## 4. Run 状态机

```text
queued → dispatching → running → completed
                        │  ├──→ waiting_user → running
                        │  ├──→ interrupted
                        │  ├──→ recovering → running/completed/failed
                        │  └──→ failed
                        └─────→ recovering（连接或进程状态未知）
```

约束：

- 最终状态 `completed / failed / interrupted` 不允许被普通事件改回活动状态。
- 节点断线不立即将 Run 标记失败，先进入 `recovering`。
- 恢复协调有明确超时；超时后标记失败并说明“无法确认远端任务状态”。
- `waiting_user` 只表示对话内需要用户操作，不建设独立审批队列页面。
- 用户界面中的“中止本轮”对应 `turn/interrupt`；除非 App Server 提供可验证的检查点恢复，不使用“暂停后继续”表述。

## 5. 重连与状态协调

### 5.1 Agent 重连握手

Agent Hello 后增加状态报告：

- Agent 当前 `bootId`。
- Agent 命令日志中未结束或 uncertain 的命令。
- 已绑定 Conversation 与 Thread ID。
- 已知活动 Run、Turn ID 和最后消息 revision。
- Outbox 最小、最大待发送 sequence。
- 当前启动目录决定的默认工作空间及启动配置工作空间。
- 当前进程权限模式（`workspace-write` 或 `danger-full-access`）。

Control Plane 对比数据库后返回协调指令：

- 重发安全且幂等的命令。
- 接受 Agent 已完成但中心尚未确认的结果。
- 要求 Agent 查询 Thread/Turn 当前状态。
- 对无法确认的任务进入 `recovering`，而不是静默重跑。
- 将 Control Plane 中有效的 Web/历史工作空间重新同步给 Agent；离线期间的配置不依赖 Agent 本地持久化。

### 5.2 App Server 重启

- Agent 重新启动 App Server 后使用 `thread/read` 或可用的列表接口恢复已绑定 Thread。
- 对运行中的 Turn 查询当前状态；不能查询时上报 uncertain。
- 禁止仅因为 Agent 重启而自动重新执行用户任务，这可能造成重复文件修改。
- 若无法证明原 Turn 未执行，必须让 Run 失败为“状态不确定”，允许用户显式重新发送。

### 5.3 超时建议

- 心跳间隔：15 秒。
- 45 秒未收到心跳：节点进入 offline，活动 Run 进入 recovering。
- Agent 重连协调等待：120 秒。
- 未收到 Ack 的 queued 命令每 15 秒重试；accepted 命令不做周期重投，只在 Agent 重新建立连接时按原 commandId 协调一次。
- WebSocket 重连使用 1 秒起步、最长 30 秒并带随机抖动的指数退避；连接稳定 30 秒后才清零失败次数，避免握手后立即断开造成重连风暴。
- 等待用户操作不受普通运行超时限制。

上述时间应配置化。

## 6. 浏览器快照与实时流

当前 SSE 使用可恢复游标和轻量资源事件：

1. Control Plane 为 UI 状态变化分配单调递增 `revision`。
2. REST 快照返回 `snapshotRevision`。
3. 浏览器建立 `/api/stream?after=<snapshotRevision>`。
4. SSE 每条事件设置 `id: <revision>`。
5. 断线重连使用 `Last-Event-ID`；服务端重放尚未收到的轻量通知。
6. 若游标早于服务端保留窗口，返回 `resync-required`，浏览器重新获取完整快照。

UI 事件日志只记录资源 ID、会话归属和变更类型，不保存对话正文或命令详情。建议保留 24 小时，并设置最大条数。

为避免“先拉快照、后订阅”之间漏事件，服务端必须支持从快照 revision 继续订阅，而不是依赖调用顺序和时间窗口。

浏览器按事件 `type` 和 `conversationId` 精准刷新节点、会话、审批、通知或设置；同一会话的流式消息事件最多每 500ms 合并刷新一次，会话列表最多每 1.5 秒刷新一次。SSE 正常时每 60 秒做一次权威全量同步，SSE 断开时切换为每 10 秒轮询，页面回到前台时立即同步。

长对话首次只读取最近 60 条消息，通过不透明游标按需向前分页，每页最多 100 条。实时模式用最新页替换浏览器消息窗口，不跨刷新累计；用户主动加载更早消息后进入历史阅读模式，消息最多保留 500 条，继续向前翻页时丢弃窗口较新的部分，并用固定入口返回最新 60 条。历史阅读期间后台刷新只更新会话元数据、运行状态和审批，不把新消息混入当前阅读位置。消息 DOM 同时使用动态高度虚拟列表，只渲染视口附近的消息并保留少量 overscan。自动定位必须禁用容器级全局平滑滚动，避免动态测量期间滚动位置与高度修正互相追赶；用户主动上滑后关闭流式跟随，显式点击“滑动到底部”再恢复。

会话侧栏每页读取 50 条、浏览器最多缓存 300 条。达到缓存上限后停止继续翻页，更早记录必须使用服务端会话名称搜索定位；节点切换、筛选或搜索条件变化会重新建立该条件下的缓存窗口。

Agent 的 `model/list` 结果按 Codex 版本缓存在本机 24 小时。缓存过期时刷新一次；刷新失败继续使用旧缓存，不因进程反复重启持续请求模型目录。

### 6.1 Web 错误分层与恢复

前端不得把所有 API 失败统一描述为“无法连接控制中心”。每个请求错误统一保留 `kind`、HTTP 状态、请求方法、接口路径和服务端请求 ID，并按以下规则处理：

| 错误类型 | 界面行为 | 恢复方式 |
| --- | --- | --- |
| 浏览器网络请求失败 | 显示具体刷新或操作名称、接口路径，并提示检查网络、HTTPS 或反向代理 | 后台读取继续定时重试；写操作不自动重放，依赖稳定 `clientRequestId` 由用户安全重试 |
| HTTP 401 | 不显示普通业务错误，自动清理当前认证界面状态并回到 Token 登录 | 用户重新登录 |
| HTTP 404：当前会话不存在 | 清除该设备保存的失效会话 ID，保留节点选择并回到新会话草稿 | 自动完成，不显示错误横幅 |
| HTTP 4xx 业务拒绝 | 在触发操作的表单或按钮附近展示服务端业务原因、HTTP 状态和请求信息 | 用户按业务提示修正；不进行无意义自动重试 |
| HTTP 5xx | 显示操作名称、服务异常和请求 ID，不向浏览器暴露堆栈 | 服务端日志使用同一请求 ID 定位完整异常；后台读取自动重试 |
| 2xx 但正文为空或不是 JSON | 明确提示响应格式异常，避免把 Nginx/网关 HTML 当业务文本展示 | 检查反向代理路由；后台读取自动重试 |
| 旧请求晚于新请求返回 | 丢弃旧结果和旧错误，不改变用户当前节点或会话 | 请求 revision 自动处理 |

后台的节点、会话列表、会话详情、待处理请求、设置和任务中心分别保存错误状态。任一接口成功只能清除自身错误，不能掩盖其他仍在发生的故障。界面保留上次成功数据，并提供立即重试入口；周期刷新成功后自动移除错误。

Control Plane 为所有 HTTP 响应设置 `X-Request-Id`，跨域部署时显式暴露该响应头。未捕获的服务端异常记录完整结构化日志，浏览器只接收统一的中文错误和请求 ID；认证令牌、消息正文、命令输出与附件内容不得写入错误信息。

### 6.2 Codex App Server 错误归类

Agent 将 App Server `error` 通知中的 `codexErrorInfo` 映射为稳定的 `errorCode`，包括上下文超限、会话预算、使用额度、限流、登录失效、服务不可用、响应流中断、沙箱失败、安全策略阻止、无效请求、活动 Turn 冲突、内部错误和未知错误。

- `willRetry=true` 只更新简洁进度为“正在自动重试”，不提前把 Run 或压缩标记失败。
- 最终失败把业务化中文原因和 `errorCode` 一起写入 Run 或会话压缩状态，并保留截断、单行化的上游消息供排查。
- Web 直接展示该业务原因；只有浏览器到 Control Plane 的 Fetch 失败才描述为网络或反向代理问题。
- 上下文超限会突出压缩入口，但不会自动发起压缩；登录、额度、安全策略和无效请求等错误不做危险的自动重放。
- 终态不可被迟到的 `agent.error` 覆盖，重复 Durable Message 和 Command Ack 必须幂等。

## 7. 数据模型与事务

### 7.1 新增表

- `messages(id, conversation_id, run_id, role, content, revision, complete, created_at, updated_at)`
- `notifications(id, run_id, conversation_id, node_id, kind, status, read_at, created_at)`
- `settings(scope, scope_id, key, value_json, updated_at)`
- `conversations.compaction_json` 保存最近一次会话级压缩状态；`runs.error_code` 保存稳定错误分类。
- `attachments(id, conversation_id, message_client_id, name, media_type, size, sha256, status, storage_key, expires_at, created_at)`
- `conversation_opened_files(id, conversation_id, path, name, media_type, size, open_count, first_opened_at, last_opened_at)`，以 `(conversation_id, path)` 去重并随会话级联删除。
- `ui_events(revision, type, resource_id, occurred_at)`

### 7.2 修改表

- `runs` 增加 `client_request_id` 唯一键、`progress_phase`、`progress_label`、`progress_updated_at` 和 `recovery_deadline_at`。
- `conversations` 增加 `pinned_at`，标题索引及必要搜索索引。
- `workspaces` 增加来源、默认标记、验证状态、验证错误、最后验证时间、停用时间和审计时间；会话继续使用稳定 `workspace_id` 绑定。
- `events` 不再承担产品消息恢复；迁移完成后可按版本清理旧详细数据。

### 7.3 事务边界

以下操作必须在单个数据库事务中完成：

- 创建 Run + 创建 Command + 创建 UI revision。
- 接收 message snapshot + 更新 conversation 时间 + 创建 UI revision。
- Run 最终状态 + notification + 清理等待操作 + UI revision。
- 删除 conversation + message/notification/attachment 元数据清理标记。
- 接收 Agent durable message + 业务写入 + delivery 去重记录。
- Agent 注册时更新节点、本地工作空间、旧默认目录历史保留必须原子提交；握手失败不能留下半在线节点。

## 8. 附件可靠性

- 上传先创建 upload session，再分片上传并记录 offset。
- 断线后客户端查询已接收 offset 并续传。
- finalize 时校验总大小和 SHA-256，再将状态改为 ready。
- 只有 ready 附件可以随消息提交。
- Agent 下载使用临时文件，校验哈希后原子重命名。
- Agent Ack 已准备附件后才能启动 Turn。
- 任何附件失败都不能悄悄忽略；整条消息保持 failed-to-dispatch，可单独重试。
- 清理任务采用“先标记、后删除”，失败后可重复执行。

## 9. 并发与排队

- 每个 Agent 遵守 `maxConcurrentRuns`，默认最多同时执行 5 个顶层任务；该限制按节点统计，不区分工作空间。
- Control Plane 不设置跨节点的全局并发总量；多个 Agent 各自独立执行并遵守自己的节点上限。
- 提交任务时若同一规范路径已有运行中或排队中的 Run，Control Plane 返回 `workspace_busy` 冲突，由客户端向用户说明并发修改风险。
- 用户确认后，客户端以 `allowWorkspaceConcurrency` 显式重试；同一工作空间的不同会话可以并发执行。
- 同一会话仍按 turn 串行调度；追加指令使用 steer，不会为同一个 Codex thread 并行启动两个 turn。
- 未确认的工作空间冲突不会创建会话、Run 或 Command，避免取消后留下幽灵任务。
- 节点达到总并发上限时，新 Run 仍可靠落库并保持 queued，待任一活动 Run 结束后按节点内 FIFO 自动投递。
- 活动 Run 结束、失败或重连协调完成后，Control Plane 自动投递下一条可执行命令。
- 调度采用同一节点内 FIFO；未来若需要优先级，再扩展而不改变 v1 行为。

## 10. 存储与清理

建议默认：

- 会话和消息：保留到用户删除。
- 详细命令与命令输出：不进入中心存储。
- Command 元数据：最终状态后保留 7 天，用于可靠性去重和诊断。
- UI cursor events：24 小时或最近 100,000 条。
- 通知页面最多返回最近 200 条；已读通知保留 30 天，未读通知保留 90 天，数据库优先清理超期和较旧的已读通知。
- Control Plane 临时附件：7 天；会话删除时提前清理。
- Agent 附件缓存：任务结束 24 小时后清理。

SQLite 使用 WAL、`busy_timeout` 和周期 checkpoint。正式长期运行需要定期在线备份及恢复演练，而不仅是复制正在写入的数据库文件。

周期任务按成本分层：节点离线与恢复超时检查最多每 15 秒执行；注册 Token、临时附件和登录限流记录每分钟清理；通知、UI 事件及管理员会话保留数据每小时清理，避免把低优先级维护查询混入高频心跳路径。

## 11. 可观测性

用户界面只显示简单进度，但服务本身仍需结构化日志和指标：

- 在线 Agent 数、重连次数和心跳延迟。
- queued/running/recovering/failed Run 数。
- Outbox 深度和最老消息年龄。
- Command Ack 延迟和重试次数。
- SSE 活跃连接和重放数量。
- 附件上传失败、哈希失败和清理失败。

日志不得记录用户消息全文、命令输出、附件内容或认证令牌。所有关联使用 nodeId、conversationId、runId、commandId。

## 12. 故障场景与期望行为

| 场景 | 期望行为 |
| --- | --- |
| 用户双击发送 | 唯一 clientRequestId，只产生一个 Run |
| HTTP 已执行但响应丢失 | 浏览器重试后返回原 Run |
| SSE 断开 5 分钟 | 使用游标重放；过期则全量同步 |
| Agent 网络中断 | Run 进入 recovering，重连后协调 |
| Agent 重启 | 不盲目重跑；查询远端状态或明确 uncertain |
| Control Plane 重启 | queued 命令和状态从数据库恢复并继续投递 |
| 同一消息快照重复/乱序 | revision 去重，不倒退、不重复文本 |
| 附件上传中断 | 从已确认 offset 续传 |
| 附件传到 Agent 时损坏 | SHA-256 失败，任务不启动并允许重试 |
| 节点离线时发送 | 草稿保留，不创建不可投递的隐形任务 |
| Web 添加不存在或无权限目录 | Agent 验证失败，不保存工作空间，表单内容保留 |
| 路径在创建任务前失效 | 不创建 Run；工作空间标记失效并提示重新验证或迁移 |
| Agent 从不同目录重启 | 新目录成为默认；有会话引用的旧默认转为历史工作空间并继续按原路径工作 |
| 默认目录与既有 Web 路径重合 | 新会话只展示默认项；有会话引用的旧 ID 作为历史别名保留，调度仍按路径串行 |
| 浏览器缓存了已删除的会话 ID | 自动清除失效 ID，保留当前节点并进入新会话，不显示连接失败 |
| Nginx 返回 HTML 错误页 | 按 HTTP/响应格式异常展示，不把 HTML 原文作为业务错误输出 |

## 13. 验收测试

除现有单元与浏览器测试外，必须增加：

1. HTTP 响应丢失后的重复提交测试。
2. Agent Outbox 重复投递与乱序快照测试。
3. SSE 快照到订阅的竞态测试。
4. Control Plane 运行中重启测试。
5. Agent 在 run.started 前后分别重启的测试。
6. 网络断开 30 秒、5 分钟后的恢复测试。
7. 多节点、多工作区并发、同工作区风险确认与节点总并发排队测试。
8. 附件断点续传、哈希错误、过期清理测试。
9. 320px、390px、820px 和桌面视口的完整流程测试。
10. 数据库从当前 schema 到新 schema 的迁移及回滚备份测试。
11. 至少 160 条混合高度消息的虚拟渲染、首次定位、回到底部及流式跟随测试。
12. 工作空间添加/复验/迁移/停用/删除、默认目录不可变、Agent 更换启动目录及同路径别名串行测试。
13. 会话列表 300 条和历史消息 500 条的浏览器硬上限、历史阅读期间流式刷新隔离及返回最新窗口测试。

在这些故障注入测试通过前，不把“自动恢复”标记为已完成。
