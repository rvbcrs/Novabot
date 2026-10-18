import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, ImageOff, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { fetchPatrolPhoto, type PatrolFrameDto, type PatrolRunDto } from '../../api/client';
import { useNearViewport } from '../../hooks/useNearViewport';
import type { Load } from '../../hooks/usePatrolView';
import { markStates, planPoints, runEnding, summarizeRun, type MarkState } from '../../utils/patrolPlan';
import { patrolClock, patrolReasonText, patrolTime } from '../../utils/patrolStatus';
import { useTimeFormat } from '../../utils/timeFormat';

/**
 * The patrol report: one patrol, checkpoint by checkpoint. A summary on top,
 * the photo of the selected checkpoint large with what is known of it beside it
 * (below on a phone), and a strip of every checkpoint of the route with its
 * verdict colour, the ones the mower skipped or never reached among them.
 * Arrow keys step through, Escape closes. While it is open the map shows this
 * run's checkpoints (usePatrolView).
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */

type Verdict = 'person' | 'animal' | 'both' | 'nothing' | 'nodata' | 'skipped' | 'pending';

/** One checkpoint of the route (or, without a route, of the photos there are). */
interface Item {
  seq: number;
  zone: string | null;
  /** Where the mower stood when it reached it; the planned spot for one it did not. */
  x: number;
  y: number;
  frame: PatrolFrameDto | null;
  state: MarkState;
}

function buildItems(run: PatrolRunDto): Item[] {
  const frames = new Map(run.frames.map(f => [f.seq, f]));
  const points = planPoints(run.plan);
  if (points.length === 0) {
    // No route from the server: the checkpoints that left a trace are all there is.
    return [...run.frames].sort((a, b) => a.seq - b.seq)
      .map(f => ({ seq: f.seq, zone: null, x: f.x, y: f.y, frame: f, state: 'done' as const }));
  }
  const states = markStates(points, { mode: 'finished', reached: frames.keys(), endedPhase: run.endedPhase });
  return points.map(p => {
    const frame = frames.get(p.seq) ?? null;
    return { seq: p.seq, zone: p.zone, x: frame?.x ?? p.x, y: frame?.y ?? p.y, frame, state: states.get(p.seq) ?? 'pending' };
  });
}

function verdictOf(it: Item): Verdict {
  if (!it.frame) return it.state === 'skipped' ? 'skipped' : 'pending';
  const seen = it.frame.seen;
  if (seen === null) return 'nodata';
  const person = seen.includes('person');
  const animal = seen.includes('animal');
  return person && animal ? 'both' : person ? 'person' : animal ? 'animal' : 'nothing';
}

/** The colour of a checkpoint's verdict: red a person, amber an animal, green nothing, grey no data. */
const TILE_TONE: Record<Verdict, string> = {
  person: 'border-red-500', both: 'border-red-500', animal: 'border-amber-400', nothing: 'border-emerald-500',
  nodata: 'border-gray-500', skipped: 'border-red-700', pending: 'border-gray-700 border-dashed',
};
const TEXT_TONE: Record<Verdict, string> = {
  person: 'text-red-400', both: 'text-red-400', animal: 'text-amber-300', nothing: 'text-emerald-400',
  nodata: 'text-gray-400', skipped: 'text-red-300', pending: 'text-gray-500',
};

const verdictText = (v: Verdict, t: TFunction): string => t(`patrolReport.verdict.${v}`);

/**
 * How the run ended, as the header says it: an error with its reason, a stop on
 * the mower with its flag (STOP button, lift, tilt), in words; else the plain word.
 */
function endingText(ending: NonNullable<ReturnType<typeof runEnding>>, run: PatrolRunDto, t: TFunction): string {
  if (run.error && ending === 'error') return t('patrolReport.endedError', { error: patrolReasonText(t, run.error) });
  if (run.error && ending === 'stopped') return t('patrolReport.endedStopped', { error: patrolReasonText(t, run.error) });
  return t(`patrolReport.ended.${ending}`);
}

/**
 * The photo of one checkpoint as a blob URL (it needs the bearer token), revoked
 * when the component goes. One photo per mount: a component for another
 * checkpoint is mounted under another key, so a result never lands on the wrong one.
 */
