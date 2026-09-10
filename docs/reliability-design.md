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
- Control Plane 对重复序列去重。

当前实现已具备该基础，本期需要在协议 v3 中将原始 Codex 事件替换为产品级消息和进度事件。

## 3. 协议 v3

### 3.1 Agent 上报消息

保留：

- `conversation.bound`
- `run.started`
- `run.progress`
- `message.snapshot`
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
  phase: "analyzing" | "working" | "verifying" | "waiting_user" | "finalizing";
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

Control Plane 对比数据库后返回协调指令：

- 重发安全且幂等的命令。
- 接受 Agent 已完成但中心尚未确认的结果。
- 要求 Agent 查询 Thread/Turn 当前状态。
- 对无法确认的任务进入 `recovering`，而不是静默重跑。

### 5.2 App Server 重启

- Agent 重新启动 App Server 后使用 `thread/read` 或可用的列表接口恢复已绑定 Thread。
- 对运行中的 Turn 查询当前状态；不能查询时上报 uncertain。
- 禁止仅因为 Agent 重启而自动重新执行用户任务，这可能造成重复文件修改。
- 若无法证明原 Turn 未执行，必须让 Run 失败为“状态不确定”，允许用户显式重新发送。

### 5.3 超时建议

- 心跳间隔：10 秒。
- 连续 3 次心跳缺失：节点进入 offline，活动 Run 进入 recovering。
- Agent 重连协调等待：120 秒。
- 普通命令 Ack：15 秒后重发，同一 commandId 最多指数退避到 30 秒。
- 等待用户操作不受普通运行超时限制。

上述时间应配置化。

## 6. 浏览器快照与实时流

当前 SSE 只触发重新拉取，缺少可恢复游标。目标方案：

1. Control Plane 为 UI 状态变化分配单调递增 `revision`。
2. REST 快照返回 `snapshotRevision`。
3. 浏览器建立 `/api/stream?after=<snapshotRevision>`。
4. SSE 每条事件设置 `id: <revision>`。
5. 断线重连使用 `Last-Event-ID`；服务端重放尚未收到的轻量通知。
6. 若游标早于服务端保留窗口，返回 `resync-required`，浏览器重新获取完整快照。

UI 事件日志只记录资源 ID 和变更类型，不保存对话正文或命令详情。建议保留 24 小时，并设置最大条数。

为避免“先拉快照、后订阅”之间漏事件，服务端必须支持从快照 revision 继续订阅，而不是依赖调用顺序和时间窗口。

长对话的消息 DOM 使用动态高度虚拟列表，只渲染视口附近的消息并保留少量 overscan。自动定位必须禁用容器级全局平滑滚动，避免动态测量期间滚动位置与高度修正互相追赶；用户主动上滑后关闭流式跟随，显式点击“滑动到底部”再恢复。

## 7. 数据模型与事务

### 7.1 新增表

- `messages(id, conversation_id, run_id, role, content, revision, complete, created_at, updated_at)`
- `notifications(id, run_id, conversation_id, node_id, kind, status, read_at, created_at)`
- `settings(scope, scope_id, key, value_json, updated_at)`
- `attachments(id, conversation_id, message_client_id, name, media_type, size, sha256, status, storage_key, expires_at, created_at)`
- `ui_events(revision, type, resource_id, occurred_at)`

### 7.2 修改表

- `runs` 增加 `client_request_id` 唯一键、`progress_phase`、`progress_label`、`progress_updated_at` 和 `recovery_deadline_at`。
- `conversations` 增加 `pinned_at`，标题索引及必要搜索索引。
- `events` 不再承担产品消息恢复；迁移完成后可按版本清理旧详细数据。

### 7.3 事务边界

以下操作必须在单个数据库事务中完成：

- 创建 Run + 创建 Command + 创建 UI revision。
- 接收 message snapshot + 更新 conversation 时间 + 创建 UI revision。
- Run 最终状态 + notification + 清理等待操作 + UI revision。
- 删除 conversation + message/notification/attachment 元数据清理标记。
- 接收 Agent durable message + 业务写入 + delivery 去重记录。

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

- 每个 Agent 遵守 `maxConcurrentRuns`。
- 同一工作区默认只允许一个可能修改文件的活动 Run，避免并发互相覆盖。
- 不同工作区或明确只读任务可以并发。
- 同一工作区已有活动 Run 或节点达到并发上限时，新 Run 仍可靠落库并保持 queued，不向用户返回冲突失败。
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

## 13. 验收测试

除现有单元与浏览器测试外，必须增加：

1. HTTP 响应丢失后的重复提交测试。
2. Agent Outbox 重复投递与乱序快照测试。
3. SSE 快照到订阅的竞态测试。
4. Control Plane 运行中重启测试。
5. Agent 在 run.started 前后分别重启的测试。
6. 网络断开 30 秒、5 分钟后的恢复测试。
7. 多节点、多工作区并发与同工作区排队测试。
8. 附件断点续传、哈希错误、过期清理测试。
9. 320px、390px、820px 和桌面视口的完整流程测试。
10. 数据库从当前 schema 到新 schema 的迁移及回滚备份测试。
11. 至少 160 条混合高度消息的虚拟渲染、首次定位、回到底部及流式跟随测试。

在这些故障注入测试通过前，不把“自动恢复”标记为已完成。
