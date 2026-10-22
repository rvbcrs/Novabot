import { useEffect, useRef, useState } from 'react';
import { Anchor, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { reanchorAction, fetchReanchorStatus, type ReanchorStatus } from '../../api/client';
import { ManualControlPanel } from './ManualControlPanel';
import { afterPulse, pulseOutcome, REANCHOR_PULSE_MS } from '../../utils/reanchorPulse';

interface Props { sn: string; online: boolean; sensors?: Record<string, string>; onClose: () => void; }

/** The server owns progress; this visible wizard owns only the operator heartbeat. */
export function ReanchorWizard({ sn, online, sensors, onClose }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ReanchorStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [starting, setStarting] = useState(false);
  const owned = useRef<string | null>(null);
  const misses = useRef(0);
  const generation = useRef(0);
  useEffect(() => {
    const session = ++generation.current;
    setStatus(null); setErr(null); setConfirmed(false); setStarting(false);
    let cancelled = false, polling = false;
    const tick = async () => {
      if (polling) return;
      polling = true;
      const id = owned.current;
      try {
        if (id) {
          // Only the server's refusal, or a window that has certainly expired, ends supervision.
          const outcome = await pulseOutcome(() => reanchorAction(sn, 'pulse', { cycleId: id }));
          if (!cancelled && owned.current === id) {
            const next = afterPulse(misses.current, outcome);
            if (next === null) owned.current = null; else misses.current = next;
          }
        }
        if (cancelled) return;
        const s = await fetchReanchorStatus(sn);
        if (cancelled) return;
        setStatus(s);
        if (!s.active && s.cycleId === id && owned.current === id) owned.current = null;
      } catch { /* Expired supervision stops native motion; keep fetching recovery status. */ }
      finally { polling = false; }
    };
    const hide = () => {
      if (document.hidden && owned.current) {
        void reanchorAction(sn, 'stop', { cycleId: owned.current }).catch(() => {}); owned.current = null;
      }
    };
    document.addEventListener('visibilitychange', hide);
    void tick();
    const timer = setInterval(tick, REANCHOR_PULSE_MS);
    return () => {
      generation.current = session + 1; cancelled = true; clearInterval(timer);
      document.removeEventListener('visibilitychange', hide);
      if (owned.current) void reanchorAction(sn, 'stop', { cycleId: owned.current }).catch(() => {});
      owned.current = null;
    };
  }, [sn]);
  const start = async () => {
    const attempt = generation.current;
    setErr(null); setStarting(true);
    try {
      const result = await reanchorAction(sn, 'auto', { mode: 'supervised-v2', ownDockUnmoved: confirmed });
      if (!result.ok || !result.cycleId) throw new Error(result.error || t('reanchor.startFailed'));
      if (attempt !== generation.current || document.hidden) { await reanchorAction(sn, 'stop', { cycleId: result.cycleId }); return; }
      owned.current = result.cycleId; misses.current = 0;
      const s = await fetchReanchorStatus(sn);
      if (attempt === generation.current) setStatus(s);
    } catch (e) { if (attempt === generation.current) setErr(e instanceof Error ? e.message : String(e)); }
    finally { if (attempt === generation.current) setStarting(false); }
  };
  const stop = async () => {
    const id = owned.current ?? status?.cycleId;
    if (id) await reanchorAction(sn, 'stop', { cycleId: id }).catch(e => setErr(String(e)));
    owned.current = null;
  };
  const active = starting || status?.active;
  const compatible = status?.protocol === 'supervised-reanchor-v2';
  const canStart = compatible && online && confirmed && status?.onDock && status.rtkFixed && !status.installPending && !active;
  return <div className="flex flex-col gap-3">
    <div className="flex items-center gap-2"><Anchor className="w-5 h-5" /><h2>{t('reanchor.title')}</h2></div>
    <p className="text-sm text-gray-300">{t('reanchor.supervisedIntro')}</p>
    <p className="text-xs">RTK: {status?.rtkFixed ? 'Fixed' : '?'} · {t(status?.onDock ? 'reanchor.onDock' : 'reanchor.offDock')}</p>
    {status?.message && <p role="status" className={status.ok ? 'text-emerald-400' : status.phase === 'error' ? 'text-red-400' : 'text-gray-200'}>{status.message}</p>}
    {status?.verificationPending && <p className="text-xs text-amber-300">{t('reanchor.pendingHint')}</p>}
    {status?.installPending && <p className="text-sm text-amber-300">{t('reanchor.installPending')}</p>}
    {status && !compatible && <p role="alert">{t('reanchor.updateRequired')}</p>}
    {err && <p role="alert" className="text-red-400">{err}</p>}
    {active ? <>
      <Loader2 className="w-4 h-4 animate-spin" />
      <button className="rounded-xl bg-red-700 p-3" onClick={() => void stop()}>{t('reanchor.stop')}</button>
    </> : <>
      {status?.phase === 'error' && <>
        <p className="text-xs">{t('reanchor.retryHint')}</p>
        <ManualControlPanel sn={sn} online={online} sensors={sensors} />
      </>}
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{t('reanchor.confirmOwnDock')}</label>
      <button className="rounded-xl bg-blue-600 p-3 disabled:opacity-40" disabled={!canStart} onClick={() => void start()}>{t('reanchor.btnStart')}</button>
    </>}
    <button className="rounded-xl bg-white/10 p-3" onClick={onClose}>{t('reanchor.btnLater')}</button>
  </div>;
}
