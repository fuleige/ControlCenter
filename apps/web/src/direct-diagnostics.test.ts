import { describe, expect, it } from 'vitest';
import { DirectDiagnostics, stunErrorHint } from './direct-diagnostics';
const cloudflare = 'stun:stun.cloudflare.com:3478';
const google = 'stun:stun.l.google.com:19302';
const candidate = (type: string, foundation = '1') => `candidate:${foundation} 1 udp 123 192.0.2.1 34567 typ ${type}`;

describe('direct connection diagnosis', () => {
  it('keeps a successful STUN result when another network path reports 701', () => {
    const diagnostics = new DirectDiagnostics([cloudflare, google]); diagnostics.stage = 'connecting';
    diagnostics.stunError(`${cloudflare}?transport=udp`, 701, 'STUN host lookup received error.');
    diagnostics.candidate('local', candidate('srflx'), cloudflare);
    diagnostics.stunError(google, 701, 'STUN binding request timed out.');
    diagnostics.finish('ready');
    const report = diagnostics.report();
    expect(report.outcome).toBe('ready'); expect(report.summary).toBe('直连可用');
    expect(report.stun[0]).toMatchObject({ observed: true, errors: [{ code: 701 }] });
    expect(report.stun[0]!.status).toContain('仍保留成功结果');
    expect(stunErrorHint(report.stun[0]!.errors[0]!)).toContain('域名解析失败');
    expect(report.stun[1]).toMatchObject({ observed: false });
    expect(report.stun[1]!.status).toContain('尚未确认');
    expect(stunErrorHint(report.stun[1]!.errors[0]!)).toContain('等待响应超时');
  });
  it('reports signaling errors without blaming STUN', () => {
    const diagnostics = new DirectDiagnostics([cloudflare]); diagnostics.stage = 'signaling';
    diagnostics.finish('failed', '节点当前离线（HTTP 409）'); const report = diagnostics.report();
    expect(report.summary).toContain('控制中心与节点协商'); expect(report.summary).toContain('HTTP 409');
    expect(report.details.join()).toContain('协商消息'); expect(report.details.join()).not.toContain('STUN 探测有错误');
    expect(report.stun[0]!.status).not.toContain('不可用');
  });
  it('distinguishes missing node answer from observed STUN errors', () => {
    const diagnostics = new DirectDiagnostics([cloudflare]); diagnostics.stage = 'connecting';
    diagnostics.candidate('local', candidate('host')); diagnostics.stunError(cloudflare, 701, 'STUN binding request timed out.');
    diagnostics.finish('failed', '两端建连超时'); const report = diagnostics.report();
    expect(report.details.join()).toContain('尚未收到节点协商响应'); expect(report.details.join()).toContain('STUN 探测有错误');
    expect(report.details.join()).toContain('HTTPS 代理'); expect(report.stun[0]!.errors[0]!.text).toContain('timed out');
  });
  it('does not infer endpoint failure from an unanswered connection timeout', () => {
    const diagnostics = new DirectDiagnostics([cloudflare]); diagnostics.stage = 'connecting'; diagnostics.receivedAnswer = true;
    diagnostics.candidate('local', candidate('host')); diagnostics.candidate('remote', candidate('host'));
    diagnostics.finish('failed', '两端建连超时'); const report = diagnostics.report();
    expect(report.details.join()).toContain('无法仅凭此次超时确认服务地址不可用'); expect(report.stun[0]!.status).toContain('未单独确认');
  });
  it('distinguishes NAT connectivity failure after both sides have public candidates', () => {
    const diagnostics = new DirectDiagnostics([cloudflare]); diagnostics.stage = 'connecting'; diagnostics.receivedAnswer = true;
    diagnostics.candidate('local', candidate('srflx'), cloudflare); diagnostics.candidate('remote', candidate('srflx'));
    diagnostics.finish('failed', 'WebRTC 网络连接失败');
    expect(diagnostics.report().details.join()).toContain('已观察到两端公网候选');
    expect(diagnostics.report().details.join()).not.toContain('STUN 探测有错误');
  });
  it('bounds observations and omits candidate addresses from exported diagnostics', () => {
    const diagnostics = new DirectDiagnostics([cloudflare]);
    for (let i = 0; i < 200; i++) { diagnostics.candidate('local', candidate('host', String(i))); diagnostics.event(`event ${i}`); }
    for (let i = 0; i < 20; i++) diagnostics.stunError(cloudflare, 701, `error ${i}`);
    const report = diagnostics.report(); expect(report.local.host).toBe(128); expect(report.events.length).toBe(32); expect(report.stun[0]!.errors.length).toBe(4);
    expect(JSON.stringify(report)).not.toContain('192.0.2.1');
    report.stun[0]!.errors[0]!.text = 'changed'; report.local.host = 0;
    expect(diagnostics.report().stun[0]!.errors[0]!.text).toBe('error 0'); expect(diagnostics.report().local.host).toBe(128);
  });
});
