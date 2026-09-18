# Controller Center 项目约束

## Agent 版本与发布

- Controller Center（Web、Control Plane）与节点 Agent 使用独立版本号，不要求随每个主版本同步升级。
- 未修改 `apps/agent` 的运行代码，且未改变 Agent/Control Plane 协议兼容性时，不升级 `apps/agent/package.json`，不重新生成 Agent 安装包，也不重启已运行的 Agent。
- 只有 Agent 运行代码、安装内容或协议兼容性确有变化，或者用户明确要求时，才执行 `npm run package:agent` 并安排 Agent 升级。
- Web 变更只部署 Web；Control Plane 变更只部署并按需重启 Control Plane，避免把无关组件纳入发布范围。
