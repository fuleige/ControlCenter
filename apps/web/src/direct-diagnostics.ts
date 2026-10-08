export type DirectStage = 'environment' | 'signaling' | 'connecting' | 'authorization' | 'transfer';
type Outcome = 'checking' | 'ready' | 'failed' | 'closed';
type Candidates = Record<'host' | 'srflx' | 'prflx' | 'relay', number>;
export interface StunDiagnostic {
  url: string;
  observed: boolean;
  errors: Array<{ code: number; text: string }>;
  status: string;
}
export interface DirectDiagnosticReport {
  outcome: Outcome;
  stage: string;
  summary: string;
  elapsedMs: number;
  connectionState: string;
  iceState: string;
  gatheringState: string;
  channelState: string;
  receivedAnswer: boolean;
  local: Candidates;
  remote: Candidates;
  stun: StunDiagnostic[];
  details: string[];
  events: string[];
}
const stages: Record<DirectStage, string> = { environment: '浏览器环境', signaling: '控制中心与节点协商', connecting: '两端网络连接', authorization: '通道授权与探测', transfer: '文件传输连接' };
const counts = (): Candidates => ({ host: 0, srflx: 0, prflx: 0, relay: 0 });
const bounded = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 400);
const serverKey = (url: string) => url.toLowerCase().replace(/\?transport=udp$/, '');
export function stunErrorHint(error: { code: number; text: string }): string {
  if (/host lookup|dns.*fail|resolv.*fail/i.test(error.text)) return '浏览器报告 STUN 域名解析失败，请检查此地址的 DNS 解析。';
  if (/timed? out|timeout/i.test(error.text)) return 'STUN 请求等待响应超时，请检查 UDP 出站、防火墙及服务可达性。';
  if (/incompatible.*address|address.*incompatible|address family/i.test(error.text)) return 'STUN 地址类型与当前网络不兼容，请检查 IPv4/IPv6 路由。';
  return error.code === 701 ? '浏览器报告此地址探测不可达，请检查 DNS 和 UDP 路径。' : 'STUN 探测返回协议错误，请结合错误码及服务配置检查。';
}

