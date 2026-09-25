import { useCallback, useEffect, useRef, useState } from 'react';
import { Anchor, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  reanchorAction, fetchReanchorStatus, type ReanchorStatus,
} from '../../api/client';
import { ManualControlPanel } from './ManualControlPanel';

interface Props {
  sn: string;
  online: boolean;
  sensors?: Record<string, string>;
  onClose: () => void;
}

const PHASES_RUNNING: ReanchorStatus['phase'][] = ['check', 'anchor', 'relock', 'wait', 'dock', 'verify'];

/**
 * Post-restore re-anchor wizard — dashboard mirror of the app ReanchorWizard.
 * After a bundle restore the saved map frame no longer agrees with the live UTM
 * frame; the server sets frame_unvalidated and this wizard drives the
 * server-orchestrated sequence (reanchor_pos -> drive back -> re-lock -> dock ->
 * verify). Two phases hand control to the operator (needs_drive / needs_position)
 * via the embedded joystick. We poll GET /reanchor/:sn/status for progress.
 */
export function ReanchorWizard({ sn, online, sensors, onClose }: Props) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<ReanchorStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Live gating: prefer the server's status booleans, fall back to sensors so the
  // idle screen shows correct preconditions before the first poll lands.
  const rsStr = String(sensors?.recharge_status ?? '');
  const bs = String(sensors?.battery_state ?? '').toLowerCase();
  const sensorDocked = rsStr.includes('Charging') || rsStr === '9' || bs === 'charging';
  const fixRaw = sensors?.rtk_fix_quality ?? '';
  const sensorFixed = fixRaw === '4' || fixRaw === 'RTK Fixed';

  const docked = status?.onDock ?? sensorDocked;
  const rtkFixed = status?.rtkFixed ?? sensorFixed;
  const relocked = status?.relocked ?? false;
  const canStart = docked && rtkFixed;
  const canVerify = docked && relocked;
  const inError = status?.phase === 'error';

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  // Poll status continuously while the wizard is open (gives live onDock/rtkFixed/
  // relocked for gating even before the auto flow starts). Closes on success.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await fetchReanchorStatus(sn);
        if (cancelled) return;
        setStatus(s);
        if (s.phase === 'done' && s.ok) {
          setRunning(false);
          setTimeout(() => { if (!cancelled) onClose(); }, 1200);
        } else if (s.phase === 'error') {
          setRunning(false);
        }
      } catch { /* transient — keep polling */ }
    };
    void tick();
    pollRef.current = setInterval(tick, 2000);
    return () => { cancelled = true; stopPolling(); };
  }, [sn, onClose, stopPolling]);

  const startAuto = useCallback(async () => {
    setErr(null);
    setStatus(null);
    try {
      const r = await reanchorAction(sn, 'auto');
      if (!r.ok) { setErr(r.error ?? t('reanchor.startFailed', 'Starten mislukt')); return; }
      setRunning(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('reanchor.startFailed', 'Starten mislukt'));
    }
  }, [sn, t]);

  const startDock = useCallback(async () => {
    setErr(null);
    try {
      const r = await reanchorAction(sn, 'verify');
      if (!r.ok) { setErr(r.error ?? t('reanchor.startFailed', 'Starten mislukt')); return; }
      setStatus(s => (s ? { ...s, phase: 'verify', msgKey: 'reanchorMsgVerify', message: '' } : s));
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('reanchor.startFailed', 'Starten mislukt'));
    }
  }, [sn, t]);

  const verifyManual = useCallback(async () => {
    setErr(null);
    try {
      const r = await reanchorAction(sn, 'verify');
      if (!r.ok) { setErr(r.error ?? t('reanchor.verifyFailed', 'Verifiëren mislukt')); return; }
      setRunning(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('reanchor.verifyFailed', 'Verifiëren mislukt'));
    }
  }, [sn, t]);

  // Live progress text: prefer the server's stable msgKey (interpolated with
  // pose/dist), fall back to its Dutch `message`.
  const liveMessage = (s: ReanchorStatus | null): string => {
    if (!s) return t('reanchor.busy', 'Bezig...');
    if (s.msgKey) {
      return t(s.msgKey, {
        x: s.pose ? s.pose.x.toFixed(2) : '',
        y: s.pose ? s.pose.y.toFixed(2) : '',
        dist: Number.isFinite(s.dist as number) ? (s.dist as number).toFixed(2) : '?',
        defaultValue: s.message || t('reanchor.busy', 'Bezig...'),
      });
    }
    return s.message || t('reanchor.busy', 'Bezig...');
  };

  const phaseRunning = status != null && PHASES_RUNNING.includes(status.phase);

  const StatusBlock = (
    <div className="flex items-center gap-3 text-xs">
      <span className={rtkFixed ? 'text-emerald-400 font-semibold' : 'text-amber-400 font-semibold'}>
        RTK: {rtkFixed ? 'Fixed' : (fixRaw || '—')}
      </span>
      <span className={docked ? 'text-emerald-400 font-semibold' : 'text-amber-400 font-semibold'}>
        {docked ? t('reanchor.onDock', 'Op de dock') : t('reanchor.offDock', 'Niet op de dock')}
      </span>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Anchor className="w-5 h-5 text-amber-300" />
        <span className="text-base font-semibold text-white">{t('reanchor.title', 'Opnieuw verankeren')}</span>
      </div>

      {status?.phase === 'needs_drive' ? (
        <>
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 text-amber-300 animate-spin" />
            <span className="text-sm text-amber-300 font-semibold flex-1">{liveMessage(status)}</span>
          </div>
          <p className="text-xs text-gray-300">{t('reanchor.needsDriveHint', 'Rij met de joystick ~1 m recht achteruit; ik ga automatisch verder zodra de localisatie lockt.')}</p>
          {StatusBlock}
          <ManualControlPanel sn={sn} online={online} sensors={sensors} />
        </>
      ) : status?.phase === 'needs_position' ? (
        <>
          <span className="text-sm text-amber-300 font-semibold">{liveMessage(status)}</span>
          <p className="text-xs text-gray-300">{t('reanchor.returnToDockHint', 'Rij met de joystick terug op het dock en druk op Verifieer.')}</p>
          {StatusBlock}
          {err && <span className="text-xs text-red-400 font-semibold">{err}</span>}
          <ManualControlPanel sn={sn} online={online} sensors={sensors} />
          <WizardButton label={t('reanchor.btnVerify', 'Verifieer')} onClick={startDock} />
          <WizardButton label={t('reanchor.btnLater', 'Later')} onClick={onClose} secondary />
        </>
      ) : running || phaseRunning ? (
        <>
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 text-emerald-400 animate-spin" />
            <span className="text-sm text-gray-200 flex-1">{liveMessage(status)}</span>
          </div>
          <p className="text-[11px] text-gray-500">{t('reanchor.waitingHint', 'Wacht op de controle. Rijden gebeurt met de joystick onder toezicht.')}</p>
        </>
      ) : status?.phase === 'done' && status.ok ? (
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-emerald-400" />
          <span className="text-sm text-emerald-400 font-semibold">{liveMessage(status)}</span>
        </div>
      ) : inError ? (
        <>
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0" />
            <span className="text-sm text-red-400 font-semibold">{liveMessage(status)}</span>
          </div>
          <p className="text-xs text-gray-300">{t('reanchor.manualBackupHint', 'Dok de maaier handmatig met de joystick en druk Verifieer.')}</p>
          {StatusBlock}
          <ManualControlPanel sn={sn} online={online} sensors={sensors} />
          <WizardButton label={t('reanchor.btnVerify', 'Verifieer')} onClick={verifyManual} disabled={!canVerify} />
          <WizardButton label={t('reanchor.btnRetryAuto', 'Opnieuw automatisch')} onClick={startAuto} disabled={!canStart} secondary />
          <WizardButton label={t('reanchor.btnLater', 'Later')} onClick={onClose} secondary />
        </>
      ) : (
        <>
          <p className="text-sm text-gray-300">{t('reanchor.idleIntro', 'Na een restore moet het kaartframe opnieuw worden verankerd op de dock. Eén knop doet de hele reeks.')}</p>
          {StatusBlock}
          {err && <span className="text-xs text-red-400 font-semibold">{err}</span>}
          {canStart ? (
            <span className="text-sm text-emerald-400 font-semibold">{t('reanchor.ready', 'Klaar om te starten')}</span>
          ) : (
            <span className="text-sm text-amber-400 font-semibold">
              {!docked ? t('reanchor.needDock', 'Dok de maaier eerst (laden).') : t('reanchor.needFix', 'Wacht op RTK Fixed.')}
            </span>
          )}
          <WizardButton label={t('reanchor.btnStart', 'Start verankeren')} onClick={startAuto} disabled={!canStart} />
          <WizardButton label={t('reanchor.btnLater', 'Later')} onClick={onClose} secondary />
        </>
      )}
    </div>
  );
}

function WizardButton({ label, onClick, secondary, disabled }: {
  label: string; onClick: () => void; secondary?: boolean; disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`py-2.5 rounded-xl text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        secondary
          ? 'bg-white/10 text-gray-300 hover:bg-white/15'
          : 'bg-blue-600 text-white hover:bg-blue-500'
      }`}
    >
      {label}
    </button>
  );
}
