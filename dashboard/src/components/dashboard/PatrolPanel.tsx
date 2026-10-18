import { useEffect, useRef, useState } from 'react';
import { Check, PawPrint, User, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  fetchDeviceSettings, setSensorOverride, fetchMaps,
  fetchPatrolPhoto, fetchPatrolSchedule, savePatrolSchedule,
  type PatrolRunDto, type PatrolFrameDto,
} from '../../api/client';
import { useNearViewport } from '../../hooks/useNearViewport';
import type { Load } from '../../hooks/usePatrolView';
import type { PatrolReports } from '../../hooks/usePatrolReports';
import type { MapData } from '../../types';
import { runEnding, summarizeRun } from '../../utils/patrolPlan';
import { patrolPhaseText, patrolReasonText, patrolStatus, patrolTime } from '../../utils/patrolStatus';
import { useTimeFormat } from '../../utils/timeFormat';

/**
 * The night patrol panel under the control bar: the phase, the zones, the
 * headlight, one nightly schedule, the photos of the last run and the list of
 * the last ten, from which the report opens. Start and Stop are the Patrol button
 * in the bar (PatrolButton). Opens like the Mapping panel; while it is open the
 * map shows the route (usePatrolView).
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */

const DEFAULT_TIME = '23:30';
const TIME_RE = /^\d{2}:\d{2}$/;
/** A time typed digit by digit changes several times; it is saved once it has rested this long. */
const TIME_SETTLE_MS = 800;

const NO_REPORTS: PatrolReports = { run: null, skipped: [], skippedPoints: [], reached: [], checkpoints: 0 };

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Zone { slot: string; name: string }

/** One checkbox per work area, in slot order. Only `mapN` slots: that is what a patrol takes. */
function zonesOf(maps: MapData[]): Zone[] {
  const bySlot = new Map<string, Zone>();
  for (const m of maps) {
    const slot = m.canonicalName ?? '';
    if (m.mapType !== 'work' || !/^map\d+$/.test(slot) || bySlot.has(slot)) continue;
    bySlot.set(slot, { slot, name: m.mapName || slot });
  }
  return [...bySlot.values()].sort((a, b) => Number(a.slot.slice(3)) - Number(b.slot.slice(3)));
}

