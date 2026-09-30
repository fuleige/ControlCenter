import { useEffect, useState } from 'react';
import { toolInfo, type ToolInfo } from './node-tools-api';
import { ToolIcon } from './node-tools-ui';
export function NodeToolButtons({ nodeId, online }: { nodeId: string; online: boolean }) {
  const [info, setInfo] = useState<ToolInfo | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setInfo(null); setError('');
    if (online) void toolInfo(nodeId).then((result) => { if (active) setInfo(result); }).catch(() => { if (active) setError('无法读取节点工具状态'); });
    return () => { active = false; };
  }, [nodeId, online]);
  const hint = !online ? '节点离线' : error || (!info ? '正在检查节点能力' : (!info.terminal || !info.files) ? '需升级 Agent 才能使用未启用的节点工具' : '');
  return <div className="node-tool-buttons" role="group" aria-label="节点工具">
    <button type="button" disabled={!online || !info?.terminal} title={hint || '打开独立终端标签页'} onClick={() => window.open(`/nodes/${encodeURIComponent(nodeId)}/terminal`, '_blank', 'noopener')}><ToolIcon name="terminal" /><span>新开终端</span></button>
    <button type="button" disabled={!online || !info?.files} title={hint || '打开独立文件管理标签页'} onClick={() => window.open(`/nodes/${encodeURIComponent(nodeId)}/files`, '_blank', 'noopener')}><ToolIcon name="folder" /><span>节点文件</span></button>
    {hint && <small>{hint}</small>}
  </div>;
}