/** Contains observations, never raw SDP, candidate addresses or authorization tokens. */
export class DirectDiagnostics {
  stage: DirectStage = 'environment';
  outcome: Outcome = 'checking';
  reason = '';
  receivedAnswer = false;
  private readonly started = performance.now();
  private finished: number | null = null;
  private readonly local = counts();
  private readonly remote = counts();
  private readonly seen = { local: new Set<string>(), remote: new Set<string>() };
  private readonly servers: Array<Omit<StunDiagnostic, 'status'>>;
  private readonly events: string[] = [];
  private connectionState = '未创建';
  private iceState = '未创建';
  private gatheringState = '未创建';
  private channelState = '未创建';
  constructor(urls: readonly string[]) { this.servers = urls.slice(0, 8).map((url) => ({ url, observed: false, errors: [] })); }
  event(message: string): void {
    const entry = `${Math.round(performance.now() - this.started)} ms · ${bounded(message)}`;
    this.events.push(entry); if (this.events.length > 32) this.events.shift();
  }
  states(pc: RTCPeerConnection, channel: RTCDataChannel | null): void {
    const next = [pc.connectionState, pc.iceConnectionState, pc.iceGatheringState, channel?.readyState || '未创建'];
    if (next.join('/') !== [this.connectionState, this.iceState, this.gatheringState, this.channelState].join('/')) this.event(`连接 ${next[0]}；ICE ${next[1]}；地址探测 ${next[2]}；通道 ${next[3]}`);
    [this.connectionState, this.iceState, this.gatheringState, this.channelState] = next;
  }
  candidate(side: 'local' | 'remote', candidate: string, url?: string | null): void {
    const kind = /\btyp (host|srflx|prflx|relay)\b/.exec(candidate)?.[1] as keyof Candidates | undefined;
    if (!kind) return;
    if (side === 'local' && kind === 'srflx' && url) this.stunObserved(url);
    if (this.seen[side].has(candidate) || this.seen[side].size >= 128) return;
    this.seen[side].add(candidate); this[side][kind]++;
  }
  stunObserved(url: string): void {
    const server = this.servers.find((item) => serverKey(item.url) === serverKey(url));
    if (server && !server.observed) { server.observed = true; this.event(`STUN 已返回公网候选：${server.url}`); }
  }
  stunError(url: string, code: number, text: string): boolean {
    const server = this.servers.find((item) => serverKey(item.url) === serverKey(url));
    if (!server || server.errors.length >= 4) return false;
    const safeText = bounded(text);
    if (server.errors.some((item) => item.code === code && item.text === safeText)) return false;
    server.errors.push({ code, text: safeText }); this.event(`STUN 探测异常：${server.url}；错误 ${code}；${safeText}`); return true;
  }
  finish(outcome: Outcome, reason = ''): void { this.outcome = outcome; this.reason = bounded(reason); this.finished = performance.now(); this.event(outcome === 'ready' ? '直连授权探测成功' : this.reason || '直连通道已关闭'); }
  report(): DirectDiagnosticReport {
    const failed = this.outcome === 'failed';
    const summary = this.outcome === 'ready' ? '直连可用' : this.outcome === 'closed' ? this.reason || '直连通道已关闭，可重新检测'
      : failed ? `${this.stage === 'transfer' ? '直连中断' : '直连检测失败'}（${stages[this.stage]}）：${this.reason}` : '正在检测直连…';
    const details: string[] = [];
    if (!this.servers.length) details.push('未配置 STUN，仅使用主机候选；跨 NAT 网络的可达性受限。');
    if (failed && this.stage === 'connecting') {
      if (!this.receivedAnswer) details.push('尚未收到节点协商响应，请检查 Agent 在线状态及控制连接。');
      else if (!Object.values(this.remote).some(Boolean)) details.push('已收到节点响应，但尚未收到节点候选地址，请检查 Agent 网络及信令转发。');
      if (!Object.values(this.local).some(Boolean)) details.push('浏览器尚未产生本地候选地址，请检查浏览器 WebRTC 策略及网络接口。');
      if (this.servers.length && !this.local.srflx) {
        details.push(this.servers.some((server) => server.errors.length)
          ? '浏览器未取得公网候选，且 STUN 探测有错误；请检查下方地址的错误、DNS、UDP 出站与防火墙。'
          : '尚未观察到浏览器公网候选；STUN 可能仍在等待响应，无法仅凭此次超时确认服务地址不可用。');
      } else if (this.local.srflx && this.remote.srflx) details.push('已观察到两端公网候选，但未建立通道；请检查两端 NAT、UDP 路径及防火墙。');
      else if (this.local.srflx) details.push('浏览器已取得公网候选，但尚未建立两端通道；节点可达性、NAT 或防火墙需要进一步检查。');
      details.push('HTTPS 代理不会自动代理 STUN 和 WebRTC 的 UDP 流量。');
    }
    if (failed && this.stage === 'signaling') details.push('失败发生在协商消息的发送或处理阶段，先检查控制中心响应、登录状态和 Agent 在线状态。');
    if (failed && this.stage === 'authorization') details.push('数据通道已建立，但节点令牌探测或控制中心就绪确认未完成，请检查页面租约和节点状态。');
    if (failed && this.stage === 'transfer') details.push('已建立的通道发生中断；同任务重试有次数上限，改用中转仍需用户确认。');
    const stun: StunDiagnostic[] = this.servers.map((server) => ({ ...server, errors: server.errors.map((error) => ({ ...error })), status:
      server.observed ? `已取得公网候选${server.errors.length ? '；部分探测有错误，仍保留成功结果' : ''}`
        : server.errors.length ? '探测有错误，尚未确认此地址可用'
          : this.outcome === 'checking' && this.gatheringState !== 'complete' ? '探测中'
            : '未单独确认；浏览器可能未暴露来源或合并了相同候选' }));
    return { outcome: this.outcome, stage: stages[this.stage], summary, elapsedMs: Math.round((this.finished ?? performance.now()) - this.started),
      connectionState: this.connectionState, iceState: this.iceState, gatheringState: this.gatheringState, channelState: this.channelState,
      receivedAnswer: this.receivedAnswer, local: { ...this.local }, remote: { ...this.remote }, stun, details, events: [...this.events] };
  }
}