function usePhoto(sn: string, run: string, seq: number, wanted: boolean): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false });
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    let url: string | null = null;
    fetchPatrolPhoto(sn, run, seq)
      .then(u => {
        if (cancelled) { URL.revokeObjectURL(u); return; }
        url = u;
        setState({ url: u, failed: false });
      })
      .catch(() => { if (!cancelled) setState({ url: null, failed: true }); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [sn, run, seq, wanted]);
  return state;
}

interface Props {
  sn: string;
  runs: PatrolRunDto[];
  runsLoad: Load;
  runsError: string | null;
  /** The run shown. */
  runId: string;
  /** A patrol is out, so the newest run is the one still driving. */
  out: boolean;
  zoneName: (slot: string) => string;
  onSelectRun: (run: string) => void;
  onClose: () => void;
}

export function PatrolReport({ sn, runs, runsLoad, runsError, runId, out, zoneName, onSelectRun, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const timeFormat = useTimeFormat();
  const dialogRef = useRef<HTMLDivElement>(null);
  const run = runs.find(r => r.run === runId);

  // Focus moves into the dialog and goes back to what opened it.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => before?.focus?.();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const summary = run ? summarizeRun(run) : null;
  const ending = run ? runEnding(run, out && runs[0]?.run === run.run) : null;
  const detections = summary ? summary.persons + summary.animals : 0;

  return createPortal(
    <div className="fixed inset-0 z-[10050] flex items-stretch justify-center sm:items-center sm:p-6">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('patrolReport.title')}
        tabIndex={-1}
        className="relative flex flex-col w-full h-full sm:h-auto sm:max-h-[92vh] sm:max-w-4xl bg-gray-900 sm:rounded-2xl sm:border border-gray-700 shadow-2xl overflow-hidden outline-none"
      >
        <header className="shrink-0 px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-100 mr-auto">{t('patrolReport.title')}</h2>
            {runs.length > 1 && (
              <select
                value={runId}
                onChange={e => onSelectRun(e.target.value)}
                aria-label={t('patrolReport.pickRun')}
                className="max-w-[55%] text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200"
              >
                {runs.map(r => <option key={r.run} value={r.run}>{patrolTime(r.startedAt, i18n.language, timeFormat)}</option>)}
              </select>
            )}
            <button
              onClick={onClose}
              aria-label={t('common.close', 'Close')}
              title={t('common.close', 'Close')}
              className="shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-white hover:bg-gray-800"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {run && summary && (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-300 wrap-anywhere">
              <span className="tabular-nums">{patrolTime(run.startedAt, i18n.language, timeFormat)}</span>
              <span>
                {summary.total
                  ? t('patrolReport.reachedOf', { n: summary.reached, count: summary.total })
                  : t('patrolReport.reached', { count: summary.reached })}
              </span>
              {summary.skipped ? <span className="text-red-300">{t('patrolReport.skipped', { n: summary.skipped })}</span> : null}
              {/* Nothing is "nothing detected" only when something was looked at. */}
              {(detections > 0 || summary.reached > 0) && (
                <span className={detections ? 'text-amber-300' : 'text-gray-400'}>
                  {detections
                    ? t('patrolReport.detections', { persons: summary.persons, animals: summary.animals })
                    : t('patrolReport.noDetections')}
                </span>
              )}
              {ending && (
                <span className={ending === 'error' ? 'text-red-400' : ending === 'done' ? 'text-emerald-400' : ending === 'stopped' ? 'text-amber-300' : 'text-gray-400'}>
                  {endingText(ending, run, t)}
                </span>
              )}
              {run.dockFailedAt && (
                <span className="text-red-300">
                  {Number.isFinite(Date.parse(run.dockFailedAt))
                    ? t('patrolReport.dockFailedAt', { time: patrolClock(Date.parse(run.dockFailedAt), i18n.language, timeFormat) })
                    : t('patrolReport.dockFailed')}
                </span>
              )}
            </div>
          )}
        </header>

        {run ? (
          <RunView key={run.run} sn={sn} run={run} zoneName={zoneName} />
        ) : (
          <div className="p-6 text-sm text-gray-400">
            <p>
              {runsLoad === 'loading' ? t('common.loading')
                : runsLoad === 'failed' ? t('patrolReport.loadFailed')
                : t('patrolReport.gone')}
            </p>
            {runsLoad === 'failed' && runsError && <p className="mt-1 text-xs text-gray-500">{runsError}</p>}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** One run: the selected checkpoint and the strip. Keyed by run, so a new run starts at its own default. */
function RunView({ sn, run, zoneName }: { sn: string; run: PatrolRunDto; zoneName: (slot: string) => string }) {
  const { t, i18n } = useTranslation();
  const timeFormat = useTimeFormat();
  const items = useMemo(() => buildItems(run), [run]);
  const [selSeq, setSelSeq] = useState<number | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  // Open on what matters most: the first checkpoint that saw a person or an animal, else the first.
  const defaultSeq = useMemo(
    () => (items.find(it => { const v = verdictOf(it); return v === 'person' || v === 'animal' || v === 'both'; }) ?? items[0])?.seq,
    [items],
  );
  const index = Math.max(0, items.findIndex(it => it.seq === (selSeq ?? defaultSeq)));
  const item = items[index] as Item | undefined;
  const last = items.length - 1;
  // Moves are relative to the selection as it stands (an updater), so two key
  // presses in quick succession each take a step, whatever has rendered yet.
  const move = useCallback((to: (current: number, last: number) => number) => {
    setSelSeq(prev => {
      const current = Math.max(0, items.findIndex(it => it.seq === (prev ?? defaultSeq)));
      const next = items[Math.min(Math.max(to(current, items.length - 1), 0), items.length - 1)];
      return next ? next.seq : prev;
    });
  }, [items, defaultSeq]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'SELECT' || el.tagName === 'INPUT')) return;   // arrows belong to the control
      if (e.key === 'ArrowLeft') { e.preventDefault(); move(c => c - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); move(c => c + 1); }
      else if (e.key === 'Home') { e.preventDefault(); move(() => 0); }
      else if (e.key === 'End') { e.preventDefault(); move((_, l) => l); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move]);

  // Keep the selected tile in view when the arrows move it: the strip scrolls, nothing around it.
  useEffect(() => {
    const strip = stripRef.current;
    const tile = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (strip && tile) strip.scrollTo({ left: tile.offsetLeft - (strip.clientWidth - tile.offsetWidth) / 2 });
  }, [index]);

  if (!item) return <p className="p-6 text-sm text-gray-400">{t('patrolReport.noCheckpoints')}</p>;

  const verdict = verdictOf(item);
  const f = item.frame;
  const hasPlan = items.some(it => it.zone !== null);
  const kinds = f?.seen?.map(k => t(`drawer.patrol.${k}`)).join(', ') ?? '';
  const row = (label: string, value: string) => (
    <div className="flex justify-between gap-3 py-1 border-b border-gray-800 last:border-0">
      <dt className="text-gray-400">{label}</dt>
      <dd className="min-w-0 text-gray-100 text-right tabular-nums wrap-anywhere">{value}</dd>
    </div>
  );

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4 md:flex-row">
        <div className="md:w-3/5 shrink-0">
          <div className="relative aspect-[4/3] w-full bg-black rounded-lg overflow-hidden flex items-center justify-center">
            <MainPhoto key={`${run.run}:${item.seq}`} sn={sn} run={run.run} item={item} caption={verdictText(verdict, t)} />
            <button
              onClick={() => move(c => c - 1)}
              disabled={index === 0}
              aria-label={t('patrolReport.prev')}
              title={t('patrolReport.prev')}
              className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 inline-flex items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/75 disabled:opacity-30"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={() => move(c => c + 1)}
              disabled={index === last}
              aria-label={t('patrolReport.next')}
              title={t('patrolReport.next')}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 inline-flex items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/75 disabled:opacity-30"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="md:w-2/5 min-w-0 text-xs">
          <h3 className="text-sm font-semibold text-gray-100 mb-1" aria-live="polite">
            {hasPlan
              ? t('patrolReport.checkpointOf', { n: item.seq, m: items.length })
              : t('patrolReport.checkpoint', { n: item.seq })}
          </h3>
          <p className={`mb-2 font-medium ${TEXT_TONE[verdict]}`}>{verdictText(verdict, t)}</p>
          <dl>
            {f && row(t('patrolReport.time'), patrolClock(f.ts, i18n.language, timeFormat))}
            {item.zone && row(t('patrolReport.zone'), zoneName(item.zone))}
            {row(t('patrolReport.position'), `${item.x.toFixed(1)}, ${item.y.toFixed(1)} m`)}
            {f && row(t('patrolReport.personPoints'), String(f.person))}
            {f && row(t('patrolReport.animalPoints'), String(f.animal))}
            {f && row(t('patrolReport.frames'), String(f.frames))}
            {/* No camera data is not "no alert": nobody knows what stood there. */}
            {f && row(t('patrolReport.alert'), f.seen === null ? '-' : kinds ? t('patrolReport.alertYes', { kinds }) : t('patrolReport.alertNo'))}
          </dl>
          {verdict === 'nodata' && <p className="mt-2 text-gray-400">{t('drawer.patrol.noDataHint')}</p>}
        </div>
      </div>

      <div className="shrink-0 border-t border-gray-800 px-3 py-2">
        <div
          ref={stripRef}
          role="listbox"
          aria-label={t('patrolReport.strip')}
          className="relative flex gap-1.5 overflow-x-auto p-1"
        >
          {items.map((it, i) => (
            <Thumb key={it.seq} sn={sn} run={run.run} item={it} selected={i === index} onSelect={() => move(() => i)} />
          ))}
        </div>
      </div>
    </>
  );
}

/** The big photo of the selected checkpoint; where there is none, the reason. Mounted per checkpoint (keyed). */
function MainPhoto({ sn, run, item, caption }: { sn: string; run: string; item: Item; caption: string }) {
  const { t } = useTranslation();
  const f = item.frame;
  const photo = usePhoto(sn, run, item.seq, !!f?.image);
  if (photo.url) {
    return (
      <a href={photo.url} target="_blank" rel="noreferrer" className="block w-full h-full">
        <img src={photo.url} alt={t('patrolReport.photoAlt', { n: item.seq })} className="w-full h-full object-contain" />
      </a>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2 px-6 text-center text-gray-400">
      <ImageOff className="w-8 h-8 text-gray-600" />
      <span className="text-xs">
        {f?.image
          ? (photo.failed ? t('patrolReport.photoFailed') : t('common.loading'))
          : f ? t('patrolReport.noPhoto') : caption}
      </span>
    </div>
  );
}

/** One tile of the strip: the photo (loaded when it is near the screen), the verdict colour as its border, the number in a corner. */
function Thumb({ sn, run, item, selected, onSelect }: { sn: string; run: string; item: Item; selected: boolean; onSelect: () => void }) {
  const { t } = useTranslation();
  const [ref, near] = useNearViewport<HTMLButtonElement>();
  const photo = usePhoto(sn, run, item.seq, near && !!item.frame?.image);
  const verdict = verdictOf(item);
  return (
    <button
      ref={ref}
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      title={`${item.seq}: ${verdictText(verdict, t)}`}
      className={`relative shrink-0 w-16 h-12 rounded border-2 bg-gray-800 overflow-hidden flex items-center justify-center ${TILE_TONE[verdict]} ${selected ? 'ring-2 ring-white ring-offset-1 ring-offset-gray-900' : 'opacity-80 hover:opacity-100'}`}
    >
      {photo.url ? <img src={photo.url} alt="" className="w-full h-full object-cover" />
        : verdict === 'skipped' ? <X className="w-5 h-5 text-red-400" />
        : item.frame ? <ImageOff className="w-4 h-4 text-gray-600" />
        : null}
      <span className="absolute left-0 bottom-0 px-1 text-[9px] leading-tight bg-black/65 text-gray-100 rounded-tr tabular-nums">{item.seq}</span>
    </button>
  );
}
