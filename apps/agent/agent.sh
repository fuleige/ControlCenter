#!/usr/bin/env bash

set -Eeuo pipefail

source_path="${BASH_SOURCE[0]}"
while [[ -L "$source_path" ]]; do
  source_dir="$(cd -P "$(dirname "$source_path")" >/dev/null 2>&1 && pwd)"
  source_path="$(readlink "$source_path")"
  [[ "$source_path" != /* ]] && source_path="$source_dir/$source_path"
done
agent_dir="$(cd -P "$(dirname "$source_path")" >/dev/null 2>&1 && pwd)"
default_server="${CONTROL_CENTER_URL:-https://c.llmdev.cn}"
data_dir="${AGENT_DATA_DIR:-${HOME}/.controller-center-agent}"

usage() {
  cat <<'EOF'
Controller Center Agent

用法：
  ./agent.sh login [控制中心地址] [注册参数]
  ./agent.sh start [快捷参数] [Agent 参数]
  ./agent.sh status
  ./agent.sh version
  ./agent.sh help

默认行为：
  login 默认连接 https://c.llmdev.cn，并自动传入 --codex-proxy-only。
  start 自动传入 --yolo --codex-proxy-only。

自动参数对照：
  命令                                 实际 Agent 行为
  ./agent.sh start                     --yolo --codex-proxy-only
  ./agent.sh start --safe              --codex-proxy-only
  ./agent.sh start --all-proxy         --yolo
  ./agent.sh start --safe --all-proxy  不自动传入以上两个参数

快捷参数：
  --safe
      不传入 --yolo，保留 Codex 审批和工作空间沙箱。

  --all-proxy（别名：--via-proxy）
      不传入 --codex-proxy-only。注册、WSS 控制通道和附件请求按照
      HTTP_PROXY、HTTPS_PROXY、ALL_PROXY 与 NO_PROXY 环境变量决定路由。
      此选项不会凭空启用代理；未配置代理环境变量时仍然直连。

底层参数说明：
  --yolo
      Codex 使用 approvalPolicy=never 和 dangerFullAccess；Web 显示“全权限”。

  --codex-proxy-only
      注册、WSS 控制通道和附件请求强制直连；Codex App Server 仍继承
      当前进程的代理环境变量。这不是清空全部代理环境变量。

常见示例：
  # 首次注册：默认域名、控制中心直连，终端中安全输入 Token
  ./agent.sh login

  # 使用其他控制中心注册
  ./agent.sh login https://control.example.com

  # 日常启动：全权限；控制中心直连；Codex 可使用系统代理
  ./agent.sh start

  # 安全模式：启用审批与工作空间沙箱；控制中心仍直连
  ./agent.sh start --safe

  # 全部网络都遵循系统代理/NO_PROXY；Codex 仍为全权限
  ./agent.sh start --all-proxy

  # 安全模式，并让控制中心也遵循系统代理/NO_PROXY
  ./agent.sh start --safe --all-proxy

  # 把指定项目作为默认工作空间
  cd /path/to/project
  /opt/controller-center-agent/agent.sh start

  # 查看是否注册、控制中心地址及进程状态
  ./agent.sh status

高级用法仍可传入底层参数，例如：
  ./agent.sh login https://example.com --token TOKEN

注册 Token 建议交互输入，不要放进命令行历史。
EOF
}

require_runtime() {
  if ! command -v node >/dev/null 2>&1; then
    echo "错误：找不到 node，请先安装 Node.js 24 或更新版本。" >&2
    exit 1
  fi
}

run_login() {
  require_runtime
  local enroll_file="$agent_dir/dist/enroll.js"
  if [[ ! -f "$enroll_file" ]]; then
    echo "错误：缺少 $enroll_file，请先构建客户端。" >&2
    exit 1
  fi

  local -a forwarded=()
  local use_direct=true
  local has_server=false
  local explicit_direct=false
  if (($# > 0)) && [[ "$1" != -* ]]; then
    forwarded+=(--server "$1")
    has_server=true
    shift
  fi
  while (($# > 0)); do
    case "$1" in
      --all-proxy|--via-proxy)
        use_direct=false
        ;;
      --codex-proxy-only)
        explicit_direct=true
        forwarded+=("$1")
        ;;
      --server)
        has_server=true
        forwarded+=("$1")
        shift
        if (($# == 0)); then
          echo "错误：--server 后缺少地址。" >&2
          exit 1
        fi
        forwarded+=("$1")
        ;;
      *)
        forwarded+=("$1")
        ;;
    esac
    shift
  done
  if [[ "$has_server" == false ]]; then
    # macOS still ships Bash 3.2, where expanding an empty array under
    # `set -u` raises "unbound variable" even when the array was initialized.
    if [[ "${forwarded[0]+set}" == set ]]; then
      forwarded=(--server "$default_server" "${forwarded[@]}")
    else
      forwarded=(--server "$default_server")
    fi
  fi
  if [[ "$use_direct" == false && "$explicit_direct" == true ]]; then
    echo "错误：--all-proxy 与 --codex-proxy-only 不能同时使用。" >&2
    exit 1
  fi
  if [[ "$use_direct" == true && "$explicit_direct" == false ]]; then
    forwarded+=(--codex-proxy-only)
  fi
  exec node "$enroll_file" "${forwarded[@]}"
}

run_start() {
  require_runtime
  local agent_file="$agent_dir/dist/index.js"
  if [[ ! -f "$agent_file" ]]; then
    echo "错误：缺少 $agent_file，请先构建客户端。" >&2
    exit 1
  fi

  local safe=false
  local use_direct=true
  local explicit_yolo=false
  local explicit_direct=false
  local -a forwarded=()
  while (($# > 0)); do
    case "$1" in
      --safe)
        safe=true
        ;;
      --all-proxy|--via-proxy)
        use_direct=false
        ;;
      --yolo)
        explicit_yolo=true
        forwarded+=("$1")
        ;;
      --codex-proxy-only)
        explicit_direct=true
        forwarded+=("$1")
        ;;
      *)
        forwarded+=("$1")
        ;;
    esac
    shift
  done

  if [[ "$safe" == true && "$explicit_yolo" == true ]]; then
    echo "错误：--safe 与 --yolo 不能同时使用。" >&2
    exit 1
  fi
  if [[ "$use_direct" == false && "$explicit_direct" == true ]]; then
    echo "错误：--all-proxy 与 --codex-proxy-only 不能同时使用。" >&2
    exit 1
  fi
  if [[ "$safe" == false && "$explicit_yolo" == false ]]; then
    if [[ "${forwarded[0]+set}" == set ]]; then
      forwarded=(--yolo "${forwarded[@]}")
    else
      forwarded=(--yolo)
    fi
  fi
  if [[ "$use_direct" == true && "$explicit_direct" == false ]]; then
    forwarded+=(--codex-proxy-only)
  fi

  if [[ "${forwarded[0]+set}" == set ]]; then
    exec node "$agent_file" "${forwarded[@]}"
  else
    exec node "$agent_file"
  fi
}

show_status() {
  require_runtime
  local connection_file="$data_dir/connection.json"
  if [[ -f "$connection_file" ]]; then
    node -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      console.log(`注册状态：已注册\n控制中心：${value.controlUrl ?? "未知"}`);
    ' "$connection_file"
  else
    echo "注册状态：未注册"
    echo "凭证文件：$connection_file（不存在）"
  fi

  local running=""
  if command -v pgrep >/dev/null 2>&1; then
    running="$(pgrep -f "$agent_dir/dist/index.js" || true)"
  fi
  if [[ -n "$running" ]]; then
    echo "运行状态：运行中（PID ${running//$'\n'/, }）"
  else
    echo "运行状态：未运行"
  fi
}

show_version() {
  require_runtime
  node -e 'console.log(require(process.argv[1]).version)' "$agent_dir/package.json"
}

command_name="${1:-help}"
if (($# > 0)); then shift; fi

case "$command_name" in
  login|enroll)
    run_login "$@"
    ;;
  start)
    run_start "$@"
    ;;
  status)
    show_status
    ;;
  version|--version|-v)
    show_version
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    echo "错误：未知命令 $command_name" >&2
    usage >&2
    exit 1
    ;;
esac
