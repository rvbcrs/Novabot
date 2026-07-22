import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Compass, Loader2, CheckCircle2, XCircle, AlertTriangle, Square } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { getSocket } from '../../api/socket';

/**
 * Dashboard-paneel voor "Autonoom karteren" (route B) — start/voortgang/review.
 * Consumeert de Task 8-endpoints (server/src/routes/dashboard.ts `/auto-map/:sn/*`)
 * en het `auto_map_progress`-socketevent (server/src/dashboard/socketHandler.ts).
 * Spec: docs/superpowers/specs/2026-07-22-autonomous-mapping-design.md
 *
 * De server broadcast `auto_map_progress` ongefilterd naar alle sockets — dit
 * paneel filtert zelf op de actieve SN. Het event draagt niet altijd een
 * volledige foutmelding (zie autoMap.ts `finish()`), dus elk event triggert
 * gewoon een verse GET /status i.p.v. te vertrouwen op het event-payload zelf.
 * De 10s-poll is de fallback als de socket een event mist (reconnect etc.).
 */

type AutoMapMode = 'test' | 'record';

interface AutoMapStatus {
  id?: number;
  sn?: string;
  mode?: AutoMapMode;
  phase: string;
  radius_m?: number;
  result_code?: number | null;
  error?: string | null;
  started_at?: string;
  finished_at?: string | null;
}

interface AutoMapProgressEvent {
  sn: string;
  sessionId: number;
  phase: string;
  detail?: Record<string, unknown>;
}

type TFunc = TFunction;

const RUNNING_PHASES = new Set(['preflight', 'preparing', 'searching_boundary', 'following', 'recording', 'finishing']);
const TERMINAL_PHASES = new Set(['done', 'rejected', 'error', 'aborted']);
const POLL_MS = 10_000;
const RADIUS_MIN = 5;
const RADIUS_MAX = 200;
const RADIUS_DEFAULT = 30;

const BASE = '/api/dashboard/auto-map';

async function fetchAutoMapStatus(sn: string): Promise<AutoMapStatus> {
  const res = await apiFetch(`${BASE}/${encodeURIComponent(sn)}/status`);
  return res.json();
}

