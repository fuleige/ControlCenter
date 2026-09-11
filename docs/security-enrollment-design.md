# 公网认证与节点接入设计

## 部署边界

- 公网只暴露外层 Nginx 的 `443`。Web 静态资源、REST/SSE、`/agent/enroll` 和 `/agent/connect` 均使用同一 HTTPS Origin。
- Control Plane 端口只在可信内网或容器网络中开放。Agent 主动发起 HTTPS/WSS 出站连接，节点无需开放入站端口。
- 外层 Nginx 负责证书、TLS 策略和公网限流；应用仍负责管理员身份、节点身份、一次性凭证和来源校验。

## 管理员认证

首次启动时，Control Plane 生成 256 位随机管理员 Token。原文只写入
`<CONTROL_DATA_DIR>/secrets/admin-token`，文件权限为 `0600`；SQLite 中只保存 SHA-256 哈希。

浏览器把管理员 Token 通过 HTTPS 请求体提交给 `/api/auth/login`。成功后服务端创建随机会话并设置：

- `HttpOnly`
- `Secure`（`PUBLIC_ORIGIN` 为 HTTPS 时）
- `SameSite=Strict`
- `Path=/`

会话空闲 7 天失效、最长 30 天失效。原始管理员 Token 不写入 Web 构建、URL、Local Storage 或 JavaScript 可读 Cookie。状态修改请求同时校验 Origin。登录失败按来源 IP 限流。

管理员可以在服务器本机查询或轮换 Token；轮换会同步撤销全部已登录会话。管理命令打开数据库时不会执行运行态恢复逻辑，因此不会把在线节点误标为离线。

## 节点首次接入

1. 已登录管理员在“设置 → 节点接入”创建注册 Token。
2. 服务端生成 `cce_` 一次性 Token。有效期内，已登录管理员可在节点接入列表查看、复制和确认是否已注册；10 分钟倒计时结束后自动删除。
3. 管理员在目标节点运行注册命令，输入控制中心 HTTPS 地址，并通过不回显的提示粘贴 Token。
4. Agent 在本机生成 `ccn_` 长期凭证和稳定节点 ID，通过 HTTPS 请求体提交长期凭证，通过 Authorization 请求头提交注册 Token。
5. 服务端原子消费注册 Token并保存长期凭证哈希；相同请求可安全重试，不同节点或凭证不能复用该 Token。
6. Agent 将中心地址和长期凭证写入 `AGENT_DATA_DIR/connection.json`，权限为 `0600`。
7. 后续 WSS 握手验证长期凭证，并要求 `agent.hello` 的节点 ID 与凭证绑定的节点 ID 完全一致。

注册 Token、节点长期凭证和附件下载 Token 均不放入 URL，避免出现在代理访问日志、浏览器历史或 Referer 中。

## 撤销与兼容

- 尚未使用的注册 Token 可在 Web 中撤销。
- 已登记节点可在“节点接入”中撤销长期凭证；在线连接会立即断开。曾经拥有独立凭证的节点不能回退到旧共享 Token。
- `AGENT_SHARED_TOKEN` 只用于迁移尚未注册独立凭证的旧节点。迁移完成后应从部署配置中移除兼容入口。
- Agent 本机一旦存在独立凭证，它会优先于旧 systemd 环境中遗留的 `AGENT_TOKEN`，避免注册后意外回退到共享身份。
- 注册 Token 的校验哈希及临时展示密文只保留到 10 分钟有效期结束，随后整条记录自动删除；管理员会话元数据保留 30 天后清理。清理不影响节点长期凭证和会话历史。

## 失败与恢复

- 注册 Token 被使用、撤销或过期后统一拒绝，不向未认证请求泄露具体状态。
- 注册 Token 的可查看原文使用控制中心本机权限为 `0600` 的独立密钥加密保存，只有已登录管理员可通过 API 获取。
- Agent 只有在中心确认注册成功后才持久化长期凭证，失败时可使用新的注册 Token 重试。
- Control Plane 重启后，管理员会话、注册状态和节点凭证均从 SQLite 恢复。
- 浏览器刷新后先查询服务端会话，再启动业务请求和 SSE；认证失效时自动回到登录页。
- 本机 Codex App Server 启动失败不会因 stdin `EPIPE` 带崩 Agent 进程，节点仍可连接中心并暴露诊断状态。

## Nginx 要求

- `/api/`：关闭代理缓冲以支持 SSE，读超时应覆盖长任务。
- `/agent/connect`：透传 WebSocket Upgrade/Connection 头。
- `/agent/enroll`：只允许 HTTPS 公网入口。
- `/agent/attachments/`：透传 Authorization 头并关闭响应缓冲。
- 设置合理的请求体上限、安全响应头，并确保 `WEB_ORIGIN`/`PUBLIC_ORIGIN` 与浏览器实际 HTTPS Origin 完全一致。
