import { ToolIcon } from './node-tools-ui';
import { stunErrorHint, type DirectDiagnosticReport } from './direct-diagnostics';

export function DirectDiagnosticsPanel({ status, ready, report, onProbe, probeDisabled }: {
  status: string; ready: boolean; report: DirectDiagnosticReport | null; onProbe: () => void; probeDisabled: boolean;
}) {
  return <section className="node-file-connection-panel" aria-label="直连连接信息" data-state={ready ? 'ready' : report?.outcome || 'checking'}>
    <header><strong><ToolIcon name={ready ? 'check' : 'info'} />连接方式</strong>
      <button type="button" className="node-tool-text-button" aria-label="重新检测直连" disabled={probeDisabled} onClick={onProbe}><ToolIcon name="refresh" />重新检测</button>
    </header>
    <p className="node-file-connection-status" role="status" title={status}>{status}</p>
    {report && <details key={report.outcome} className="node-files-diagnostics" open={report.outcome === 'failed'}>
      <summary>直连诊断详情{report.outcome === 'failed' && <span>检测失败</span>}</summary>
      <div className="node-files-diagnostic-body">
        <div className="node-diagnostic-stage"><span>检测阶段</span><strong>{report.stage}</strong><span>{(report.elapsedMs / 1000).toFixed(1)} 秒</span></div>
        {report.details.slice(0, 1).map(detail => <p key={detail}>{detail}</p>)}
        {!!report.stun.length && <div className="node-stun-servers">{report.stun.map(server => <section className="node-stun-server" key={server.url} data-state={server.observed ? 'ready' : server.errors.length ? 'error' : 'unknown'}>
          <header><strong>{server.url.includes('cloudflare') ? 'Cloudflare' : server.url.includes('twilio') ? 'Twilio' : server.url.includes('google') ? 'Google' : 'STUN 服务'}</strong><span>{server.observed ? '已取得公网候选' : server.errors.length ? '探测异常' : '未单独确认'}</span></header>
          <code className="node-stun-address">{server.url}</code>
          <p>{server.status}</p>
          {server.errors.map((error, index) => <div className="node-stun-error" key={index}><strong>错误 {error.code}</strong><p>{stunErrorHint(error)}{server.observed ? '已取得公网候选，保留成功结果。' : ''}</p><code>{error.text || '浏览器未提供错误详情'}</code></div>)}
        </section>)}</div>}
        <details className="node-diagnostic-protocol"><summary>连接状态与检测过程</summary>
          {report.details.slice(1).map(detail => <p key={detail}>{detail}</p>)}
          <dl><dt>连接</dt><dd>{report.connectionState}</dd><dt>ICE</dt><dd>{report.iceState}</dd><dt>地址探测</dt><dd>{report.gatheringState}</dd><dt>数据通道</dt><dd>{report.channelState}</dd></dl>
          <p>浏览器候选：主机 {report.local.host}，公网 {report.local.srflx}；节点候选：主机 {report.remote.host}，公网 {report.remote.srflx}。</p>
          <p>STUN 状态来自当前浏览器；节点公网候选来自协商信息，无法据此逐项确认节点访问了哪个 STUN 地址。</p>
          <ol>{report.events.map((event, index) => <li key={index}>{event}</li>)}</ol>
        </details>
      </div>
    </details>}
  </section>;
}