async function startAutoMap(sn: string, mode: AutoMapMode, radiusM: number): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch(`${BASE}/${encodeURIComponent(sn)}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, radiusM }),
  });
  const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
  return { ok: res.ok && data.ok !== false, error: data.error };
}

async function stopAutoMap(sn: string): Promise<void> {
  await apiFetch(`${BASE}/${encodeURIComponent(sn)}/stop`, { method: 'POST' });
}

async function reviewAutoMap(sn: string, action: 'accept' | 'reject'): Promise<boolean> {
  const res = await apiFetch(`${BASE}/${encodeURIComponent(sn)}/${action}`, { method: 'POST' });
  const data = await res.json().catch(() => ({})) as { ok?: boolean };
  return data.ok === true;
}

const PHASE_LABEL_KEYS: Record<string, [string, string]> = {
  preflight: ['autoMap.phase.preflight', 'Voorbereiden'],
  preparing: ['autoMap.phase.preparing', 'Voorbereiden'],
  searching_boundary: ['autoMap.phase.searchingBoundary', 'Grasrand zoeken'],
  following: ['autoMap.phase.following', 'Rand volgen'],
  recording: ['autoMap.phase.recording', 'Opnemen'],
  finishing: ['autoMap.phase.finishing', 'Kaart opslaan'],
  awaiting_review: ['autoMap.phase.awaitingReview', 'Wacht op beoordeling'],
  done: ['autoMap.phase.done', 'Klaar'],
  rejected: ['autoMap.phase.rejected', 'Verworpen'],
  error: ['autoMap.phase.error', 'Fout'],
  aborted: ['autoMap.phase.aborted', 'Afgebroken'],
};

function phaseLabel(phase: string, t: TFunc): string {
  const entry = PHASE_LABEL_KEYS[phase];
  return entry ? t(entry[0], entry[1]) : phase;
}

const ERROR_LABEL_KEYS: Record<string, [string, string]> = {
  preflight_battery: ['autoMap.error.preflightBattery', 'Accu moet boven 40% zijn'],
  preflight_rtk: ['autoMap.error.preflightRtk', 'Wacht op RTK Fixed'],
  already_running: ['autoMap.error.alreadyRunning', 'Er loopt al een sessie'],
  geofence: ['autoMap.error.geofence', 'Geofence overschreden, rit gestopt'],
  timeout: ['autoMap.error.timeout', 'Tijdslimiet bereikt'],
  relay_missing: ['autoMap.error.relayMissing', 'lawn_edge_relay draait niet op de maaier'],
};

/** Bekende foutcodes krijgen een NL-vertaling; onbekende (bv. de letterlijke
 *  firmware-melding "geen grasrand gevonden op startpunt") tonen we as-is. */
function errorLabel(code: string | null | undefined, t: TFunc): string {
  if (!code) return t('autoMap.error.unknown', 'Onbekende fout');
  const entry = ERROR_LABEL_KEYS[code];
  return entry ? t(entry[0], entry[1]) : code;
}

function clampRadius(n: number): number {
  if (!Number.isFinite(n)) return RADIUS_DEFAULT;
  return Math.max(RADIUS_MIN, Math.min(RADIUS_MAX, Math.round(n)));
}

interface Props {
  sn: string;
}

/**
 * Zes UI-toestanden: setup-formulier (idle / gedismiste afronding), lopend
 * (preflight..finishing), review (awaiting_review), klaar (done), verworpen
 * (rejected), fout/afgebroken (error/aborted). Een net-afgeronde sessie wordt
 * altijd getoond (het paneel zag de overgang live); een OUDE afgeronde sessie
 * (koude page-load) wordt bij de eerste fetch meteen weer als setup-formulier
 * getoond i.p.v. een stokoude banner op te voeren.
 */
export function AutoMapPanel({ sn }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AutoMapStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<AutoMapMode>('test');
  const [radiusM, setRadiusM] = useState(RADIUS_DEFAULT);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(true);
  const lastPhaseRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await fetchAutoMapStatus(sn);
      const prevPhase = lastPhaseRef.current;
      if (prevPhase === null) {
        setDismissed(TERMINAL_PHASES.has(s.phase));
      } else if (prevPhase !== s.phase && TERMINAL_PHASES.has(s.phase)) {
        setDismissed(false);
      }
      lastPhaseRef.current = s.phase;
      setStatus(s);
    } catch {
      // Transient netwerkfout — de volgende poll of het volgende socket-event
      // probeert het opnieuw.
    }
  }, [sn]);

  useEffect(() => {
    lastPhaseRef.current = null;
    setDismissed(true);
    setStatus(null);
    void refresh();

    const timer = setInterval(() => { void refresh(); }, POLL_MS);

    const socket = getSocket();
    const onProgress = (e: AutoMapProgressEvent) => {
      if (e.sn === sn) void refresh();
    };
    socket.on('auto_map_progress', onProgress);

    return () => {
      clearInterval(timer);
      socket.off('auto_map_progress', onProgress);
    };
  }, [sn, refresh]);

  const handleStart = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await startAutoMap(sn, mode, radiusM);
      if (!r.ok) {
        setError(errorLabel(r.error, t));
      } else {
        setDismissed(false);
        void refresh();
      }
    } finally {
      setBusy(false);
    }
  }, [sn, mode, radiusM, refresh, t]);

  const handleStop = useCallback(async () => {
    setBusy(true);
    try {
      await stopAutoMap(sn);
      void refresh();
    } finally {
      setBusy(false);
    }
  }, [sn, refresh]);

  const handleReview = useCallback(async (action: 'accept' | 'reject') => {
    setBusy(true);
    setError(null);
    try {
      const ok = await reviewAutoMap(sn, action);
      if (!ok) setError(t('autoMap.reviewFailed', 'Actie mislukt, probeer opnieuw.'));
      void refresh();
    } finally {
      setBusy(false);
    }
  }, [sn, refresh, t]);

  const resetToForm = useCallback(() => setDismissed(true), []);

  const phase = status?.phase ?? 'idle';
  const isRunning = RUNNING_PHASES.has(phase);
  const isReview = phase === 'awaiting_review';
  const isTerminal = TERMINAL_PHASES.has(phase) && !dismissed;
  const showForm = phase === 'idle' || (TERMINAL_PHASES.has(phase) && dismissed);

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl p-3 md:p-4 flex flex-col gap-3 flex-shrink-0">
      <div className="flex items-center gap-2">
        <Compass className="w-4 h-4 text-sky-400" />
        <span className="text-sm font-semibold text-white">{t('autoMap.title', 'Autonoom karteren')}</span>
      </div>

      {showForm && (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <ModeButton
              active={mode === 'test'}
              onClick={() => setMode('test')}
              label={t('autoMap.modeTest', 'Testrit (zonder opname)')}
            />
            <ModeButton
              active={mode === 'record'}
              onClick={() => setMode('record')}
              label={t('autoMap.modeRecord', 'Kaart maken')}
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-300">
            {t('autoMap.radiusLabel', 'Geofence (m)')}
            <input
              type="number"
              min={RADIUS_MIN}
              max={RADIUS_MAX}
              value={radiusM}
              onChange={e => setRadiusM(clampRadius(Number(e.target.value)))}
              onBlur={e => setRadiusM(clampRadius(Number(e.target.value)))}
              className="w-20 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-sky-500"
            />
          </label>
          {error && <span className="text-xs text-red-400 font-semibold">{error}</span>}
          <button
            onClick={handleStart}
            disabled={busy}
            className="self-start px-4 py-2 rounded-lg text-sm font-medium bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {t('autoMap.start', 'Start')}
          </button>
        </div>
      )}

      {isRunning && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 text-sky-400 animate-spin" />
            <span className="text-sm font-semibold text-sky-300">{phaseLabel(phase, t)}</span>
          </div>
          {status?.error && (
            <span className="text-xs text-red-400 font-semibold">{errorLabel(status.error, t)}</span>
          )}
          <button
            onClick={handleStop}
            disabled={busy}
            className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-900/50 text-red-300 hover:bg-red-900/70 disabled:opacity-40 transition-colors"
          >
            <Square className="w-3 h-3" />
            {t('autoMap.stop', 'Stop')}
          </button>
        </div>
      )}

      {isReview && (
        <div className="flex flex-col gap-2 bg-amber-950/30 border border-amber-700/40 rounded-lg p-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
            <span className="text-sm text-amber-200">
              {t('autoMap.reviewBanner', 'De maaier heeft een kaart gemaakt. Controleer hem op de kaartweergave en accepteer of verwerp.')}
            </span>
          </div>
          {error && <span className="text-xs text-red-400 font-semibold">{error}</span>}
          <div className="flex gap-2">
            <button
              onClick={() => handleReview('accept')}
              disabled={busy}
              className="flex-1 px-3 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 transition-colors"
            >
              {t('autoMap.accept', 'Kaart accepteren')}
            </button>
            <button
              onClick={() => handleReview('reject')}
              disabled={busy}
              className="flex-1 px-3 py-2 rounded-lg text-sm font-medium bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-40 transition-colors"
            >
              {t('autoMap.reject', 'Verwerpen')}
            </button>
          </div>
        </div>
      )}

      {isTerminal && phase === 'done' && (
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          <span className="text-sm text-emerald-400 font-semibold flex-1">{t('autoMap.done', 'Klaar')}</span>
          <button onClick={resetToForm} className="text-xs text-sky-400 hover:text-sky-300">
            {t('autoMap.newAttempt', 'Nieuwe poging')}
          </button>
        </div>
      )}

      {isTerminal && phase === 'rejected' && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <XCircle className="w-4 h-4 text-gray-400 flex-shrink-0" />
            <span className="text-sm text-gray-300 font-semibold">{phaseLabel(phase, t)}</span>
          </div>
          <p className="text-xs text-gray-400">
            {t('autoMap.rejectedHint', 'Je kunt de kaart op de maaier verwijderen via het bestaande kaartbeheer. Start daarna een nieuwe poging.')}
          </p>
          <button onClick={resetToForm} className="self-start text-xs text-sky-400 hover:text-sky-300">
            {t('autoMap.newAttempt', 'Nieuwe poging')}
          </button>
        </div>
      )}

      {isTerminal && (phase === 'error' || phase === 'aborted') && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
            <span className="text-sm text-red-400 font-semibold">{phaseLabel(phase, t)}</span>
          </div>
          {status?.error && (
            <span className="text-xs text-red-300">{errorLabel(status.error, t)}</span>
          )}
          <button onClick={resetToForm} className="self-start text-xs text-sky-400 hover:text-sky-300">
            {t('autoMap.retry', 'Opnieuw proberen')}
          </button>
        </div>
      )}
    </div>
  );
}

function ModeButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
        active
          ? 'bg-sky-600 text-white'
          : 'bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200'
      }`}
    >
      {label}
    </button>
  );
}