/** patrol_zones as saved: a JSON array of slot names. */
function storedZones(raw: string | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

interface Props {
  sn: string;
  sensors?: Record<string, string>;
  reports?: PatrolReports;
  /** The kept runs, newest first, from usePatrolView. */
  runs: PatrolRunDto[];
  runsLoad: Load;
  runsError: string | null;
  /** A zone was ticked or cleared and saved: the route the map shows has changed. */
  onZonesSaved?: () => void;
  /** Open the patrol report on this run. */
  onOpenReport: (run: string) => void;
}

export function PatrolPanel({ sn, sensors, reports = NO_REPORTS, runs, runsLoad, runsError, onZonesSaved, onOpenReport }: Props) {
  const { t, i18n } = useTranslation();
  const timeFormat = useTimeFormat();
  const status = patrolStatus(sensors);
  const { otherDrive } = status;
  const { skipped, skippedPoints } = reports;
  const [zones, setZones] = useState<Zone[]>([]);
  const [stored, setStored] = useState<string[]>([]);
  const [headlight, setHeadlight] = useState(true);
  const [settingsLoad, setSettingsLoad] = useState<Load>('loading');
  const [zonesLoad, setZonesLoad] = useState<Load>('loading');
  const [message, setMessage] = useState<string | null>(null);

  // The saved settings and the zones, once per open panel. Separate requests: a
  // slow or failing map list must not hide what is saved for the headlight.
  useEffect(() => {
    let cancelled = false;
    fetchDeviceSettings(sn)
      .then(settings => {
        if (cancelled) return;
        setStored(storedZones(settings.patrol_zones));
        setHeadlight((settings.patrol_headlight ?? '100') !== '0');
        setSettingsLoad('ready');
      })
      .catch(e => { if (!cancelled) { setSettingsLoad('failed'); setMessage(reasonOf(e)); } });
    fetchMaps(sn)
      .then(maps => {
        if (cancelled) return;
        setZones(zonesOf(maps.maps));
        setZonesLoad('ready');
      })
      .catch(e => { if (!cancelled) { setZonesLoad('failed'); setMessage(reasonOf(e)); } });
    return () => { cancelled = true; };
  }, [sn]);
  // A zone that was deleted since is no longer ticked (the server ignores it too).
  const chosen = stored.filter(slot => zones.some(z => z.slot === slot));

  /** Save settings; when that fails, put the control back and say so. */
  const persist = (fields: Record<string, string>, undo: () => void, saved?: () => void) => {
    setMessage(null);
    void setSensorOverride(sn, fields).then(() => saved?.()).catch(() => { undo(); setMessage(t('drawer.patrol.saveFailed')); });
  };

  const toggleZone = (slot: string) => {
    const before = chosen;
    const next = before.includes(slot) ? before.filter(z => z !== slot) : [...before, slot];
    setStored(next);
    persist({ patrol_zones: JSON.stringify(next) }, () => setStored(before), onZonesSaved);
  };
  const toggleHeadlight = () => {
    const before = headlight;
    setHeadlight(!before);
    persist({ patrol_headlight: before ? '0' : '100' }, () => setHeadlight(before));
  };

  const zoneName = (slot: string) => zones.find(z => z.slot === slot)?.name ?? slot;
  // Skipped checkpoints: one line per reason, the numbers in order.
  const pointLines = [...new Set(skippedPoints.map(p => p.reason))].map(reason => ({
    reason,
    seqs: [...new Set(skippedPoints.filter(p => p.reason === reason).map(p => p.seq))].sort((a, b) => a - b).join(', '),
  }));
  // "None ticked" is only true once both the saved choice and the zones are known.
  const showZonesHint = settingsLoad === 'ready' && zonesLoad === 'ready' && chosen.length === 0;
  const shownMessage = message ?? runsError;
  const last = runs[0];

  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-300 mb-2">{t('drawer.patrol.title')}</h3>
      <p
        role="status"
        aria-live="polite"
        className={`text-[11px] mb-2 ${status.failed ? 'text-red-400' : 'text-gray-400'}`}
      >
        {patrolPhaseText(t, status)}
      </p>
      {otherDrive && <p className="text-[11px] text-amber-400 mb-2">{t('drawer.patrol.otherDrive')}</p>}
      {skipped.map(s => (
        <p key={s.zone} className="text-[11px] text-amber-400 mb-2">
          {t('drawer.patrol.skipped', {
            zone: zoneName(s.zone),
            reason: t(`drawer.patrol.skipReason.${s.reason}`, s.reason),
          })}
        </p>
      ))}
      {pointLines.map(l => (
        <p key={l.reason} className="text-[11px] text-amber-400 mb-2">
          {t('drawer.patrol.skippedPoints', {
            seqs: l.seqs,
            reason: t(`drawer.patrol.skipReason.${l.reason}`, l.reason),
          })}
        </p>
      ))}
      {shownMessage && <p className="text-[11px] text-red-400 mb-2">{shownMessage}</p>}

      <div className="text-[11px] text-gray-400 mb-1">{t('drawer.patrol.zones')}</div>
      <div className={`flex flex-wrap gap-x-3 gap-y-1 ${showZonesHint ? 'mb-1' : 'mb-2'}`}>
        {zones.map(z => (
          <label key={z.slot} className="flex items-center gap-1 text-[11px] text-gray-300">
            <input
              type="checkbox"
              checked={chosen.includes(z.slot)}
              disabled={settingsLoad !== 'ready'}
              onChange={() => toggleZone(z.slot)}
            />
            {z.name}
          </label>
        ))}
        {(settingsLoad === 'loading' || zonesLoad === 'loading') && (
          <span className="text-[11px] text-gray-500">{t('common.loading')}</span>
        )}
      </div>
      {showZonesHint && <p className="text-[10px] text-gray-500 mb-2">{t('drawer.patrol.zonesHint')}</p>}

      <label className="flex items-center justify-between text-[11px] text-gray-300 mb-2">
        {t('drawer.patrol.headlight')}
        <input
          type="checkbox"
          checked={settingsLoad === 'ready' && headlight}
          disabled={settingsLoad !== 'ready'}
          onChange={toggleHeadlight}
        />
      </label>

      <NightlySchedule sn={sn} onMessage={setMessage} />

      {runsLoad === 'loading' && <p className="text-[11px] text-gray-500">{t('common.loading')}</p>}
      {runsLoad === 'ready' && !last && <p className="text-[11px] text-gray-500">{t('drawer.patrol.noRuns')}</p>}
      {last && (
        <>
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-[11px] text-gray-400">
              {t('drawer.patrol.lastRun', { date: patrolTime(last.startedAt, i18n.language, timeFormat) })}
            </span>
            <button
              onClick={() => onOpenReport(last.run)}
              className="shrink-0 text-[11px] px-2 py-0.5 rounded bg-gray-700/60 text-gray-300 hover:text-white hover:bg-gray-700 transition-colors"
            >
              {t('drawer.patrol.report')}
            </button>
          </div>
          <div className="grid grid-cols-4 gap-1">
            {last.frames.map(f => (
              // Keyed by run as well: a new run's first tile must not keep the
              // previous run's photo on screen while its own one loads.
              <PatrolTile key={`${last.run}:${f.seq}`} sn={sn} run={last.run} frame={f} />
            ))}
          </div>
          <RunList runs={runs} out={status.active} onOpen={onOpenReport} />
        </>
      )}
    </div>
  );
}

