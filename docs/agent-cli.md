# Agent 客户端命令与配置

本文档对应 Controller Center `v0.3.7`，适用于 Linux 和 macOS 上直接运行的 Node Agent。客户端包含首次注册和日常运行两个独立命令；除共同支持的 `--codex-proxy-only` 外，应按各自的参数表使用。

`AGENT_DATA_DIR` 不是必填项，省略时使用当前用户的 `~/.controller-center-agent`。它保存节点 ID、注册凭证、可靠队列和附件缓存，必须在注册与后续启动之间保持不变。它不决定 Codex 工作空间：Agent 的启动目录才是默认工作空间。正式使用不建议把状态默认放到当前目录，否则从不同项目启动时可能产生不同节点身份；隔离测试时可以显式指定当前目录下的绝对路径，例如先执行 `export AGENT_DATA_DIR="$PWD/test-data"`。

## 获取和安装

登录 Controller Center Web，进入“设置 → 节点接入”，可下载与控制中心同版本的 Linux/macOS 客户端。安装包已经包含编译结果和生产依赖，目标机器只需安装满足版本要求的 Node.js，不需要再次执行 `npm install` 或编译源码。

```bash
cc_agent_archive=controller-center-agent-v0.3.7.tar.gz
cc_agent_directory=${cc_agent_archive%.tar.gz}
tar -xzf "$cc_agent_archive"
sudo mv "$cc_agent_directory" /opt/controller-center-agent
/opt/controller-center-agent/agent.sh login
/opt/controller-center-agent/agent.sh start
```

源码仓库执行 `npm run build` 时会自动生成 `artifacts/controller-center-agent-v<版本>.tar.gz`；只构建客户端包可执行 `npm run package:agent`。下载页同时展示 SHA-256，可在节点上用 `sha256sum`（Linux）或 `shasum -a 256`（macOS）核对。

版本升级应先部署并重启 Control Plane，再更新和启动同版本 Agent。若 Agent 显示 `4400 Protocol mismatch`，说明服务端仍运行旧协议进程；重启已更新的 Control Plane 即可，节点注册凭据无需重建。

## 快捷脚本

独立客户端和发布压缩包根目录提供 `agent.sh`，日常操作无需输入 npm 命令：

```bash
./agent.sh login
./agent.sh start
./agent.sh status
```

`login` 默认使用 `https://c.llmdev.cn`、交互读取注册 Token，并自动传入 `--codex-proxy-only`；也可以使用 `./agent.sh login https://其他控制中心域名`。快捷启动参数与实际行为如下：

| 快捷命令 | 自动传入的底层参数 | 行为 |
| --- | --- | --- |
| `./agent.sh start` | `--yolo --codex-proxy-only` | 全权限；控制中心直连；Codex 继承系统代理 |
| `./agent.sh start --safe` | `--codex-proxy-only` | 保留审批与沙箱；控制中心直连 |
| `./agent.sh start --all-proxy` | `--yolo` | 全权限；所有连接遵循代理环境变量和 `NO_PROXY` |
| `./agent.sh start --safe --all-proxy` | 无 | 保留审批与沙箱；所有连接遵循代理环境变量和 `NO_PROXY` |

`--all-proxy` 只是取消控制中心强制直连，并不会自行配置代理；没有设置代理环境变量时仍然直连。`--codex-proxy-only` 也不会删除代理变量，它只强制注册、WSS 控制通道和附件请求直连，Codex App Server 继续继承代理变量。

脚本根据自身位置查找 `dist`，所以可以在希望作为默认工作空间的目录中，通过绝对路径执行它：

```bash
cd /path/to/workspace
/opt/controller-center-agent/agent.sh start
```

下面的 npm/Node 命令保留作为源码开发、排障和 systemd 配置参考。

## 1. 日常运行 Agent

开发环境：

```bash
npm run dev:agent -- [参数]
```

构建后的生产环境：

```bash
npm --prefix /path/to/controller-center-agent start -- [参数]
```

支持的命令行参数：

| 参数 | 默认行为 | 作用范围 | 说明 |
| --- | --- | --- | --- |
| `--yolo` | 不启用 | 整个 Agent 进程中的所有 Codex 会话 | 关闭 Codex 审批与沙箱，使用 `approvalPolicy: never` 和 `dangerFullAccess`。Web 会把节点标为“全权限”。 |
| `--codex-proxy-only` | 不启用 | Agent 自身的控制中心网络 | Agent 注册后的 WSS 控制通道和附件下载强制直连；Codex App Server 仍继承代理环境变量。未配置代理时传不传都相同。 |

常用组合：

```bash
npm --prefix /path/to/controller-center-agent start -- --yolo --codex-proxy-only
```

`--yolo` 所说的“全权限”只针对 Codex 的审批和沙箱层，仍然受 Agent 进程所属操作系统用户、文件权限及 systemd 限制。

## 2. 首次注册

开发或源码部署：

```bash
npm run agent:enroll -- --server https://control.example.com [参数]
```

构建后的直接调用：

```bash
npm --prefix /path/to/controller-center-agent run enroll -- --server https://control.example.com [参数]
```

支持的命令行参数：

