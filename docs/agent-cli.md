# Agent 客户端命令与配置

本文档对应 Agent `v0.3.16`，适用于 Linux 和 macOS 上直接运行的 Node Agent。Controller Center 与 Agent 独立发布，只有 Agent 运行代码、安装内容或协议兼容性变化时才需要升级 Agent。客户端包含首次注册和日常运行两个独立命令；除共同支持的 `--codex-proxy-only` 外，应按各自的参数表使用。

`AGENT_DATA_DIR` 不是必填项，省略时使用当前用户的 `~/.controller-center-agent`。它保存节点 ID、注册凭证、可靠队列和附件缓存，必须在注册与后续启动之间保持不变。它不决定 Codex 工作空间：Agent 的启动目录才是默认工作空间。正式使用不建议把状态默认放到当前目录，否则从不同项目启动时可能产生不同节点身份；隔离测试时可以显式指定当前目录下的绝对路径，例如先执行 `export AGENT_DATA_DIR="$PWD/test-data"`。

## 获取和安装

登录 Controller Center Web，进入“设置 → 节点接入”，选择目标机器的系统、CPU 架构和 Linux libc，再下载对应安装包；页面不会自动选中第一个包，只展示已构建的目标。当服务端仅有 Linux 包时，会明确提示 macOS 包暂不可下载。安装包已经包含编译结果、生产依赖和 PTY 原生模块，目标机器需要 Node.js 24.x，不需要再次执行 `npm install` 或编译源码。

```bash
cc_agent_archive=controller-center-agent-v0.3.16-linux-x64-glibc.tar.gz
cc_agent_directory=${cc_agent_archive%.tar.gz}
tar -xzf "$cc_agent_archive"
sudo mv "$cc_agent_directory" /opt/controller-center-agent
/opt/controller-center-agent/agent.sh login
/opt/controller-center-agent/agent.sh start
```

源码仓库执行 `npm run build` 时会自动生成 `artifacts/controller-center-agent-v<版本>-<系统架构>.tar.gz`；只构建客户端包可执行 `npm run package:agent`。常规构建只生成当前构建机目标的包，并在打包后实际启动 PTY 与调整尺寸。正式 macOS 发布需在 macOS 验证；Linux 包也需要匹配 libc。`BUILD-INFO.json` 记录构建目标、Node.js 与 glibc 版本。下载页同时展示 SHA-256，可在节点上用 `sha256sum`（Linux）或 `shasum -a 256`（macOS）核对。

根据用户先下载再实机测试的要求，当前下载目录额外提供 `controller-center-agent-v0.3.15-darwin-arm64.tar.gz` 测试包，不提供 Intel 包。它沿用现网 Agent v0.3.15 的 JavaScript 和锁定依赖，替换为官方 `node-pty@1.1.0` macOS ARM64 预编译文件，并删除 Linux 原生构建、修正 helper 执行权限。没有将 v0.3.16 代码标为 v0.3.15；v0.3.16 的启动目标校验不包含在这个旧版本测试包中。测试包的 README 和 BUILD-INFO 标明 Mac 实机验证待完成。此包需要 ARM64 Node.js 24.x，升级已注册节点时保留原工作目录与 `AGENT_DATA_DIR`，无需重新注册。

用户已反馈该 ARM64 包实机测试暂无异常；保留原产物及其 SHA-256，不为修改说明而重新打包。包内待测试标记描述生成时状态，最新验证反馈见节点工具设计文档第 17 节。v0.3.16 的 Mac 原生 CI 仍需执行。

复现当前 ARM64 测试包可执行以下命令，不重新安装依赖或在 Linux 运行 Mac 二进制：

```bash
node scripts/build-agent-macos-preview.mjs artifacts/controller-center-agent-v0.3.15-linux-x64-glibc.tar.gz
```

macOS 上运行 ARM64 Node.js 时需要 `darwin-arm64` 包，Intel 或 Rosetta 下的 x64 Node.js 需要 `darwin-x64` 包；以 `node -p 'process.platform + "-" + process.arch'` 输出为准。Linux 包不能直接用于 macOS。Agent v0.3.16 在首次注册和启动前检查安装包构建目标及 Node.js 主版本，不匹配时明确提示并停止，避免错误注册或启动后才发现终端缺失。此检查不会读取或修改注册凭证。

如需要在 Mac 构建独立包，在对应源码目录及 Node.js 24.x 环境执行：

```bash
npm ci
npm run package:agent
```

构建完成并通过实际 PTY 检查后，将 `artifacts/controller-center-agent-v0.3.16-darwin-arm64.tar.gz`（或 Intel 对应文件）提供给控制中心。保留原 `AGENT_DATA_DIR` 与启动工作目录，更换安装目录无需重新注册。

将安装包放入下载目录前，在同一台构建机验证实际压缩包：

```bash
node scripts/verify-agent-package.mjs artifacts/controller-center-agent-v0.3.16-darwin-arm64.tar.gz
```

此验证针对 v0.3.16 及后续版本：会解压到独立临时目录，检查版本与目标一致性，实际打开两个终端、验证 TTY 和窗口尺寸、关闭一个终端后确认另一个仍可交互，并确认错误目标会在创建节点状态前停止。验证不会注册测试节点或读取已有节点凭证。源码仓库提供手动触发的 `node-tools-verification.yml`，分别在 Linux x64 与 Mac ARM64 上构建、验证并保存对应目标的产物。旧版 v0.3.15 ARM64 测试包由用户在 Mac 通过网页实际打开终端及操作文件验收，不使用依赖新版启动校验模块的验证脚本。

仅 Web 或 Control Plane 版本升级时，Agent 无需重新打包或重启。发布包含协议变化的新 Agent 时，应先部署并重启 Control Plane，再更新 Agent。若 Agent 显示 `4400 Protocol mismatch`，说明双方协议不兼容；节点注册凭据无需重建。

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
| `MAX_CONCURRENT_RUNS` | `5` | 单个节点的最大并发活动任务总数，必须为正整数；超过后排队。 |
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
## 节点终端与文件工具

Agent v0.3.14 增加真实 PTY 与节点文件能力，旧 Agent 的聊天功能继续兼容协议 v5。Web 的“新开终端”和“节点文件”分别打开独立标签页。Shell 与文件操作使用 Agent 进程的系统用户，文件路径可以越出 Codex 工作空间；Codex 的 `--safe` / `--yolo` 不改变这些工具的权限。

终端每次新开，不恢复历史；关闭、刷新、连接断开或 Agent 退出后回收 PTY。文件单个最大 1 GiB；页面仍打开时允许分片重试，关闭/刷新页面后结束未完成任务。最终下载由 Chrome 下载栏管理。上传临时文件的清理登记保存在 `AGENT_DATA_DIR/node-upload-cleanup.json`，不要在传输中手动删除登记文件。

可选资源参数：`NODE_TERMINAL_LIMIT=8`、`NODE_FILE_CONCURRENCY=2`；建议与控制面的配置保持一致。原生 PTY 加载失败时只停用终端能力，其他 Agent 功能继续运行。

Agent v0.3.15 补充清理登记写入失败后的保护与定时重试：存储异常不会因为后台清理而退出 Agent，存储恢复后自动补写登记。
