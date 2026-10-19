import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchPatrolPlan, fetchPatrolRuns, type PatrolRunDto } from '../api/client';
import { buildOverlay, pickOutRun, type PatrolMapView, type PatrolPlanZones } from '../utils/patrolPlan';
import { patrolStatus } from '../utils/patrolStatus';
import type { PatrolReports } from './usePatrolReports';

/** Where a request stands. A control stays off until its data is in. */
export type Load = 'loading' | 'ready' | 'failed';

const NO_REPORTS: PatrolReports = { run: null, skipped: [], skippedPoints: [], reached: [], checkpoints: 0 };
const NO_RUNS: PatrolRunDto[] = [];
/** The panel lists, and the report offers, the last 30 patrols: what the server keeps (PATROL_KEEP_RUNS). */
const MAX_RUNS = 30;
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Options {
  sn: string;
  sensors?: Record<string, string>;
  /** The Experimental features switch: off, and nothing is fetched or drawn. */
  enabled: boolean;
  /** The patrol panel under the control bar is open. */
  panelOpen: boolean;
  reports?: PatrolReports;
}

export interface PatrolView {
  /** The kept runs, newest first (the last 30). */
  runs: PatrolRunDto[];
  runsLoad: Load;
  runsError: string | null;
  /** The plan changed (a zone was ticked): fetch it again. */
  reloadPlan: () => void;
  /** What the map shows of the patrol (the route, and which driven track goes with it), or null for nothing. */
  view: PatrolMapView | null;
  /** The run the report dialog shows; null while it is closed. */
  reportRun: string | null;
  openReport: (run: string) => void;
  closeReport: () => void;
}

/**
 * What the patrol panel, the report dialog and the map overlay share: the runs
 * the server kept, the plan a start would drive, which run the report shows,
 * and from those what the map draws (`view`: the checkpoints, and the mode, so
 * the shell can pick the driven track that goes with it).
 *
 * The map shows the patrol while the panel is open or a patrol is out:
 * - a report is open: that run, as it ended (done / skipped from its photos and plan);
 * - a patrol is out: its route with the checkpoints reached so far, from the
 *   mower's live reports and the photos on the server;
 * - otherwise: the plan as it stands, every checkpoint pending.
 * Everything from a newer server is optional: no plan, no overlay; no
 * `endedPhase`, a run's ending is just not known.
 */
export function usePatrolView({ sn, sensors, enabled, panelOpen, reports = NO_REPORTS }: Options): PatrolView {
  const { phase, active } = patrolStatus(sensors);
  const [reportRun, setReportRun] = useState<string | null>(null);

  // A report belongs to one mower, and to the switch being on (adjusted while rendering).
  const [seenSn, setSeenSn] = useState(sn);
  if (sn !== seenSn) {
    setSeenSn(sn);
    setReportRun(null);
  }
  if (!enabled && reportRun !== null) setReportRun(null);

  const wantRuns = enabled && (panelOpen || reportRun !== null || active);
  const wantPlan = enabled && (panelOpen || active);

  const [runsState, setRunsState] = useState<{ sn: string; runs: PatrolRunDto[]; load: Load; error: string | null } | null>(null);
  useEffect(() => {
    if (!wantRuns) return;
    let cancelled = false;
    fetchPatrolRuns(sn)
      .then(runs => { if (!cancelled) setRunsState({ sn, runs: runs.slice(0, MAX_RUNS), load: 'ready', error: null }); })
      .catch(e => {
        if (cancelled) return;
        // A refresh that fails keeps the list on screen; only a first load fails outright.
        setRunsState(prev => {
          const mine = prev?.sn === sn ? prev : null;
          return { sn, runs: mine?.runs ?? NO_RUNS, load: mine?.load === 'ready' ? 'ready' : 'failed', error: reasonOf(e) };
        });
      });
    return () => { cancelled = true; };
  }, [sn, wantRuns, phase, reports.checkpoints]);
  const mineRuns = runsState?.sn === sn ? runsState : null;
  const runs = mineRuns?.runs ?? NO_RUNS;

  const [planState, setPlanState] = useState<{ sn: string; plan: PatrolPlanZones | null } | null>(null);
  const [planNonce, setPlanNonce] = useState(0);
  const reloadPlan = useCallback(() => setPlanNonce(n => n + 1), []);
  useEffect(() => {
    if (!wantPlan) return;
    let cancelled = false;
    fetchPatrolPlan(sn)
      .then(plan => { if (!cancelled) setPlanState({ sn, plan }); })
      // No plan means no overlay, which needs no apology: an older server has none.
      .catch(() => { if (!cancelled) setPlanState({ sn, plan: null }); });
    return () => { cancelled = true; };
  }, [sn, wantPlan, planNonce]);
  const currentPlan = planState?.sn === sn ? planState.plan : null;

  const view = useMemo<PatrolMapView | null>(() => {
    if (!enabled) return null;
    if (reportRun !== null) {
      const run = runs.find(r => r.run === reportRun);
      return {
        mode: 'finished',
        run: reportRun,
        overlay: run?.plan
          ? buildOverlay(run.plan, { mode: 'finished', reached: run.frames.map(f => f.seq), endedPhase: run.endedPhase })
          : null,
      };
    }
    if (active) {
      // The run the server says is out; the live reports only count when they are of that run.
      const { run: out, reportsApply } = pickOutRun(runs, reports.run);
      return {
        mode: 'live',
        run: null,
        overlay: buildOverlay(out?.plan ?? currentPlan, {
          mode: 'live',
          phase,
          reached: [...(reportsApply ? reports.reached : []), ...(out?.frames.map(f => f.seq) ?? [])],
          skippedSeqs: reportsApply ? reports.skippedPoints.map(p => p.seq) : [],
          skippedZones: reportsApply ? reports.skipped.map(s => s.zone) : [],
        }),
      };
    }
    return panelOpen ? { mode: 'plan', run: null, overlay: buildOverlay(currentPlan, { mode: 'plan' }) } : null;
  }, [enabled, reportRun, runs, active, phase, reports, currentPlan, panelOpen]);

  const openReport = useCallback((run: string) => setReportRun(run), []);
  const closeReport = useCallback(() => setReportRun(null), []);

  return {
    runs,
    runsLoad: mineRuns?.load ?? 'loading',
    runsError: mineRuns?.error ?? null,
    reloadPlan, view, reportRun, openReport, closeReport,
  };
}
