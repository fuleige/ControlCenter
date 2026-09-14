import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_PROXY_ONLY_ARGUMENT,
  OutboundNetwork,
  codexProxyOnlyFromArgv,
  formatErrorChain,
  hasProxyEnvironment,
  networkErrorHint,
  proxyLookupUrl,
  systemProxyForUrl,
} from "./outbound-network.js";

const originalEnvironment = { ...process.env };
const proxyNames = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
];

afterEach(() => {
  process.env = { ...originalEnvironment };
});

function clearProxyEnvironment(): void {
  for (const name of proxyNames) delete process.env[name];
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务器未分配 TCP 端口");
  return address.port;
}

async function close(server: Server): Promise<void> {
  const closed = once(server, "close");
  server.close();
  await closed;
}

describe("Agent outbound proxy policy", () => {
  it("recognizes only the explicit codex-only argument", () => {
    expect(codexProxyOnlyFromArgv([CODEX_PROXY_ONLY_ARGUMENT])).toBe(true);
    expect(codexProxyOnlyFromArgv(["--yolo"])).toBe(false);
  });

  it("maps WebSocket targets to their corresponding HTTP proxy variables", () => {
    clearProxyEnvironment();
    process.env.HTTP_PROXY = "http://http-proxy.example:8080";
    process.env.HTTPS_PROXY = "http://https-proxy.example:8443";

    expect(proxyLookupUrl("wss://control.example/agent/connect")).toBe("https://control.example/agent/connect");
    expect(systemProxyForUrl("wss://control.example/agent/connect", false)).toBe("http://https-proxy.example:8443");
    expect(systemProxyForUrl("ws://control.example/agent/connect", false)).toBe("http://http-proxy.example:8080");
    expect(systemProxyForUrl("wss://control.example/agent/connect", true)).toBeNull();
  });

  it("honors NO_PROXY and detects upper- or lower-case proxy variables", () => {
    clearProxyEnvironment();
    process.env.https_proxy = "http://proxy.example:8443";
    process.env.NO_PROXY = "control.example";

    expect(hasProxyEnvironment()).toBe(true);
    expect(systemProxyForUrl("https://control.example/agent/enroll", false)).toBeNull();
    expect(systemProxyForUrl("https://other.example/agent/enroll", false)).toBe("http://proxy.example:8443");
  });

  it("preserves nested network causes and provides an actionable hint", () => {
    const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read" });
    const error = new TypeError("fetch failed", { cause });
    expect(formatErrorChain(error)).toBe("fetch failed → read ECONNRESET (code=ECONNRESET, syscall=read)");
    expect(networkErrorHint(error)).toContain("Nginx TLS");
  });

  it("routes Agent fetches through the proxy by default and directly in codex-only mode", async () => {
    clearProxyEnvironment();
    const target = createServer((_request, response) => response.end("control-center"));
    let proxyRequestCount = 0;
    const proxy = createServer((_request, response) => {
      proxyRequestCount += 1;
      response.end("proxy-response");
    });

    const targetPort = await listen(target);
    const proxyPort = await listen(proxy);
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    const targetUrl = `http://127.0.0.1:${targetPort}/agent/enroll`;
    const defaultNetwork = new OutboundNetwork(false);
    const codexOnlyNetwork = new OutboundNetwork(true);

    try {
      expect(await (await defaultNetwork.fetch(targetUrl)).text()).toBe("proxy-response");
      expect(proxyRequestCount).toBe(1);
      expect(await (await codexOnlyNetwork.fetch(targetUrl)).text()).toBe("control-center");
      expect(proxyRequestCount).toBe(1);
    } finally {
      await Promise.all([defaultNetwork.destroy(), codexOnlyNetwork.destroy()]);
      await Promise.all([close(proxy), close(target)]);
    }
  });
});
