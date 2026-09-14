import { Agent as DirectAgent, ProxyAgent, fetch as undiciFetch, type Dispatcher, type RequestInit, type Response } from "undici";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";

export const CODEX_PROXY_ONLY_ARGUMENT = "--codex-proxy-only";

export function codexProxyOnlyFromArgv(argv: string[]): boolean {
  return argv.includes(CODEX_PROXY_ONLY_ARGUMENT);
}

export function hasProxyEnvironment(environment: NodeJS.ProcessEnv = process.env): boolean {
  return ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]
    .some((name) => Boolean(environment[name]?.trim()));
}

export function proxyLookupUrl(target: string | URL): string {
  const url = new URL(target);
  if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol === "ws:") url.protocol = "http:";
  return url.toString();
}

export function systemProxyForUrl(target: string | URL, codexProxyOnly: boolean): string | null {
  if (codexProxyOnly) return null;
  return getProxyForUrl(proxyLookupUrl(target)) || null;
}

function errorMetadata(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return ["code", "syscall", "hostname", "address", "port"]
    .flatMap((key) => typeof record[key] === "string" || typeof record[key] === "number" ? [`${key}=${String(record[key])}`] : []);
}

export function formatErrorChain(error: unknown): string {
  const descriptions: string[] = [];
  const visited = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (value == null || visited.has(value) || descriptions.length >= 6) return;
    visited.add(value);
    const message = value instanceof Error ? value.message : String(value);
    const metadata = errorMetadata(value);
    descriptions.push(`${message || "未知错误"}${metadata.length > 0 ? ` (${metadata.join(", ")})` : ""}`);
    if (value && typeof value === "object" && "cause" in value) visit((value as { cause?: unknown }).cause);
    if (value instanceof AggregateError) for (const nested of value.errors) visit(nested);
  };
  visit(error);
  return descriptions.join(" → ") || "未知错误";
}

export function networkErrorHint(error: unknown): string {
  const details = formatErrorChain(error);
  if (/ECONNRESET|socket hang up/i.test(details)) {
    return "连接被对端重置；HTTPS 场景请检查域名 443 端口、Nginx TLS server 配置、SNI/证书链和防火墙。";
  }
  if (/ECONNREFUSED/i.test(details)) return "目标端口拒绝连接；请检查域名端口、Nginx 和控制中心服务是否正在监听。";
  if (/ENOTFOUND|EAI_AGAIN/i.test(details)) return "域名解析失败；请检查 DNS、域名记录和当前网络。";
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(details)) return "连接超时；请检查路由、防火墙、安全组以及代理可用性。";
  if (/CERT_|certificate|self[- ]signed|unable to verify|TLS/i.test(details)) return "TLS 证书校验失败；请检查证书有效期、域名匹配和完整证书链。";
  return "请检查控制中心地址、HTTPS 反向代理、系统代理变量和网络连通性。";
}

/**
 * Applies one process-wide policy to every outbound Agent connection without
 * changing process.env. The Codex child therefore always inherits the user's
 * proxy variables, while codexProxyOnly can force the Agent itself direct.
 */
export class OutboundNetwork {
  private readonly direct = new DirectAgent();
  private readonly fetchProxyAgents = new Map<string, ProxyAgent>();
  private readonly webSocketProxyAgents = new Map<string, HttpsProxyAgent<string>>();

  constructor(private readonly codexProxyOnly: boolean) {}

  fetch(target: string | URL, init?: RequestInit): Promise<Response> {
    const proxyUrl = systemProxyForUrl(target, this.codexProxyOnly);
    let dispatcher: Dispatcher = this.direct;
    if (proxyUrl) {
      let proxy = this.fetchProxyAgents.get(proxyUrl);
      if (!proxy) {
        proxy = new ProxyAgent(proxyUrl);
        this.fetchProxyAgents.set(proxyUrl, proxy);
      }
      dispatcher = proxy;
    }
    return undiciFetch(target, { ...init, dispatcher });
  }

  webSocketAgent(target: string | URL): HttpsProxyAgent<string> | undefined {
    const proxyUrl = systemProxyForUrl(target, this.codexProxyOnly);
    if (!proxyUrl) return undefined;
    let agent = this.webSocketProxyAgents.get(proxyUrl);
    if (!agent) {
      agent = new HttpsProxyAgent(proxyUrl, { keepAlive: true });
      this.webSocketProxyAgents.set(proxyUrl, agent);
    }
    return agent;
  }

  async destroy(): Promise<void> {
    for (const agent of this.webSocketProxyAgents.values()) agent.destroy();
    await Promise.all([
      this.direct.destroy(),
      ...[...this.fetchProxyAgents.values()].map((agent) => agent.destroy()),
    ]);
    this.fetchProxyAgents.clear();
    this.webSocketProxyAgents.clear();
  }
}