| 参数 | 是否必需 | 说明 |
| --- | --- | --- |
| `--server <URL>` | 通常必需 | 控制中心地址。公网必须使用 `https://` 或 `wss://`；本机测试允许 `http://` 或 `ws://`。若省略则读取 `CONTROL_CENTER_URL`。路径会规范为 `/agent/enroll`。 |
| `--token <TOKEN>` | 否 | 10 分钟有效的一次性注册 Token。省略后优先读取 `CONTROLLER_CENTER_ENROLLMENT_TOKEN`，仍未提供时通过不回显的终端交互读取。直接传参可能进入 shell 历史和进程列表，不推荐日常使用。 |
| `--codex-proxy-only` | 否 | 本次注册请求强制直连。注册命令和日常 Agent 是独立进程；如果二者都要绕过代理，两个命令都必须传入此参数。 |

推荐注册方式：

```bash
AGENT_DATA_DIR=/var/lib/controller-center-agent \
npm run agent:enroll -- \
  --server https://control.example.com \
  --codex-proxy-only
```

注册成功后，中心地址和节点独立凭证会保存到 `AGENT_DATA_DIR/connection.json`，文件权限为 `0600`。日常启动不再需要域名或注册 Token。

注册连接失败时，CLI 会显示本次使用直连还是系统代理、请求地址、完整底层错误链和针对 DNS、拒绝连接、超时、TLS 证书或连接重置的排查建议。诊断信息不会展示注册 Token 或代理认证信息。

## 3. 环境变量

### 3.1 身份与控制中心

| 变量 | 默认值/优先级 | 说明 |
| --- | --- | --- |
| `CONTROL_CENTER_URL` | 显式变量 → 注册记录 → `ws://127.0.0.1:8787/agent/connect` | Agent 控制通道地址；注册命令省略 `--server` 时也读取它。支持 `http(s)` 与 `ws(s)`，Agent 会规范为 WebSocket 地址。 |
| `AGENT_TOKEN` | 注册凭证优先；否则 `dev-agent-token` | 仅兼容尚未注册的旧共享 Token 节点。本机已有独立凭证后，该变量不会覆盖注册凭证。 |
| `AGENT_NAME` | 当前主机名 | Agent 报告的节点原始名称；Web 中的显示名称可单独修改。 |
| `AGENT_ID` | `AGENT_DATA_DIR/identity.json` 中的稳定 ID | 高级覆盖项，主要用于测试或迁移。已注册后不要随意修改，否则会与节点绑定凭证不一致。 |
| `AGENT_DATA_DIR` | `~/.controller-center-agent` | 保存节点 ID、注册连接、可靠队列、附件缓存和按 Codex 版本保存 24 小时的模型目录缓存。生产环境建议使用绝对路径。 |

### 3.2 Codex 与任务

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEX_BIN` | `codex` | 本机 Codex CLI 可执行文件路径。 |
| `MAX_CONCURRENT_RUNS` | `2` | 节点最大并发活动任务数，必须为正整数。 |
| `AGENT_NETWORK_ACCESS` | `false` | 非 `--yolo` 模式下，Codex `workspaceWrite` sandbox 是否允许网络。 |
| `AGENT_WORKSPACES` | 空数组 | 附加工作空间 JSON 数组，格式为 `[{"id":"project-a","name":"Project A","path":"/srv/project-a"}]`。不能覆盖启动目录决定的默认工作空间。 |

Agent 的默认工作空间由进程启动目录决定。通过 npm workspace 脚本启动时，npm 提供的原始调用目录会被保留；systemd 部署则由 `WorkingDirectory` 决定。

### 3.3 注册自动化

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CONTROLLER_CENTER_ENROLLMENT_TOKEN` | 空 | 非交互注册时提供一次性注册 Token。只建议作为进程临时环境变量使用，不要写入长期环境文件。 |

注册 Token 的取值优先级是：`--token` → `CONTROLLER_CENTER_ENROLLMENT_TOKEN` → 终端安全输入。

### 3.4 系统代理

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HTTP_PROXY` / `http_proxy` | 空 | HTTP 与 WS 请求使用的代理。 |
| `HTTPS_PROXY` / `https_proxy` | 空 | HTTPS 与 WSS 请求使用的代理。 |
| `ALL_PROXY` / `all_proxy` | 空 | 没有协议专用代理时的后备代理；当前支持 HTTP(S) 代理地址。 |
| `NO_PROXY` / `no_proxy` | 空 | 默认模式下需要直连的主机或域名。 |

代理模式矩阵：

| 场景 | 注册请求 | WSS 控制通道 | 附件下载 | Codex App Server |
| --- | --- | --- | --- | --- |
| 未配置代理变量 | 直连 | 直连 | 直连 | 直连 |
| 配置代理，未传 `--codex-proxy-only` | 按代理/`NO_PROXY` | 按代理/`NO_PROXY` | 按代理/`NO_PROXY` | 继承代理变量 |
| 配置代理，并传 `--codex-proxy-only` | 直连 | 直连 | 直连 | 继承代理变量 |

Agent 不会记录、上报或写入数据库中的代理 URL 和认证信息。systemd 服务通常不会继承交互式 shell 的环境变量，需要在 `EnvironmentFile` 中显式配置代理。

## 4. systemd 示例

仓库示例默认采用全权限并仅让 Codex 使用代理：

```ini
[Service]
WorkingDirectory=/path/to/default-workspace
EnvironmentFile=/etc/controller-center/agent.env
ExecStart=/usr/bin/node /opt/controller-center-agent/dist/index.js --yolo --codex-proxy-only
```

- 需要 Codex 审批与沙箱：删除 `--yolo`。
- 需要控制中心流量也走系统代理：删除 `--codex-proxy-only`。
- 修改参数后执行 `systemctl daemon-reload` 并重启 Agent 服务。

完整文件见 `deploy/systemd/controller-center-agent.service`，环境变量模板见 `deploy/agent.env.example`。
