import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatErrorMessage, readNodeQuota, resetNodeQuota } from "./api";
import { runtimeLabel } from "./conversation-options";
import { RESET_CREDIT_STATUS, resetDistance, resetOutcomeText, summarizeQuota, type QuotaMeter, type QuotaResetCredit } from "./node-quota";
import { RuntimeIcon } from "./RuntimeIcon";
import type { NodeQuota, NodeRecord } from "./types";

function fullTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function shortTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(value));
}

function ago(value: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(value)) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function creditName(credit: Pick<QuotaResetCredit, "title" | "grantedAt">): string {
  // Untitled credits are told apart by when they were granted.
  return credit.title ?? (credit.grantedAt ? `${shortTime(credit.grantedAt)} 获得的重置券` : "额度重置券");
}

function expiryText(credit: QuotaResetCredit, now: number): string {
  if (!credit.expiresAt) return "永不过期";
  return Date.parse(credit.expiresAt) <= now ? `${shortTime(credit.expiresAt)} 已过期` : `${shortTime(credit.expiresAt)} 到期 · ${resetDistance(credit.expiresAt, now)}`;
}

/** Confirms a credit redemption; the safe choice holds focus so a stray Enter cancels. */
function ResetConfirm({ credit, meters, now, onCancel, onConfirm }: {
  credit: QuotaResetCredit;
  meters: QuotaMeter[];
  now: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="compact-confirm-backdrop node-quota-confirm-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="compact-confirm node-quota-confirm" role="alertdialog" aria-modal="true" aria-labelledby="node-quota-confirm-title" aria-describedby="node-quota-confirm-detail">
        <span className="compact-confirm-icon" aria-hidden="true">!</span>
        <div>
          <h2 id="node-quota-confirm-title">确认使用这张重置券？</h2>
          <div id="node-quota-confirm-detail">
            <p><strong>{creditName(credit)}</strong>{credit.description ? `：${credit.description}` : ""}</p>
            <p>{expiryText(credit, now)}</p>
            {meters.length > 0 && <p>当前用量：{meters.map((meter) => `${meter.label} ${Math.round(meter.percent)}%`).join("，")}</p>}
            <p className="compact-confirm-note">确认后会立即消耗这张券，且不可撤销。</p>
          </div>
          <div className="compact-confirm-actions">
            <button type="button" autoFocus onClick={onCancel}>不使用</button>
            <button type="button" className="danger-button" onClick={onConfirm}>确认使用</button>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * Opening asks the Control Plane once; it reads the node only when its stored
 * result is stale. Refresh waits for the server's cooldown, shown as a countdown.
 */
export function NodeQuotaDialog({ node, onClose }: { node: NodeRecord; onClose: () => void }) {
  const [quota, setQuota] = useState<NodeQuota | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [refreshAt, setRefreshAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [confirming, setConfirming] = useState<QuotaResetCredit | null>(null);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const mounted = useRef(false);
  const opened = useRef(false);

  function apply(next: NodeQuota) {
    const receivedAt = Date.now();
    setQuota(next);
    setNow(receivedAt);
    setRefreshAt(receivedAt + next.refreshWaitMs);
  }

  useEffect(() => {
    mounted.current = true;
    // One open sends one request, even when StrictMode replays this effect.
    if (!opened.current) {
      opened.current = true;
      readNodeQuota(node.id, false)
        .then((next) => { if (mounted.current) apply(next); })
        .catch((reason) => { if (mounted.current) setRequestError(formatErrorMessage(reason, "读取额度")); })
        .finally(() => { if (mounted.current) setLoading(false); });
    }
    return () => { mounted.current = false; };
  }, [node.id]);

  useEffect(() => {
    // Drives the countdown and relative times only; it never contacts the server.
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    // Escape backs out of the confirmation first, then closes the dialog.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (confirming) setConfirming(null);
      else onClose();
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [confirming, onClose]);

  async function refresh() {
    setLoading(true);
    setRequestError(null);
    try {
      apply(await readNodeQuota(node.id, true));
    } catch (reason) {
      setRequestError(formatErrorMessage(reason, "刷新额度"));
    } finally {
      setLoading(false);
    }
  }

  async function redeem(credit: QuotaResetCredit) {
    setConfirming(null);
    setRedeemingId(credit.id);
    setRequestError(null);
    try {
      apply(await resetNodeQuota(node.id, credit.id, creditName(credit)));
    } catch (reason) {
      setRequestError(formatErrorMessage(reason, "重置额度"));
    } finally {
      setRedeemingId(null);
    }
  }

  const summary = quota?.report ? summarizeQuota(quota.report) : null;
  const waitSeconds = Math.max(0, Math.ceil((refreshAt - now) / 1000));
  const busy = loading || redeemingId !== null;
  const refreshBlocked = !quota?.online ? "节点离线时无法刷新"
    : !quota.supported ? "需升级节点 Agent 才能查询额度"
      : waitSeconds > 0 ? `${waitSeconds} 秒后可再次刷新` : "";
  const account = summary && [summary.email, summary.plan, summary.organization].filter(Boolean).join(" · ");
  const resetCredits = summary?.resetCredits ?? null;
  const lastReset = quota?.lastReset ?? null;
  // A retry of an attempt whose result is unknown reuses its key, so that credit stays usable.
  const unresolvedCreditId = lastReset && lastReset.outcome === null && lastReset.error ? lastReset.creditId : null;
  const resetBlocked = !quota?.online ? "节点离线时无法重置"
    : !quota.resetSupported ? "需升级节点 Agent 才能重置额度"
      : quota.resetting ? "该节点正在重置" : "";
  const listedCredit = lastReset ? resetCredits?.credits?.find((credit) => credit.id === lastReset.creditId) : undefined;
  const lastResetName = lastReset?.creditLabel ?? (listedCredit ? creditName(listedCredit) : "额度重置券");
  // A credit missing from a list read after the attempt was most likely spent by it.
  const lastResetLeftList = Boolean(lastReset && !listedCredit && resetCredits?.credits && quota?.succeededAt
    && Date.parse(quota.succeededAt) > Date.parse(lastReset.requestedAt));

  return createPortal(
    <div className="compact-confirm-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="node-quota-dialog" role="dialog" aria-modal="true" aria-labelledby="node-quota-title">
        <header className="node-quota-head">
          <div>
            <h2 id="node-quota-title"><RuntimeIcon runtime={node.runtime} size={14} />{node.name} · {runtimeLabel(node)} 额度</h2>
            <small title={account || undefined}>{account || (loading && !quota ? "正在读取账号…" : "账号信息未知")}</small>
          </div>
          <button type="button" className="node-quota-close" aria-label="关闭额度窗口" onClick={onClose}>×</button>
        </header>

        <div className="node-quota-body" aria-busy={busy}>
          {requestError && <p className="node-quota-alert">{requestError}</p>}
          {quota && !quota.online && <p className="node-quota-notice">节点离线{quota.report ? "，以下为最后一次有效查询的数据" : "，暂无额度数据"}</p>}
          {quota && !quota.supported && !quota.report && <p className="node-quota-notice">该节点的 Agent 版本不支持额度查询，请升级 Agent 后再试</p>}
          {quota?.error && quota.attemptedAt && (
            <p className="node-quota-alert">查询失败（{fullTime(quota.attemptedAt)}）：{quota.error}{quota.report ? "。以下为最后一次有效查询的数据" : ""}</p>
          )}
          {loading && !quota && !requestError && <p className="node-quota-loading">正在读取额度…</p>}
          {summary?.notApplicable && <p className="node-quota-notice">{summary.notApplicable}</p>}
          {summary && summary.meters.length > 0 && (
            <ul className="node-quota-meters">
              {summary.meters.map((meter) => (
                <li key={meter.key} data-severity={meter.severity}>
                  <div className="node-quota-meter-head"><strong>{meter.label}</strong><span>已用 {Math.round(meter.percent)}%</span></div>
                  <div className="node-quota-bar" role="progressbar" aria-label={`${meter.label}已用`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(meter.percent)}>
                    <span style={{ width: `${meter.percent}%` }} />
                  </div>
                  <small>{meter.resetsAt
                    ? <time dateTime={meter.resetsAt} title={fullTime(meter.resetsAt)}>{shortTime(meter.resetsAt)} 重置 · {resetDistance(meter.resetsAt, now)}</time>
                    : "重置时间未知"}</small>
                </li>
              ))}
            </ul>
          )}
          {summary && summary.notes.length > 0 && (
            <ul className="node-quota-notes">
              {summary.notes.map((note) => <li key={note.text} data-warning={note.warning ? "true" : undefined}>{note.text}</li>)}
            </ul>
          )}
          {resetCredits && (
            <section className="node-quota-resets" aria-labelledby="node-quota-resets-title">
              <h3 id="node-quota-resets-title">额度重置券<span>可用 {resetCredits.availableCount} 张</span></h3>
              {lastReset && (
                lastReset.outcome
                  ? <p className="node-quota-reset-status">上次重置（{fullTime(lastReset.finishedAt ?? lastReset.requestedAt)}，{lastResetName}）：{resetOutcomeText(lastReset.outcome)}</p>
                  : lastReset.error
                    ? <p className="node-quota-alert">上次重置（{fullTime(lastReset.requestedAt)}，{lastResetName}）结果未知：{lastReset.error}。{lastResetLeftList
                      ? "这张券已不在可用列表中，可能已兑换成功"
                      : "对同一张券再次使用会沿用原请求，不会重复扣除；也可以先刷新额度确认"}。</p>
                    : <p className="node-quota-reset-status">正在重置（{fullTime(lastReset.requestedAt)} 开始）…</p>
              )}
              {resetCredits.credits === null
                ? <p className="node-quota-reset-status">服务端只返回了张数，没有返回明细，暂时无法选择</p>
                : resetCredits.credits.length === 0
                  ? <p className="node-quota-reset-status">当前没有可用的重置券</p>
                  : (
                    <ul className="node-quota-credits">
                      {resetCredits.credits.map((credit) => {
                        const usable = credit.status === "available" || credit.id === unresolvedCreditId;
                        const blocked = resetBlocked || (usable ? "" : `这张券${RESET_CREDIT_STATUS[credit.status] ?? credit.status}，不能使用`);
                        return (
                          <li key={credit.id}>
                            <div>
                              <strong>{creditName(credit)}{credit.status !== "available" && <em>{RESET_CREDIT_STATUS[credit.status] ?? credit.status}</em>}</strong>
                              {credit.description && <small>{credit.description}</small>}
                              <small>
                                {credit.grantedAt && <>获得于 <time dateTime={credit.grantedAt} title={fullTime(credit.grantedAt)}>{shortTime(credit.grantedAt)}</time> · </>}
                                {credit.expiresAt ? <time dateTime={credit.expiresAt} title={fullTime(credit.expiresAt)}>{expiryText(credit, now)}</time> : expiryText(credit, now)}
                              </small>
                            </div>
                            <button type="button" disabled={busy || Boolean(blocked)} title={blocked || "使用这张券重置额度，确认后才会执行"} onClick={() => setConfirming(credit)}>
                              {redeemingId === credit.id ? "重置中…" : "使用"}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
              {resetCredits.credits && resetCredits.credits.length < resetCredits.availableCount && (
                <small className="node-quota-reset-status">服务端只列出了其中 {resetCredits.credits.length} 张</small>
              )}
            </section>
          )}
        </div>

        <footer className="node-quota-foot">
          <small title="15 分钟内重新打开会直接显示上次成功的结果；手动刷新在成功后 1 分钟、失败后 10 秒内不可用">
            {quota?.succeededAt
              ? <>最后有效数据：<time dateTime={quota.succeededAt}>{fullTime(quota.succeededAt)}</time>（{ago(quota.succeededAt, now)}）</>
              : quota ? "暂无有效数据" : ""}
          </small>
          <button type="button" className="primary-button" disabled={busy || Boolean(refreshBlocked)} title={refreshBlocked || "重新查询节点额度"} onClick={() => void refresh()}>
            {loading && quota ? "查询中…" : waitSeconds > 0 && quota?.online && quota.supported ? `刷新（${waitSeconds}s）` : "刷新"}
          </button>
        </footer>
      </section>
      {confirming && (
        <ResetConfirm
          credit={confirming}
          meters={summary?.meters ?? []}
          now={now}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void redeem(confirming)}
        />
      )}
    </div>,
    document.body,
  );
}