/** The last ten patrols, one row each: when, how far it got, what it saw, how it ended. Click opens the report. */
function RunList({ runs, out, onOpen }: { runs: PatrolRunDto[]; out: boolean; onOpen: (run: string) => void }) {
  const { t, i18n } = useTranslation();
  const timeFormat = useTimeFormat();
  return (
    <div className="mt-3">
      <div className="text-[11px] text-gray-400 mb-0.5">{t('drawer.patrol.history')}</div>
      <ul>
        {runs.map((r, i) => {
          const s = summarizeRun(r);
          const ending = runEnding(r, out && i === 0);
          return (
            <li key={r.run}>
              <button
                onClick={() => onOpen(r.run)}
                title={t('drawer.patrol.openReport')}
                className="w-full flex items-center justify-between gap-2 rounded px-1 py-1 text-[10px] text-gray-300 hover:bg-gray-700/50 transition-colors"
              >
                <span className="tabular-nums whitespace-nowrap">{patrolTime(r.startedAt, i18n.language, timeFormat)}</span>
                <span className="flex items-center gap-2 whitespace-nowrap text-gray-400">
                  <span className="inline-flex items-center gap-0.5" title={t('drawer.patrol.reachedTitle')}>
                    <Check className="w-3 h-3 text-emerald-400" />{s.total ? `${s.reached}/${s.total}` : s.reached}
                  </span>
                  {s.skipped ? (
                    <span className="inline-flex items-center gap-0.5 text-red-300" title={t('drawer.patrol.skippedTitle')}>
                      <X className="w-3 h-3" />{s.skipped}
                    </span>
                  ) : null}
                  {s.persons ? (
                    <span className="inline-flex items-center gap-0.5 text-amber-300" title={t('drawer.patrol.personsTitle')}>
                      <User className="w-3 h-3" />{s.persons}
                    </span>
                  ) : null}
                  {s.animals ? (
                    <span className="inline-flex items-center gap-0.5 text-amber-300" title={t('drawer.patrol.animalsTitle')}>
                      <PawPrint className="w-3 h-3" />{s.animals}
                    </span>
                  ) : null}
                  {ending && (
                    <span
                      className={ENDING_TONE[ending]}
                      title={(ending === 'error' || ending === 'stopped') && r.error ? patrolReasonText(t, r.error) : undefined}
                    >
                      {t(`drawer.patrol.ended.${ending}`)}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const ENDING_TONE = {
  done: 'text-emerald-400', stopped: 'text-amber-300', error: 'text-red-400', running: 'text-sky-300', unknown: 'text-gray-500',
} as const;

/**
 * The one nightly patrol schedule of the mower: a time and a switch. The server
 * starts it, so it works without a page or an app open. The time is kept with
 * the switch off. Edits are saved one at a time, and a time typed digit by
 * digit only once it has rested: the first save of a mower creates the
 * schedule, and two of them racing would create it twice (two patrols a night).
 * Until the saved schedule is known the controls stay off, for the same reason:
 * a click on the defaults would create a second schedule beside the real one.
 */
function NightlySchedule({ sn, onMessage }: { sn: string; onMessage: (message: string | null) => void }) {
  const { t } = useTranslation();
  const [load, setLoad] = useState<Load>('loading');
  const [time, setTime] = useState(DEFAULT_TIME);
  const [on, setOn] = useState(false);
  // What the server holds; the id stays null until a first save creates the schedule.
  const held = useRef<{ id: string | null; time: string; on: boolean }>({ id: null, time: DEFAULT_TIME, on: false });
  const queue = useRef<Promise<void>>(Promise.resolve());
  const waiting = useRef(0);
  const settle = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchPatrolSchedule(sn)
      .then(s => {
        if (cancelled) return;
        held.current = { id: s?.scheduleId ?? null, time: s?.startTime ?? DEFAULT_TIME, on: s?.enabled ?? false };
        setTime(held.current.time);
        setOn(held.current.on);
        setLoad('ready');
      })
      .catch(e => { if (!cancelled) { setLoad('failed'); onMessage(reasonOf(e)); } });
    return () => { cancelled = true; };
  }, [sn, onMessage]);

  const save = (nextTime: string, nextOn: boolean) => {
    window.clearTimeout(settle.current);
    onMessage(null);
    waiting.current++;
    queue.current = queue.current.then(async () => {
      const before = held.current;
      try {
        if (nextTime !== before.time || nextOn !== before.on) {
          const saved = await savePatrolSchedule(sn, nextTime, nextOn, before.id);
          held.current = { id: saved?.scheduleId ?? before.id, time: nextTime, on: nextOn };
        }
      } catch (e) {
        onMessage(reasonOf(e) || t('drawer.patrol.saveFailed'));
        // Refused, and no edit behind it: put the controls back on what the server holds.
        if (waiting.current === 1) {
          setTime(before.time);
          setOn(before.on);
        }
      } finally {
        waiting.current--;
      }
    });
  };

  // A time still being typed is not saved half way, and one left behind when the
  // panel closes is still saved (the timer outlives the panel on purpose).
  const onTimeChange = (value: string) => {
    setTime(value);
    window.clearTimeout(settle.current);
    if (TIME_RE.test(value)) settle.current = window.setTimeout(() => save(value, on), TIME_SETTLE_MS);
  };
  const onTimeBlur = () => {
    if (TIME_RE.test(time)) save(time, on);
    else setTime(held.current.time);   // emptied: back to the saved time
  };
  const onSwitch = () => {
    setOn(!on);
    save(TIME_RE.test(time) ? time : held.current.time, !on);
  };

  const ready = load === 'ready';
  return (
    <div className="flex items-center justify-between text-[11px] text-gray-300 mb-3">
      <span>{t('drawer.patrol.nightly')}</span>
      {load === 'loading' ? (
        <span className="text-gray-500">{t('common.loading')}</span>
      ) : (
        <span className="flex items-center gap-2">
          <input
            type="time"
            value={ready ? time : ''}
            disabled={!ready}
            onChange={e => onTimeChange(e.target.value)}
            onBlur={onTimeBlur}
            aria-label={t('drawer.patrol.nightlyTime')}
            className="bg-gray-900 border border-gray-700 rounded px-1 text-gray-200 disabled:opacity-50"
          />
          <input
            type="checkbox"
            checked={ready && on}
            disabled={!ready}
            onChange={onSwitch}
            aria-label={t('drawer.patrol.nightlyOn')}
          />
        </span>
      )}
    </div>
  );
}

/**
 * What a checkpoint saw, in words. `seen` null is no camera data, which is not the
 * same as nothing: the camera gave nothing usable there, and nobody knows what stood there.
 */
function frameLabel(f: PatrolFrameDto, t: TFunction): { text: string; tone: string; hint?: string } {
  if (f.seen === null) return { text: t('drawer.patrol.noData'), tone: 'text-gray-500 italic', hint: t('drawer.patrol.noDataHint') };
  if (!f.seen.length) return { text: t('drawer.patrol.nothing'), tone: 'text-gray-400' };
  return { text: f.seen.map(k => t(`drawer.patrol.${k}`)).join(', '), tone: 'text-amber-400 font-medium' };
}

/**
 * One checkpoint of the last patrol. Its photo is fetched once the tile is near
 * the visible part of the panel: a patrol has up to 60 checkpoints, and 60 photo
 * requests on every open keep everything else waiting for a connection.
 */
function PatrolTile({ sn, run, frame }: { sn: string; run: string; frame: PatrolFrameDto }) {
  const { t } = useTranslation();
  const [ref, near] = useNearViewport<HTMLDivElement>(100);
  const label = frameLabel(frame, t);
  return (
    <div className="text-[10px] leading-tight">
      <div ref={ref} className="aspect-[4/3] bg-gray-900 rounded overflow-hidden mb-0.5 flex items-center justify-center text-gray-600">
        {frame.image ? (near ? <PatrolPhoto sn={sn} run={run} seq={frame.seq} alt={label.text} /> : null) : '--'}
      </div>
      <span className={label.tone} title={label.hint}>{label.text}</span>
    </div>
  );
}

/** One checkpoint photo. It needs the bearer token, so it is fetched as a blob and opens full size in a tab. */
function PatrolPhoto({ sn, run, seq, alt }: { sn: string; run: string; seq: number; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    fetchPatrolPhoto(sn, run, seq)
      .then(u => {
        // The panel closed or moved on while it loaded: nobody will revoke it later.
        if (cancelled) URL.revokeObjectURL(u);
        else { url = u; setSrc(u); }
      })
      .catch(() => { /* no photo: the grey box stays */ });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [sn, run, seq]);
  return src ? (
    <a href={src} target="_blank" rel="noreferrer" className="block w-full h-full">
      <img src={src} alt={alt} className="w-full h-full object-cover" />
    </a>
  ) : null;
}
