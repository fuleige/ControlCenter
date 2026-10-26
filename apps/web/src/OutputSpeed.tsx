import { useEffect, useState } from "react";
import type { MessageOutputStats } from "./types";

export function OutputSpeed({ stats, complete }: { stats: MessageOutputStats; complete: boolean }) {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    setStale(false);
    if (complete) return;
    const timer = window.setTimeout(() => setStale(true), 3_000);
    return () => window.clearTimeout(timer);
  }, [stats.estimatedTokens, stats.elapsedMs, complete]);
  const rate = complete ? stats.averageTokensPerSecond : stats.recentTokensPerSecond;
  if (rate === null || !Number.isFinite(rate) || rate < 0) return null;
  return <div
    className="output-speed"
    aria-label="Token 输出速度"
    title={`按可见回复文字估算，使用节点收到文字流的时间；不含首段文字前的等待及其他消息之间的工具、审批耗时。约 ${stats.estimatedTokens.toLocaleString("zh-CN")} Token，输出跨度 ${(stats.elapsedMs / 1_000).toFixed(1)} 秒。此值不代表计费用量或模型服务端的纯生成速度。`}
  >
    <span>{complete ? "平均" : stale ? "输出暂停" : "输出"}</span>
    {(!stale || complete) && <strong>≈ {rate.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} tok/s</strong>}
  </div>;
}
