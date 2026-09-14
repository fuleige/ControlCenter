#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentDataDirectory, loadOrCreateNodeId, type SavedAgentConnection } from "./config.js";
import {
  CODEX_PROXY_ONLY_ARGUMENT,
  codexProxyOnlyFromArgv,
  formatErrorChain,
  networkErrorHint,
  OutboundNetwork,
  systemProxyForUrl,
} from "./outbound-network.js";

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : null;
}

function enrollmentEndpoint(value: string): { endpoint: string; controlUrl: string } {
  const url = new URL(value);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new Error("服务地址必须使用 https://（本机测试允许 http://）");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (!local && !["https:", "wss:"].includes(url.protocol)) {
    throw new Error("非本机控制中心必须使用 HTTPS");
  }
  url.protocol = ["wss:", "https:"].includes(url.protocol) ? "https:" : "http:";
  url.pathname = "/agent/enroll";
  url.search = "";
  url.hash = "";
  const control = new URL(url);
  control.pathname = "/agent/connect";
  return { endpoint: url.toString(), controlUrl: control.toString() };
}

async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("非交互环境请使用 CONTROLLER_CENTER_ENROLLMENT_TOKEN 环境变量传入注册 Token");
  }
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("已取消注册"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (character === "\u007f") value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

function persistConnection(dataDirectory: string, connection: SavedAgentConnection): void {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  chmodSync(dataDirectory, 0o700);
  const target = path.join(dataDirectory, "connection.json");
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(connection, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, target);
}

async function main(): Promise<void> {
  const codexProxyOnly = codexProxyOnlyFromArgv(process.argv.slice(2));
  const server = option("--server") ?? process.env.CONTROL_CENTER_URL;
  if (!server) throw new Error("缺少控制中心地址，请使用 --server https://control.example.com");
  const registrationToken = option("--token")
    ?? process.env.CONTROLLER_CENTER_ENROLLMENT_TOKEN
    ?? await promptSecret("请输入 10 分钟注册 Token（输入内容不会显示）: ");
  if (!registrationToken) throw new Error("注册 Token 不能为空");
  const dataDirectory = agentDataDirectory();
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  chmodSync(dataDirectory, 0o700);
  const nodeId = loadOrCreateNodeId(dataDirectory);
  const destination = enrollmentEndpoint(server);
  const credential = `ccn_${randomUUID()}.${randomBytes(32).toString("base64url")}`;
  const outboundNetwork = new OutboundNetwork(codexProxyOnly);
  try {
    let response: Awaited<ReturnType<OutboundNetwork["fetch"]>>;
    try {
      response = await outboundNetwork.fetch(destination.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${registrationToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ nodeId, credential }),
      });
    } catch (error) {
      const route = codexProxyOnly
        ? "直连（--codex-proxy-only）"
        : systemProxyForUrl(destination.endpoint, false) ? "系统代理" : "直连（未匹配代理环境变量）";
      const routeHint = codexProxyOnly
        ? "可暂时去掉 --codex-proxy-only，对比系统代理路径。"
        : "请同时核对 HTTPS_PROXY、ALL_PROXY 与 NO_PROXY。";
      throw new Error([
        `无法连接控制中心（${route}）`,
        `地址：${destination.endpoint}`,
        `原因：${formatErrorChain(error)}`,
        `建议：${networkErrorHint(error)}${routeHint}`,
      ].join("\n"), { cause: error });
    }
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(result.error || `注册失败 (${response.status})`);
    persistConnection(dataDirectory, { controlUrl: destination.controlUrl, credential });
    process.stdout.write(`注册成功，节点身份已保存到 ${path.join(dataDirectory, "connection.json")}\n`);
    process.stdout.write(`现在可以启动 Agent${codexProxyOnly ? `，并继续传入 ${CODEX_PROXY_ONLY_ARGUMENT}` : ""}。\n`);
  } finally {
    await outboundNetwork.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
