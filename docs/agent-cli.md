# Agent 客户端命令与配置

本文档对应 Agent `v0.3.26`，适用于 Linux 和 macOS 上直接运行的 Node Agent。v0.3.23 起日常运行必须写明运行时 `codex` 或 `claude`，没有默认值；Claude 运行时见[第 5 节](#5-claude-code-运行时)。Controller Center 与 Agent 独立发布，只有 Agent 运行代码、安装内容或协议兼容性变化时才需要升级 Agent。客户端包含首次注册和日常运行两个独立命令；除共同支持的 `--codex-proxy-only` 外，应按各自的参数表使用。

`AGENT_DATA_DIR` 不是必填项，省略时使用当前用户的 `~/.controller-center-agent`。它保存节点 ID、注册凭证、可靠队列和附件缓存，必须在注册与后续启动之间保持不变。它不决定 Codex 工作空间：Agent 的启动目录才是默认工作空间。正式使用不建议把状态默认放到当前目录，否则从不同项目启动时可能产生不同节点身份；隔离测试时可以显式指定当前目录下的绝对路径，例如先执行 `export AGENT_DATA_DIR="$PWD/test-data"`。

## 获取和安装

登录 Controller Center Web，进入“设置 → 节点接入”，选择目标机器的系统、CPU 架构和 Linux libc，再下载对应安装包；页面不会自动选中第一个包，只展示已构建的目标。当服务端仅有 Linux 包时，会明确提示 macOS 包暂不可下载。安装包已经包含编译结果、生产依赖和 PTY 原生模块，目标机器需要 Node.js 24 或以上版本，不需要再次执行 `npm install` 或编译源码。Node 24 为打包基线，较新主版本只提示兼容状态、不阻止启动，终端和直连原生能力仍在启动时检测。

也可点击“复制下载链接”，在另一台设备直接用 wget 或 curl 下载，无需复制管理员 Cookie 或 Token。链接只允许下载所选安装包，有效期一小时；Control Plane 重启、安装包更新或移除后也会失效，需重新生成。页面提供“复制 wget 命令”；浏览器拒绝剪贴板操作时，可以从只读输入框手动复制链接。macOS 可使用系统 curl，例如：

```bash
curl -fL '粘贴页面复制的下载链接' -o controller-center-agent-v0.3.26-darwin-arm64.tar.gz
```

```bash
cc_agent_archive=controller-center-agent-v0.3.26-linux-x64-glibc.tar.gz
cc_agent_directory=${cc_agent_archive%.tar.gz}
tar -xzf "$cc_agent_archive"
sudo mv "$cc_agent_directory" /opt/controller-center-agent
/opt/controller-center-agent/agent.sh login
/opt/controller-center-agent/agent.sh start codex   # 或 start claude
```

源码仓库执行 `npm run build` 时会自动生成 `artifacts/controller-center-agent-v<版本>-<系统架构>.tar.gz`；只构建客户端包可执行 `npm run package:agent`。常规构建只生成当前构建机目标的包，并在打包后实际启动 PTY 与调整尺寸。正式 macOS 发布需在 macOS 验证；Linux 包也需要匹配 libc。`BUILD-INFO.json` 记录构建目标、Node.js 与 glibc 版本。下载页同时展示 SHA-256，可在节点上用 `sha256sum`（Linux）或 `shasum -a 256`（macOS）核对。

每次新包成功生成后自动清理同一输出目录的其他版本安装包与源码归档，保留当前 Agent 版本和上一个版本（便于回退）的各系统/架构包；构建失败不删除原包。已有包可执行 `npm run clean:agent-packages` 清理，未生成当前版本安装包时会拒绝清理。`AGENT_PACKAGE_OUTPUT_DIR` 可指定独立输出目录，清理不会跨目录。

v0.3.26 增加 Codex 额度重置券（能力标记 `quota_reset_v1`，仅 Codex 运行时上报，协议仍为 v5）：额度查询改为同时读取重置券明细；收到 Control Plane 的重置请求后，以其给定的幂等号和用户所选券 ID 调用 app-server `account/rateLimitResetCredit/consume`，原样回传结果（`reset`、`nothingToReset`、`noCredit`、`alreadyRedeemed`）。旧版 Codex CLI 不支持时提示升级 Codex。2026-10-30 生成，Linux x64/glibc 包 SHA-256 `4ad950d86037aba1217fe3816b50aca6fa79e2ea05e00591f005f77da679b9d2`（已通过打包 PTY 与 WebRTC 检查），macOS ARM64 包 SHA-256 `0ae19a398c8f77b28ddcf0e7d195f145632e857c0f4bf833f8fbb0764a063eb1`，两者均待实机验证；真实兑换尚未实测。

v0.3.25 增加节点额度查询（能力标记 `quota_read_v1`，协议仍为 v5）：Codex 节点经 app-server 读取账号与 `account/rateLimits/read`，Claude 节点在不发送提示词、不保存会话的 Claude Code 进程上读取账号与 `/usage` 数据；Agent 只转发运行时原始结构并去掉探测会话的费用字段，展示逻辑在 Web。旧版 CLI 不支持时提示升级 Codex 或 Claude Code。2026-10-30 生成，Linux x64/glibc 包 SHA-256 `c02d947d59d8c748791ffcbd026d0bdd6fffdc55aa168b07805def4bb48d6cc4`（已通过打包 PTY 与 WebRTC 检查），macOS ARM64 包 SHA-256 `cf5922978c74448a2ae3efb39a7dca8cf771168cd8fa8329178dc06d713f7003`，两者均待实机验证。升级时保留原工作目录及 `AGENT_DATA_DIR`，无需重新注册。

v0.3.23 增加 Claude Code 运行时并要求显式选择运行时；v0.3.24 起同一数据目录可同时运行 Codex 与 Claude（共用一次注册，Claude 本地状态保存在 `runtimes/claude/`），凭据被拒时停止重连并以退出码 78 退出。2026-10-30 用户反馈 Linux x64/glibc 包（SHA-256 `bbad1bea66ee2e131ac2137b488f7b10e4fd2aa0ed52ff229ab1216b04901980`）实测通过，Codex 与 Claude 同机运行及对话正常；macOS ARM64 包（SHA-256 `7c3a3da6b7d9fb886301deb0c707e54b13908d198a93bbb34aed7f443e89bbf1`）尚未实机验证；升级已有 Codex 节点时在启动命令写上 `codex`（如 `./agent.sh start codex`），注册凭证与数据目录无需变动；未升级的 Codex Agent 仍可连接新版 Control Plane。

此前的安装包为 v0.3.22，2026-10-20 生成，增加会话 Fast 档位与可见回复的估算输出速度，协议继续兼容 v5。2026-10-26 用户反馈 Linux 与 macOS 实机测试未发现异常；本轮核对两个在线节点均运行 v0.3.22，目标分别为 Linux x64/glibc 和 macOS ARM64。验收记录绑定当前归档 SHA-256，见[本轮实机反馈](node-tools-design.md#1019-linux-与-macos-实机反馈及提交前检查)。包内构建元数据和 README 保留生成时的待验证记录，不因后续反馈重新打包。v0.3.21 修正 Codex 0.163 的 `priority` Fast 档位识别，并刷新旧版误判缓存；v0.3.22 修正密集分块和暂停恢复时的实时速度采样，只在最近 3 秒内样本充足时显示速率。输入 Token 和首段输出前的时间不参与速度计算。升级时保留原工作目录及 `AGENT_DATA_DIR`，无需重新注册。

以下为旧版验收记录，不代表新版安装包已实机验收：2026-10-08 下载目录提供 v0.3.19 Linux x64/glibc 与 macOS ARM64 包。v0.3.19 放宽 Node 版本检查，允许 Mac 的 Node 26 继续启动。Mac 包复用同版本运行代码与锁定依赖，换入官方 `node-pty@1.1.0`、`node-datachannel@0.33.4` ARM64 预编译模块，并检查 npm 完整性、Mach-O 架构和 helper 执行权限。用户已在 Mac mini 确认当前包可正常使用及直连下载；对应文件 SHA-256 与验证范围见[本轮实机反馈](node-tools-design.md#1015-macos-实机反馈与本轮提交检查)。页面对这一精确产物显示“macOS 直连下载已实机验证”。包内 `nativeVerification: pending-macos-test` 和 README 的待验证说明记录的是构建时状态，后续用户反馈以该记录为准，不为更新说明而重新打包。Intel / Rosetta 的 darwin-x64 包本轮未生成。

macOS 上运行 ARM64 Node.js 时需要 `darwin-arm64` 包，Intel 或 Rosetta 下的 x64 Node.js 需要 `darwin-x64` 包；以 `node -p 'process.platform + "-" + process.arch'` 输出为准。Linux 包不能直接用于 macOS。Agent 在首次注册和启动前检查系统、架构、libc 和 Node 最低版本，不匹配时明确提示并停止；v0.3.19 起不再拒绝高于 Node 24 的主版本。此检查不会读取或修改注册凭证。

如需要在 Mac 构建独立包，在对应源码目录及 Node.js 24.x 环境执行：

```bash
npm ci
npm run package:agent
```

构建完成并通过实际 PTY 与 WebRTC 原生模块检查后，将 `artifacts/controller-center-agent-v0.3.26-darwin-arm64.tar.gz`（或 Intel 对应文件）提供给控制中心。保留原 `AGENT_DATA_DIR` 与启动工作目录，更换安装目录无需重新注册。

将安装包放入下载目录前，在同一台构建机验证实际压缩包：

```bash
node scripts/verify-agent-package.mjs artifacts/controller-center-agent-v0.3.26-darwin-arm64.tar.gz
```

此验证针对 v0.3.16 及后续版本：会解压到独立临时目录，检查版本与目标一致性，实际打开两个终端、验证 TTY 和窗口尺寸、关闭一个终端后确认另一个仍可交互，并确认错误目标会在创建节点状态前停止。验证不会注册测试节点或读取已有节点凭证。源码仓库提供手动触发的 `node-tools-verification.yml`，分别在 Linux x64 与 Mac ARM64 上构建、验证并保存对应目标的产物。旧版 v0.3.15 ARM64 测试包由用户在 Mac 通过网页实际打开终端及操作文件验收，不使用依赖新版启动校验模块的验证脚本。

仅 Web 或 Control Plane 版本升级时，Agent 无需重新打包或重启。发布包含协议变化的新 Agent 时，应先部署并重启 Control Plane，再更新 Agent。若 Agent 显示 `4400 Protocol mismatch`，说明双方协议不兼容；节点注册凭据无需重建。

## 快捷脚本

独立客户端和发布压缩包根目录提供 `agent.sh`，日常操作无需输入 npm 命令：

```bash
./agent.sh login
./agent.sh start codex   # 或 ./agent.sh start claude；简写 ./agent.sh codex / ./agent.sh claude
./agent.sh status
```

`start` 必须带 `codex` 或 `claude`，否则脚本直接提示两种选择并退出。`login` 默认使用 `https://c.llmdev.cn`、交互读取注册 Token，并自动传入 `--codex-proxy-only`；也可以使用 `./agent.sh login https://其他控制中心域名`。快捷启动参数与实际行为如下（表中命令以 Claude 为例，换成 `codex` 同理）：

| 快捷命令 | 自动传入的底层参数 | 行为 |
| --- | --- | --- |
| `./agent.sh start claude` | `--yolo --codex-proxy-only` | 全权限；控制中心直连；Codex / Claude Code 继承系统代理 |
| `./agent.sh start claude --safe` | `--codex-proxy-only` | 保留审批与沙箱；控制中心直连 |
| `./agent.sh start claude --all-proxy` | `--yolo` | 全权限；所有连接遵循代理环境变量和 `NO_PROXY` |
| `./agent.sh start claude --safe --all-proxy` | 无 | 保留审批与沙箱；所有连接遵循代理环境变量和 `NO_PROXY` |

`--all-proxy` 只是取消控制中心强制直连，并不会自行配置代理；没有设置代理环境变量时仍然直连。`--codex-proxy-only` 也不会删除代理变量，它只强制注册、WSS 控制通道和附件请求直连，Codex App Server 或 Claude Code 子进程继续继承代理变量。

脚本根据自身位置查找 `dist`，所以可以在希望作为默认工作空间的目录中，通过绝对路径执行它：

```bash
cd /path/to/workspace
/opt/controller-center-agent/agent.sh start claude
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
| `codex` / `claude` | 无默认值，必填 | 整个 Agent 进程 | 运行时位置参数，只能写一个。`codex` 驱动 `codex app-server`；`claude` 通过 Claude Agent SDK 驱动本机 `claude`。未写、写错或写了两个时，Agent 在创建任何节点状态前退出。 |
| `--yolo` | 不启用 | 整个 Agent 进程中的所有 Codex 会话 | 关闭 Codex 审批与沙箱，使用 `approvalPolicy: never` 和 `dangerFullAccess`；Claude 运行时使用 `bypassPermissions`。Web 会把节点标为“全权限”。 |
| `--codex-proxy-only` | 不启用 | Agent 自身的控制中心网络 | Agent 注册后的 WSS 控制通道和附件下载强制直连；Codex App Server 或 Claude Code 子进程仍继承代理环境变量。未配置代理时传不传都相同。 |

常用组合：

```bash
npm --prefix /path/to/controller-center-agent start -- codex --yolo --codex-proxy-only
```

`--yolo` 所说的“全权限”只针对 Codex / Claude Code 的审批和沙箱层，仍然受 Agent 进程所属操作系统用户、文件权限及 systemd 限制。

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

控制中心拒绝节点凭据时（尚未注册、在 Web 中被“仅撤销”或节点已被删除），Agent 会打印原因、结束正在运行的 Codex / Claude Code 进程并以退出码 `78` 停止，不再重连。重新接入需要在 Web 生成新的注册 Token，执行 `agent.sh login` 后再启动。控制中心默认不接受共享 Token，未注册的 Agent 必须先注册。

注册连接失败时，CLI 会显示本次使用直连还是系统代理、请求地址、完整底层错误链和针对 DNS、拒绝连接、超时、TLS 证书或连接重置的排查建议。诊断信息不会展示注册 Token 或代理认证信息。

## 3. 环境变量

### 3.1 身份与控制中心

| 变量 | 默认值/优先级 | 说明 |
| --- | --- | --- |
| `CONTROL_CENTER_URL` | 显式变量 → 注册记录 → `ws://127.0.0.1:8787/agent/connect` | Agent 控制通道地址；注册命令省略 `--server` 时也读取它。支持 `http(s)` 与 `ws(s)`，Agent 会规范为 WebSocket 地址。 |
| `AGENT_TOKEN` | 注册凭证优先；否则 `dev-agent-token` | 仅兼容尚未注册的旧共享 Token 节点。本机已有独立凭证后，该变量不会覆盖注册凭证。 |
| `AGENT_NAME` | 当前主机名 | Agent 报告的节点原始名称；Web 中的显示名称可单独修改。 |
| `AGENT_ID` | `AGENT_DATA_DIR/identity.json` 中的稳定 ID | 高级覆盖项，主要用于测试或迁移。已注册后不要随意修改，否则会与节点绑定凭证不一致。 |
| `AGENT_DATA_DIR` | `~/.controller-center-agent` | 保存节点 ID、注册连接、可靠队列、附件缓存、按运行时 CLI 版本保存 24 小时的模型目录缓存，以及 Claude 运行时的会话登记 `claude-threads.json`。生产环境建议使用绝对路径。 |

### 3.2 运行时与任务

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEX_BIN` | `codex` | 本机 Codex CLI 可执行文件路径。 |
| `CLAUDE_BIN` | `claude` | 本机 Claude Code CLI 路径；不含 `/` 时按 `PATH` 查找，找不到时 Claude 任务直接失败并提示。 |
| `MAX_CONCURRENT_RUNS` | `5` | 单个节点的最大并发活动任务总数，必须为正整数；超过后排队。 |
| `AGENT_NETWORK_ACCESS` | `false` | 非 `--yolo` 模式下，Codex `workspaceWrite` sandbox 是否允许网络；Claude 运行时不使用该项，联网工具按审批流程处理。 |
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

| 场景 | 注册请求 | WSS 控制通道 | 附件下载 | Codex / Claude Code 子进程 |
| --- | --- | --- | --- | --- |
| 未配置代理变量 | 直连 | 直连 | 直连 | 直连 |
| 配置代理，未传 `--codex-proxy-only` | 按代理/`NO_PROXY` | 按代理/`NO_PROXY` | 按代理/`NO_PROXY` | 继承代理变量 |
| 配置代理，并传 `--codex-proxy-only` | 直连 | 直连 | 直连 | 继承代理变量 |

Agent 不会记录、上报或写入数据库中的代理 URL 和认证信息。systemd 服务通常不会继承交互式 shell 的环境变量，需要在 `EnvironmentFile` 中显式配置代理。

## 4. systemd 示例

仓库示例默认采用全权限并仅让 Codex / Claude Code 子进程使用代理；运行时写在 `ExecStart` 中，模板使用 `<codex|claude>` 占位符，替换为 `codex` 或 `claude` 后才能启动：

```ini
[Service]
WorkingDirectory=/path/to/default-workspace
EnvironmentFile=/etc/controller-center/agent.env
ExecStart=/usr/bin/node /opt/controller-center-agent/dist/index.js claude --yolo --codex-proxy-only
```

- 需要审批（Codex 另有沙箱）：删除 `--yolo`。
- 需要控制中心流量也走系统代理：删除 `--codex-proxy-only`。
- 修改参数后执行 `systemctl daemon-reload` 并重启 Agent 服务。
- 模板设置了 `RestartPreventExitStatus=78`：凭据被拒绝时 Agent 以 78 退出，systemd 不会反复拉起；重新注册后手动启动服务。

完整文件见 `deploy/systemd/controller-center-agent.service`，环境变量模板见 `deploy/agent.env.example`。

## 5. Claude Code 运行时

运行时选择 `claude` 时，Agent 通过官方 Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`，版本锁定）驱动节点本机已安装的 `claude` CLI。安装包不附带 SDK 自带的 Claude Code 二进制，节点需自行安装 Claude Code，并以 Agent 的运行用户完成登录（凭据在该用户的 `~/.claude`，不会发送到控制中心）。协议仍为 v5：Agent 把 Claude Code 的事件转换为现有的会话、进度、审批和用量消息，并在握手中上报 `runtime: "claude"` 和所属机器 `machineId`；Control Plane 保存后在节点 API 返回，Web 显示节点运行时及 CLI 版本，并把相关文案显示为 Claude。

- **会话**：每个 Controller Center 会话对应一个 Claude Code 会话，二者 ID 相同，记录保存在 `~/.claude/projects/` 下，可在本机 `claude --resume` 中看到。Agent 在 `AGENT_DATA_DIR/runtimes/claude/claude-threads.json` 记录会话所属工作空间与最近用量。删除会话会同时删除对应的 Claude Code 会话文件。
- **进程模型**：每轮任务启动一个 Claude Code 进程并恢复该会话，轮次结束后关闭（进程 3 秒内未自行退出则强制结束）。因此 Claude 在该轮中启动的后台命令或后台子任务会随轮次结束停止，不会在轮次之间继续运行。同一会话的下一轮和删除操作会等上一轮进程退出后再执行，避免两个进程同时写入同一会话文件。
- **设置与系统提示**：使用 Claude Code 自带系统提示，并像 CLI 一样加载用户、项目和本地设置（`CLAUDE.md`、权限规则、Hooks、MCP 服务器）。设置中已允许的工具不会再向 Web 请求审批。
- **审批**：默认（`--safe`）使用 `acceptEdits`：工作区内的文件修改自动允许；需要确认的命令、工作区外的修改、联网和其他工具显示为 Web 确认卡片，“本会话允许”只在当前 Agent 进程内对同一会话生效。Claude 的提问工具 `AskUserQuestion` 显示为输入表单。`--yolo` 使用 `bypassPermissions`；以 root 运行时 Claude Code 默认拒绝该模式，Agent 会仅为 Claude 子进程设置 `IS_SANDBOX=1`（运维已显式设置该变量时保留原值），启动日志会提示。
- **追加指令与中止**：追加指令进入 Claude Code 的消息队列，在工具调用之间并入当前轮次。中止会结束当前进程；中止前已排队、尚未处理的追加指令随之丢弃。
- **模型与选项**：模型列表来自本机 Claude Code（如 `default`、`opus`、`sonnet`、`haiku` 等别名与具体版本），思考强度按模型支持的级别提供。Fast 仅在 Claude Code 标记支持的模型上可用，按 Claude Code 的 Fast 模式计费。
- **压缩与用量**：手动压缩发送 Claude Code 的 `/compact`；用量来自 Claude Code 报告的累计模型用量，上下文占用取最近一次模型调用。
- **同机运行 Codex 和 Claude**：同一个 `AGENT_DATA_DIR` 可同时运行 `start codex` 与 `start claude`，共用一次注册的机器身份和凭证，不需要再次 login。节点列表中两者各是一个节点：Codex 节点沿用原有节点 ID（已有节点不变），Claude 节点 ID 由机器 ID 固定推算，会话互不相通。Claude 的本地状态（消息队列、模型缓存、附件、会话登记）保存在 `AGENT_DATA_DIR/runtimes/claude/`，与 Codex 互不干扰。接入按机器管理：在 Web 中“仅撤销”或“删除”任一节点都作用于整台机器的所有运行时。Web 添加的工作空间按机器共享，两个节点都能使用；默认工作空间仍是各自的启动目录。两个节点在同一路径同时运行任务时，Web 会提示并发修改风险。`agent.sh status` 会分别列出正在运行的 Codex 与 Claude 进程。
- **使用条款**：节点使用的是各自机器上用户本人登录的 Claude Code。按照 Anthropic 的说明，不应把一个 Claude 订阅账号的登录提供给其他人使用，也不应代他人中转 Claude 订阅额度；面向他人提供服务时应使用各自的 API Key 或订阅凭据。
## 节点终端与文件工具

Agent v0.3.14 增加真实 PTY 与节点文件能力，旧 Agent 的聊天功能继续兼容协议 v5。Web 的“新开终端”和“节点文件”分别打开独立标签页。Shell 与文件操作使用 Agent 进程的系统用户，文件路径可以越出 Codex 工作空间；Codex 的 `--safe` / `--yolo` 不改变这些工具的权限。

终端每次新开，不恢复历史；关闭、刷新、连接断开或 Agent 退出后回收 PTY。文件单个最大 1 GiB；页面仍打开时允许分片重试，关闭/刷新页面后结束未完成任务。当前文件字节经 Control Plane 暂存中转，最终下载由 Chrome 下载栏管理。上传临时文件的清理登记保存在 `AGENT_DATA_DIR/node-upload-cleanup.json`，不要在传输中手动删除登记文件。

Agent v0.3.17 的本地实现增加 WebRTC 直连上传、下载和开页协商，原生库成功加载后声明 `node_files_direct_v1`；加载失败或旧 Agent 继续使用中转。上传与下载共用通道、任务上限、权限检查和租约；直连上传复用临时文件及原子提交。控制面用 `NODE_FILES_STUN_URLS` 配置 STUN，默认使用 Cloudflare、Twilio、Google 候选且不使用 TURN；已有 HTTP/WSS 代理参数不自动作用于 WebRTC。当前 Linux/macOS 实机反馈见第 10.19 节；原生互通与跨网直连仍以目标设备和实际网络的测试结果为准。传输方式选择、失败后的用户确认与验证门槛统一见 [节点工具设计](node-tools-design.md)。

可选资源参数：`NODE_TERMINAL_LIMIT=8`、`NODE_FILE_CONCURRENCY=2`；建议与控制面的配置保持一致。原生 PTY 加载失败时只停用终端能力，其他 Agent 功能继续运行。

Agent v0.3.15 补充清理登记写入失败后的保护与定时重试：存储异常不会因为后台清理而退出 Agent，存储恢复后自动补写登记。

Agent v0.3.18 修正已发布 v0.3.17 包中的 WebRTC 发送缓冲处理：原生发送返回 `false` 表示数据已进入发送队列，只有异常或通道关闭才算失败。新包经过真实 DataChannel 的 1 MiB 分片及接收确认检查，验证发送已排队时不误关通道；旧包需替换并重启 Agent 才能生效，注册数据目录和凭证继续保留。
