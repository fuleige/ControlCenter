import { useId } from 'react';
import type { NodeFileTransport } from '@controller-center/protocol';
import { ToolIcon } from './node-tools-ui';

export interface DirectAvailability {
  state: 'available' | 'checking' | 'unavailable';
  reason: string;
}

export function FileTransferAction({ direction, mode, direct, disabled, busy, count = 0, hint, onModeChange, onExecute }: {
  direction: 'upload' | 'download';
  mode: NodeFileTransport;
  direct: DirectAvailability;
  disabled: boolean;
  busy?: boolean;
  count?: number;
  hint: string;
  onModeChange: (mode: NodeFileTransport) => void;
  onExecute: () => void;
}) {
  const id = useId();
  const action = direction === 'upload' ? '上传' : '下载';
  const availability = { available: '可用', checking: '检测中', unavailable: '不可用' }[direct.state];
  return <section className="node-file-action" aria-label={`${action}操作`}>
    <div className="node-file-action-row">
      <button type="button" className="node-tool-button node-tool-button-primary node-file-execute"
        aria-label={direction === 'download' ? `下载所选文件（${count}）` : busy ? '正在检查…' : '上传文件'}
        aria-describedby={`${id}-hint`}
        title={hint}
        disabled={disabled} onClick={onExecute}>
        <ToolIcon name={direction} />{busy ? '检查中' : action}
        {direction === 'download' && count > 0 && <span className="node-file-selection-count">{count}</span>}
      </button>
      <div className="node-file-modes" role="radiogroup" aria-label={`${action}方式`}>
        <label className="node-file-mode" title={direct.reason} data-selected={mode === 'direct'} data-availability={direct.state}>
          <input type="radio" name={id} value="direct" aria-label={`直连${action}`} aria-describedby={`${id}-direct-reason`}
            checked={mode === 'direct'} disabled={direct.state !== 'available'} onChange={() => onModeChange('direct')} />
          <strong>直连</strong><span className="node-file-mode-status" data-state={direct.state}>{availability}</span>
        </label>
        <label className="node-file-mode" title="通过控制中心转发" data-selected={mode === 'relay'}>
          <input type="radio" name={id} value="relay" aria-label={`中转${action}`} aria-describedby={`${id}-relay-reason`}
            checked={mode === 'relay'} onChange={() => onModeChange('relay')} />
          <strong>中转</strong>
          <span hidden id={`${id}-relay-reason`}>通过控制中心转发</span>
        </label>
      </div>
    </div>
    <p className="node-file-action-note" hidden={direct.state !== 'unavailable'} id={`${id}-direct-reason`}>{direct.reason}</p>
    <span hidden id={`${id}-hint`}>{hint}</span>
  </section>;
}
