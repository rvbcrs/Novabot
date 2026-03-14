import { useState, useEffect, useCallback } from 'react';
import {
  Play, Pause, Square, PlugZap, ArrowUp, X, ChevronDown, MapPin,
  Map as MapIcon, Sparkles, RotateCw, Navigation, Settings2,
  Power, Camera, Gauge, Battery, Eye, MoreHorizontal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MapData } from '../../types';
import {
  sendCommand, fetchMaps, startPatrol, stopPatrol, rebootMower,
  setChargeThreshold, setMaxSpeed, previewPath,
} from '../../api/client';
import { useToast } from '../common/Toast';
import { PatternPicker } from '../patterns/PatternPicker';
import { loadPattern, transformToGps, type NormContour } from '../../utils/patternUtils.js';
import { offsetPolygon } from '../../utils/polygonOffset.js';
import type { PatternPlacement } from '../patterns/PatternOverlay';

const DIR_DEGREES = [0, 45, 90, 135, 180, 225, 270, 315];

interface PendingPolygon {
  mapId: string;
  mapName: string;
  mapArea: Array<{ lat: number; lng: number }>;
}

interface Props {
  sn: string;
  online: boolean;
  sensors?: Record<string, string>;
  onPathDirectionChange?: (deg: number | null) => void;
  pendingPolygon?: PendingPolygon | null;
  onStarted?: () => void;
  onPatternPlacementChange?: (placement: PatternPlacement | null) => void;
  onPatternModeChange?: (active: boolean) => void;
  onOffsetPreviewChange?: (preview: Array<{ lat: number; lng: number }> | null) => void;
  patternCenter?: { lat: number; lng: number } | null;
}

export function MowerControls({
  sn, online, sensors, onPathDirectionChange, pendingPolygon, onStarted,
  onPatternPlacementChange, onPatternModeChange, onOffsetPreviewChange, patternCenter,
}: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [mappingExpanded, setMappingExpanded] = useState(false);
  const [maps, setMaps] = useState<MapData[]>([]);
  const [cuttingHeight, setCuttingHeight] = useState(40);
  const [pathDirection, setPathDirection] = useState(0);
  const [mapId, setMapId] = useState('');
  const [mapName, setMapName] = useState('');
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  // Pattern mowing state
  const [patternMode, setPatternMode] = useState(false);
  const [patternId, setPatternId] = useState<number | null>(null);
  const [patternContours, setPatternContours] = useState<NormContour[]>([]);
  const [patternSize, setPatternSize] = useState(15);
  const [patternRotation, setPatternRotation] = useState(0);
  const [edgeOffset, setEdgeOffset] = useState(0);

  // Extended controls state
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const [moreExpanded, setMoreExpanded] = useState(false);
  const [patrolActive, setPatrolActive] = useState(false);
  const [chargeThresholdVal, setChargeThresholdVal] = useState(20);
  const [maxSpeedVal, setMaxSpeedVal] = useState(0.5);
  const [rebootConfirm, setRebootConfirm] = useState(false);

  const isMappingActive = sensors?.start_edit_or_assistant_map_flag === '1';
  const gpsEnabled = sensors?.gps_state === 'ENABLE';
  const locInitialized = sensors?.localization_state === 'INITIALIZED' || sensors?.localization_state === 'Initialized';
  const mappingReady = gpsEnabled && locInitialized;

  const compassLabels = t('controls.compass', { returnObjects: true }) as string[];

  useEffect(() => {
    if (expanded && maps.length === 0) {
      fetchMaps(sn).then(m => setMaps(m.filter(x => x.mapType === 'work' && x.mapArea.length >= 3))).catch(() => {});
    }
  }, [sn, expanded, maps.length]);

  // Auto-expand and select when a pending polygon arrives
  useEffect(() => {
    if (pendingPolygon && online) {
      setExpanded(true);
      setPatternMode(false);
      setMapId(pendingPolygon.mapId);
      setMapName(pendingPolygon.mapName);
      onPathDirectionChange?.(pathDirection);
    }
  }, [pendingPolygon]);

  // Load pattern contours when selection changes
  useEffect(() => {
    if (patternId) {
      loadPattern(patternId).then(setPatternContours).catch(() => setPatternContours([]));
    } else {
      setPatternContours([]);
    }
  }, [patternId]);

  // Update pattern overlay on map whenever placement params change
  useEffect(() => {
    if (patternMode && patternContours.length > 0 && patternCenter) {
      onPatternPlacementChange?.({
        contours: patternContours,
        center: patternCenter,
        sizeMeter: patternSize,
        rotation: patternRotation,
      });
    } else {
      onPatternPlacementChange?.(null);
    }
  }, [patternMode, patternContours, patternCenter, patternSize, patternRotation]);

  // Signal pattern click mode to parent (for map click handler)
  useEffect(() => {
    onPatternModeChange?.(expanded && patternMode && patternId !== null);
  }, [expanded, patternMode, patternId]);

  // Clear pattern overlay when closing
  useEffect(() => {
    if (!expanded) {
      onPatternPlacementChange?.(null);
      onOffsetPreviewChange?.(null);
    }
  }, [expanded]);

  // Update offset preview on map
  useEffect(() => {
    if (!expanded || edgeOffset === 0 || patternMode) {
      onOffsetPreviewChange?.(null);
      return;
    }
    // Get current polygon source
    const poly = pendingPolygon?.mapId === mapId
      ? pendingPolygon.mapArea
      : maps.find(m => m.mapId === mapId)?.mapArea;
    if (poly && poly.length >= 3) {
      onOffsetPreviewChange?.(offsetPolygon(poly, edgeOffset));
    } else {
      onOffsetPreviewChange?.(null);
    }
  }, [expanded, edgeOffset, mapId, patternMode, pendingPolygon, maps]);

  // Auto-clear reboot confirmation after 5s
  useEffect(() => {
    if (!rebootConfirm) return;
    const timer = setTimeout(() => setRebootConfirm(false), 5000);
    return () => clearTimeout(timer);
  }, [rebootConfirm]);

  // Clear reboot confirm when settings closes
  useEffect(() => {
    if (!settingsExpanded) setRebootConfirm(false);
  }, [settingsExpanded]);

  const send = useCallback(async (cmd: Record<string, unknown>, label?: string, refreshPara?: boolean) => {
    setBusy(true);
    try {
      const result = await sendCommand(sn, cmd);
      const cmdName = label || result.command || Object.keys(cmd)[0];
      toast(`✓ ${cmdName}`, 'success');
      if (refreshPara) {
        await sendCommand(sn, { get_para_info: {} }).catch(() => {});
      }
    } catch (err) {
      const cmdName = label || Object.keys(cmd)[0];
      const detail = err instanceof Error ? `: ${err.message}` : '';
      toast(`✗ ${cmdName}${detail}`, 'error');
    }
    setBusy(false);
  }, [sn, t, toast]);

  const handleStart = useCallback(async () => {
    setBusy(true);
    try {
      // Set cutting height + direction first
      await sendCommand(sn, {
        set_para_info: {
          cutGrassHeight: cuttingHeight,
          defaultCuttingHeight: cuttingHeight,
          target_height: cuttingHeight,
          path_direction: pathDirection,
        },
      });

      // Build start_run command
      const startCmd: Record<string, unknown> = {};
      let polySource: Array<{ lat: number; lng: number }> | undefined;

      if (patternMode && patternContours.length > 0 && patternCenter) {
        // Pattern mowing — merge all contours into one workArea
        // Use the first (outer) contour as the primary work area
        polySource = transformToGps(patternContours[0], patternCenter, patternSize, patternRotation);
        startCmd.map_id = `pattern_${patternId}`;
        startCmd.map_name = `Pattern ${patternId}`;
      } else {
        // Normal map mowing
        startCmd.map_id = mapId || '';
        startCmd.map_name = mapName || '';
        polySource = pendingPolygon?.mapId === mapId
          ? pendingPolygon.mapArea
          : maps.find(m => m.mapId === mapId)?.mapArea;
      }

      if (polySource && polySource.length >= 3) {
        const finalPoly = edgeOffset !== 0 ? offsetPolygon(polySource, edgeOffset) : polySource;
        startCmd.workArea = finalPoly.map((p: { lat: number; lng: number }) => ({
          latitude: p.lat,
          longitude: p.lng,
        }));
        startCmd.cutGrassHeight = cuttingHeight;
      }

      const result = await sendCommand(sn, { start_run: startCmd });
      const detail = result.encrypted ? ` (encrypted, ${result.size}B)` : '';
      toast(`✓ ${t('controls.startMowing')}${detail}`, 'success');
      setExpanded(false);
      onPathDirectionChange?.(null);
      onPatternPlacementChange?.(null);
      onStarted?.();
    } catch (err) {
      const detail = err instanceof Error ? `: ${err.message}` : '';
      toast(`✗ ${t('controls.startMowing')}${detail}`, 'error');
    }
    setBusy(false);
  }, [sn, cuttingHeight, pathDirection, edgeOffset, mapId, mapName, maps, pendingPolygon,
    patternMode, patternId, patternContours, patternCenter, patternSize, patternRotation,
    onPathDirectionChange, onPatternPlacementChange, onStarted, t, toast]);

  const disabled = busy || !online;
  const btnBase = 'inline-flex items-center justify-center p-1 sm:p-1.5 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed';
  // Hidden on mobile, shown on desktop — no inline-flex from btnBase to avoid Tailwind display conflict
  const btnHidden = 'hidden md:inline-flex items-center justify-center p-1 sm:p-1.5 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed';

  const [previewing, setPreviewing] = useState(false);

  const handlePreview = useCallback(async () => {
    setPreviewing(true);
    try {
      let polySource: Array<{ lat: number; lng: number }> | undefined;
      if (patternMode && patternContours.length > 0 && patternCenter) {
        polySource = transformToGps(patternContours[0], patternCenter, patternSize, patternRotation);
      } else {
        polySource = pendingPolygon?.mapId === mapId
          ? pendingPolygon.mapArea
          : maps.find(m => m.mapId === mapId)?.mapArea;
      }
      if (!polySource || polySource.length < 3) {
        toast(t('controls.previewNoArea'), 'error');
        setPreviewing(false);
        return;
      }
      const finalPoly = edgeOffset !== 0 ? offsetPolygon(polySource, edgeOffset) : polySource;
      const polygonArea = finalPoly.map(p => ({ latitude: p.lat, longitude: p.lng }));
      await previewPath(sn, polygonArea, pathDirection);
      toast(`✓ ${t('controls.previewPath')}`, 'success');
    } catch (err) {
      const detail = err instanceof Error ? `: ${err.message}` : '';
      toast(`✗ ${t('controls.previewPath')}${detail}`, 'error');
    }
    setPreviewing(false);
  }, [sn, patternMode, patternContours, patternCenter, patternSize, patternRotation,
    pendingPolygon, mapId, maps, edgeOffset, pathDirection, t, toast]);

  const patternReady = patternMode && patternId !== null && patternCenter !== null;

  return (
    <div className="relative">
      {/* Action buttons row */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => {
            const next = !expanded;
            setExpanded(next);
            setSettingsExpanded(false);
            setMappingExpanded(false);
            setMoreExpanded(false);
            onPathDirectionChange?.(next ? pathDirection : null);
          }}
          disabled={disabled}
          className={`inline-flex items-center gap-1 text-xs h-7 px-1.5 sm:px-2.5 rounded transition-colors ${
            expanded
              ? 'bg-emerald-600 text-white'
              : 'bg-gray-700/60 text-gray-400 hover:text-white hover:bg-emerald-700'
          } disabled:opacity-30 disabled:cursor-not-allowed`}
          title={online ? t('controls.startMowing') : t('controls.mowerOffline')}
        >
          <Play className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">{t('controls.start')}</span>
          <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>

        <button
          onClick={() => send({ pause_run: {} }, t('controls.pause'))}
          disabled={disabled}
          className={`${btnBase} bg-gray-700/60 text-yellow-400 hover:bg-yellow-700/40`}
          title={t('controls.pause')}
        >
          <Pause className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={() => send({ resume_run: {} }, t('controls.resume'))}
          disabled={disabled}
          className={`${btnBase} bg-gray-700/60 text-blue-400 hover:bg-blue-700/40`}
          title={t('controls.resume')}
        >
          <Play className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={() => send({ stop_run: {} }, t('controls.stop'))}
          disabled={disabled}
          className={`${btnBase} bg-gray-700/60 text-red-400 hover:bg-red-700/40`}
          title={t('controls.stop')}
        >
          <Square className="w-3.5 h-3.5" />
        </button>

        {/* Secondary buttons — hidden on mobile, inline on desktop */}
        <button
          onClick={() => send({ go_to_charge: {} }, t('controls.goToCharge'))}
          disabled={disabled}
          className={`${btnHidden} bg-gray-700/60 text-yellow-300 hover:bg-yellow-700/40`}
          title={t('controls.goToCharge')}
        >
          <PlugZap className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={async () => {
            setBusy(true);
            try {
              if (patrolActive) {
                await stopPatrol(sn);
                setPatrolActive(false);
                toast(`✓ ${t('controls.stopPatrol')}`, 'success');
              } else {
                await startPatrol(sn);
                setPatrolActive(true);
                toast(`✓ ${t('controls.patrol')}`, 'success');
              }
            } catch (err) {
              const detail = err instanceof Error ? `: ${err.message}` : '';
              toast(`✗ Patrol${detail}`, 'error');
            }
            setBusy(false);
          }}
          disabled={disabled}
          className={`${btnHidden} ${
            patrolActive
              ? 'bg-cyan-600 text-white'
              : 'bg-gray-700/60 text-cyan-400 hover:bg-cyan-700/40'
          }`}
          title={patrolActive ? t('controls.stopPatrol') : t('controls.patrol')}
        >
          <Navigation className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={() => { setMappingExpanded(!mappingExpanded); setExpanded(false); setSettingsExpanded(false); setMoreExpanded(false); }}
          disabled={disabled}
          className={`${btnHidden} ${
            mappingExpanded || isMappingActive
              ? 'bg-purple-600 text-white'
              : 'bg-gray-700/60 text-purple-400 hover:bg-purple-700/40'
          }`}
          title={t('controls.mapping')}
        >
          <MapIcon className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={() => { setSettingsExpanded(!settingsExpanded); setExpanded(false); setMappingExpanded(false); setMoreExpanded(false); }}
          disabled={disabled}
          className={`${btnHidden} ${
            settingsExpanded
              ? 'bg-gray-600 text-white'
              : 'bg-gray-700/60 text-gray-400 hover:text-white'
          }`}
          title={t('controls.extendedSettings')}
        >
          <Settings2 className="w-3.5 h-3.5" />
        </button>

        {/* More button — mobile only */}
        <div className="relative md:hidden">
          <button
            onClick={() => { setMoreExpanded(!moreExpanded); setExpanded(false); setMappingExpanded(false); setSettingsExpanded(false); }}
            disabled={disabled}
            className={`${btnBase} ${moreExpanded ? 'bg-gray-600 text-white' : 'bg-gray-700/60 text-gray-400 hover:text-white'}`}
            title={t('controls.more')}
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
          {moreExpanded && (
            <>
              <div className="fixed inset-0 z-[9998]" onClick={() => setMoreExpanded(false)} />
              <div className="absolute top-full right-0 mt-1 w-48 z-[10000] bg-gray-800 rounded-lg border border-gray-700 shadow-xl py-1">
                <button
                  onClick={() => { setMoreExpanded(false); send({ go_to_charge: {} }, t('controls.goToCharge')); }}
                  disabled={disabled}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-yellow-300 hover:bg-gray-700/50 transition-colors disabled:opacity-30"
                >
                  <PlugZap className="w-3.5 h-3.5" />
                  {t('controls.goToCharge')}
                </button>
                <button
                  onClick={async () => {
                    setMoreExpanded(false);
                    setBusy(true);
                    try {
                      if (patrolActive) {
                        await stopPatrol(sn);
                        setPatrolActive(false);
                        toast(`✓ ${t('controls.stopPatrol')}`, 'success');
                      } else {
                        await startPatrol(sn);
                        setPatrolActive(true);
                        toast(`✓ ${t('controls.patrol')}`, 'success');
                      }
                    } catch (err) {
                      const detail = err instanceof Error ? `: ${err.message}` : '';
                      toast(`✗ Patrol${detail}`, 'error');
                    }
                    setBusy(false);
                  }}
                  disabled={disabled}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors disabled:opacity-30 ${
                    patrolActive ? 'text-cyan-300 bg-cyan-900/20' : 'text-gray-300 hover:bg-gray-700/50'
                  }`}
                >
                  <Navigation className="w-3.5 h-3.5" />
                  {patrolActive ? t('controls.stopPatrol') : t('controls.patrol')}
                </button>
                <button
                  onClick={() => { setMoreExpanded(false); setMappingExpanded(!mappingExpanded); setExpanded(false); setSettingsExpanded(false); }}
                  disabled={disabled}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors disabled:opacity-30 ${
                    mappingExpanded || isMappingActive ? 'text-purple-300 bg-purple-900/20' : 'text-gray-300 hover:bg-gray-700/50'
                  }`}
                >
                  <MapIcon className="w-3.5 h-3.5" />
                  {t('controls.mapping')}
                </button>
                <button
                  onClick={() => { setMoreExpanded(false); setSettingsExpanded(!settingsExpanded); setExpanded(false); setMappingExpanded(false); }}
                  disabled={disabled}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors disabled:opacity-30 ${
                    settingsExpanded ? 'text-white bg-gray-700/30' : 'text-gray-300 hover:bg-gray-700/50'
                  }`}
                >
                  <Settings2 className="w-3.5 h-3.5" />
                  {t('controls.extendedSettings')}
                </button>
              </div>
            </>
          )}
        </div>

      </div>

      {/* Expanded start settings dropdown */}
      {expanded && (
        <div className="absolute top-full right-0 mt-1 w-[calc(100vw-1rem)] sm:w-72 z-[10000] bg-gray-800 rounded-lg border border-gray-700 shadow-xl overflow-hidden">
          <div className="p-3 space-y-3">

            {/* Mode toggle: Map area / Pattern */}
            <div className="flex rounded-md overflow-hidden border border-gray-700">
              <button
                onClick={() => setPatternMode(false)}
                className={`flex-1 text-[10px] py-1.5 flex items-center justify-center gap-1 transition-colors ${
                  !patternMode ? 'bg-emerald-600 text-white font-medium' : 'bg-gray-900 text-gray-500 hover:text-gray-300'
                }`}
              >
                <MapPin className="w-3 h-3" />
                {t('pattern.mapMode')}
              </button>
              <button
                onClick={() => setPatternMode(true)}
                className={`flex-1 text-[10px] py-1.5 flex items-center justify-center gap-1 transition-colors ${
                  patternMode ? 'bg-purple-600 text-white font-medium' : 'bg-gray-900 text-gray-500 hover:text-gray-300'
                }`}
              >
                <Sparkles className="w-3 h-3" />
                {t('pattern.patternMode')}
              </button>
            </div>

            {/* ── Pattern mode ── */}
            {patternMode ? (
              <>
                <PatternPicker
                  selected={patternId}
                  onSelect={setPatternId}
                />

                {patternId && !patternCenter && (
                  <div className="text-[10px] text-purple-300 bg-purple-900/20 border border-purple-800/30 rounded px-2 py-1.5 flex items-center gap-1.5">
                    <MapPin className="w-3 h-3 flex-shrink-0" />
                    {t('pattern.clickToPlace')}
                  </div>
                )}

                {patternId && patternCenter && (
                  <>
                    {/* Size slider */}
                    <div>
                      <div className="flex items-center justify-between">
                        <label className="text-[9px] text-gray-500 uppercase tracking-wide">{t('pattern.size')}</label>
                        <span className="text-[11px] text-gray-300 font-mono">{patternSize}m</span>
                      </div>
                      <input
                        type="range" min={3} max={60} step={1}
                        value={patternSize}
                        onChange={e => setPatternSize(parseInt(e.target.value))}
                        className="w-full h-1.5 mt-1 accent-purple-500 bg-gray-700 rounded-full appearance-none cursor-pointer"
                      />
                      <div className="flex justify-between text-[8px] text-gray-600 mt-0.5">
                        <span>3m</span><span>60m</span>
                      </div>
                    </div>

                    {/* Rotation slider */}
                    <div>
                      <div className="flex items-center justify-between">
                        <label className="text-[9px] text-gray-500 uppercase tracking-wide">{t('pattern.rotation')}</label>
                        <span className="text-[11px] text-gray-300 font-mono inline-flex items-center gap-1">
                          <RotateCw className="w-3 h-3" style={{ transform: `rotate(${patternRotation}deg)` }} />
                          {patternRotation}&deg;
                        </span>
                      </div>
                      <input
                        type="range" min={0} max={360} step={5}
                        value={patternRotation}
                        onChange={e => setPatternRotation(parseInt(e.target.value))}
                        className="w-full h-1.5 mt-1 accent-purple-500 bg-gray-700 rounded-full appearance-none cursor-pointer"
                      />
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                {/* ── Normal map mode ── */}
                {pendingPolygon && mapId === pendingPolygon.mapId ? (
                  <div>
                    <label className="text-[9px] text-gray-500 uppercase tracking-wide">{t('controls.workArea')}</label>
                    <div className="mt-1 flex items-center gap-2 bg-emerald-900/30 border border-emerald-700/50 rounded px-2 py-1.5">
                      <MapPin className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-emerald-300 font-medium truncate">{pendingPolygon.mapName}</div>
                        <div className="text-[10px] text-emerald-400/70">
                          {pendingPolygon.mapArea.length} {t('controls.points')}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : maps.length > 0 && (
                  <div>
                    <label className="text-[9px] text-gray-500 uppercase tracking-wide">{t('controls.workArea')}</label>
                    <select
                      value={mapId}
                      onChange={e => {
                        const m = maps.find(x => x.mapId === e.target.value);
                        setMapId(e.target.value);
                        setMapName(m?.mapName ?? '');
                      }}
                      className="mt-1 w-full text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500"
                    >
                      <option value="">{t('controls.allWorkAreas')}</option>
                      {maps.map(m => (
                        <option key={m.mapId} value={m.mapId}>{m.mapName || m.mapId}</option>
                      ))}
                    </select>
                  </div>
                )}
              </>
            )}

            {/* Cutting height (both modes) */}
            <div>
              <div className="flex items-center justify-between">
                <label className="text-[9px] text-gray-500 uppercase tracking-wide">{t('controls.cuttingHeight')}</label>
                <span className="text-[11px] text-gray-300 font-mono">{(cuttingHeight / 10).toFixed(1)} cm</span>
              </div>
              <input
                type="range" min={20} max={80} step={5}
                value={cuttingHeight}
                onChange={e => setCuttingHeight(parseInt(e.target.value))}
                className="w-full h-1.5 mt-1 accent-emerald-500 bg-gray-700 rounded-full appearance-none cursor-pointer"
              />
              <div className="flex justify-between text-[8px] text-gray-600 mt-0.5">
                <span>2 cm</span><span>8 cm</span>
              </div>
            </div>

            {/* Edge offset (map mode only) */}
            {!patternMode && (
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-[9px] text-gray-500 uppercase tracking-wide">{t('controls.edgeOffset')}</label>
                  <span className={`text-[11px] font-mono ${edgeOffset === 0 ? 'text-gray-500' : edgeOffset > 0 ? 'text-blue-300' : 'text-orange-300'}`}>
                    {edgeOffset > 0 ? '+' : ''}{edgeOffset.toFixed(2)}m
                  </span>
                </div>
                <input
                  type="range" min={-0.5} max={0.5} step={0.05}
                  value={edgeOffset}
                  onChange={e => setEdgeOffset(parseFloat(e.target.value))}
                  className="w-full h-1.5 mt-1 accent-blue-500 bg-gray-700 rounded-full appearance-none cursor-pointer"
                />
                <div className="flex justify-between text-[8px] text-gray-600 mt-0.5">
                  <span>{t('controls.edgeOffsetShrink')}</span>
                  <span className="text-gray-700">|</span>
                  <span>{t('controls.edgeOffsetExpand')}</span>
                </div>
              </div>
            )}

            {/* Path direction (both modes) */}
            <div>
              <div className="flex items-center justify-between">
                <label className="text-[9px] text-gray-500 uppercase tracking-wide">{t('controls.pathDirection')}</label>
                <span className="text-[11px] text-gray-300 font-mono inline-flex items-center gap-1">
                  <ArrowUp className="w-3 h-3 transition-transform" style={{ transform: `rotate(${pathDirection}deg)` }} />
                  {pathDirection}&deg;
                </span>
              </div>
              <div className="grid grid-cols-4 sm:grid-cols-4 gap-0.5 sm:gap-1 mt-1 mb-1">
                {DIR_DEGREES.map((deg, i) => (
                  <button
                    key={deg}
                    onClick={() => { setPathDirection(deg); onPathDirectionChange?.(deg); }}
                    className={`text-[9px] py-1 rounded transition-colors ${
                      pathDirection === deg
                        ? 'bg-blue-600 text-white font-medium'
                        : 'bg-gray-900 text-gray-500 hover:text-gray-300 border border-gray-700'
                    }`}
                  >
                    {compassLabels[i]}
                  </button>
                ))}
              </div>
              <input
                type="range" min={0} max={360} step={5}
                value={pathDirection}
                onChange={e => {
                  const v = parseInt(e.target.value);
                  setPathDirection(v);
                  onPathDirectionChange?.(v);
                }}
                className="w-full h-1.5 accent-blue-500 bg-gray-700 rounded-full appearance-none cursor-pointer"
              />
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 pt-2 border-t border-gray-700">
              <button
                onClick={() => { setExpanded(false); onPathDirectionChange?.(null); onPatternPlacementChange?.(null); }}
                className="inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
              <button
                onClick={handlePreview}
                disabled={previewing || busy}
                className="inline-flex items-center justify-center gap-1 text-xs px-2 py-2 rounded text-blue-300 bg-blue-900/40 hover:bg-blue-800/50 transition-colors disabled:opacity-40"
                title={t('controls.previewPath')}
              >
                <Eye className="w-3.5 h-3.5" />
                {previewing ? '...' : t('controls.preview')}
              </button>
              <button
                onClick={handleStart}
                disabled={busy || (patternMode && !patternReady)}
                className={`flex-1 inline-flex items-center justify-center gap-1 text-xs px-2 py-2 rounded text-white transition-colors font-medium disabled:opacity-40 ${
                  patternMode ? 'bg-purple-600 hover:bg-purple-500' : 'bg-emerald-600 hover:bg-emerald-500'
                }`}
              >
                {patternMode ? <Sparkles className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                {busy ? t('controls.busy') : patternMode ? t('pattern.startPattern') : t('controls.startMowing')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mapping dropdown */}
      {mappingExpanded && !isMappingActive && (
        <div className="absolute top-full right-0 mt-1 w-[calc(100vw-1rem)] sm:w-64 z-[10000] bg-gray-800 rounded-lg border border-gray-700 shadow-xl p-3 space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs">
              <span className={`w-2 h-2 rounded-full ${gpsEnabled ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-gray-400">{t('controls.gpsStatus')}: {gpsEnabled ? t('controls.gpsEnabled') : t('controls.gpsDisabled')}</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className={`w-2 h-2 rounded-full ${locInitialized ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-gray-400">{t('controls.locStatus')}: {sensors?.localization_state ?? '?'}</span>
            </div>
          </div>

          {!mappingReady && (
            <div className="text-[10px] text-amber-400 bg-amber-900/20 border border-amber-800/30 rounded px-2 py-1.5">
              {t('controls.mappingNotReady')}
            </div>
          )}

          <button
            onClick={() => { send({ start_assistant_build_map: {} }, t('controls.startMapping')); setMappingExpanded(false); }}
            disabled={busy}
            className="w-full text-xs px-3 py-2 rounded bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-40 font-medium"
          >
            {busy ? t('controls.busy') : t('controls.startAutonomousMapping')}
          </button>
        </div>
      )}

      {/* Extended settings dropdown */}
      {settingsExpanded && (
        <div className="absolute top-full right-0 mt-1 w-[calc(100vw-1rem)] sm:w-64 z-[10000] bg-gray-800 rounded-lg border border-gray-700 shadow-xl p-3 space-y-3">
          {/* Max speed */}
          <div>
            <div className="flex items-center justify-between">
              <label className="text-[9px] text-gray-500 uppercase tracking-wide flex items-center gap-1">
                <Gauge className="w-3 h-3" />
                {t('controls.maxSpeed')}
              </label>
              <span className="text-[11px] text-gray-300 font-mono">{maxSpeedVal.toFixed(1)} m/s</span>
            </div>
            <input
              type="range" min={0.1} max={1.0} step={0.1}
              value={maxSpeedVal}
              onChange={e => setMaxSpeedVal(parseFloat(e.target.value))}
              className="w-full h-1.5 mt-1 accent-blue-500 bg-gray-700 rounded-full appearance-none cursor-pointer"
            />
            <div className="flex justify-between text-[8px] text-gray-600 mt-0.5">
              <span>0.1</span><span>1.0 m/s</span>
            </div>
            <button
              onClick={async () => {
                setBusy(true);
                try {
                  await setMaxSpeed(sn, maxSpeedVal);
                  toast(`✓ ${t('controls.maxSpeed')}: ${maxSpeedVal.toFixed(1)} m/s`, 'success');
                } catch { toast(`✗ ${t('controls.maxSpeed')}`, 'error'); }
                setBusy(false);
              }}
              disabled={busy}
              className="w-full mt-1.5 text-[10px] py-1 rounded bg-blue-700/40 text-blue-300 hover:bg-blue-700/60 transition-colors disabled:opacity-40"
            >
              {t('controls.apply')}
            </button>
          </div>

          <div className="border-t border-gray-700" />

          {/* Charge threshold */}
          <div>
            <div className="flex items-center justify-between">
              <label className="text-[9px] text-gray-500 uppercase tracking-wide flex items-center gap-1">
                <Battery className="w-3 h-3" />
                {t('controls.chargeThreshold')}
              </label>
              <span className="text-[11px] text-gray-300 font-mono">{chargeThresholdVal}%</span>
            </div>
            <input
              type="range" min={10} max={50} step={5}
              value={chargeThresholdVal}
              onChange={e => setChargeThresholdVal(parseInt(e.target.value))}
              className="w-full h-1.5 mt-1 accent-yellow-500 bg-gray-700 rounded-full appearance-none cursor-pointer"
            />
            <div className="flex justify-between text-[8px] text-gray-600 mt-0.5">
              <span>10%</span><span>50%</span>
            </div>
            <button
              onClick={async () => {
                setBusy(true);
                try {
                  await setChargeThreshold(sn, chargeThresholdVal);
                  toast(`✓ ${t('controls.chargeThreshold')}: ${chargeThresholdVal}%`, 'success');
                } catch { toast(`✗ ${t('controls.chargeThreshold')}`, 'error'); }
                setBusy(false);
              }}
              disabled={busy}
              className="w-full mt-1.5 text-[10px] py-1 rounded bg-yellow-700/40 text-yellow-300 hover:bg-yellow-700/60 transition-colors disabled:opacity-40"
            >
              {t('controls.apply')}
            </button>
          </div>

          <div className="border-t border-gray-700" />

          {/* Quick actions */}
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={async () => {
                setBusy(true);
                try {
                  const resp = await fetch(`/api/dashboard/camera/${encodeURIComponent(sn)}/snapshot`);
                  if (!resp.ok) throw new Error(resp.statusText);
                  const blob = await resp.blob();
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `snapshot_${sn}_${Date.now()}.jpg`;
                  a.click();
                  URL.revokeObjectURL(url);
                  toast(`✓ ${t('controls.snapshot')}`, 'success');
                } catch { toast(`✗ ${t('controls.snapshot')}`, 'error'); }
                setBusy(false);
              }}
              disabled={busy}
              className="flex items-center justify-center gap-1 text-[10px] py-2 rounded bg-cyan-900/40 text-cyan-300 hover:bg-cyan-800/50 transition-colors disabled:opacity-40"
            >
              <Camera className="w-3 h-3" />
              {t('controls.snapshot')}
            </button>

            {!rebootConfirm ? (
              <button
                onClick={() => setRebootConfirm(true)}
                disabled={busy}
                className="flex items-center justify-center gap-1 text-[10px] py-2 rounded bg-red-900/40 text-red-300 hover:bg-red-800/50 transition-colors disabled:opacity-40"
              >
                <Power className="w-3 h-3" />
                {t('controls.reboot')}
              </button>
            ) : (
              <button
                onClick={async () => {
                  setBusy(true);
                  try {
                    await rebootMower(sn);
                    toast(`✓ ${t('controls.rebootSent')}`, 'success');
                  } catch { toast(`✗ ${t('controls.reboot')}`, 'error'); }
                  setRebootConfirm(false);
                  setBusy(false);
                }}
                disabled={busy}
                className="flex items-center justify-center gap-1 text-[10px] py-2 rounded bg-red-600 text-white hover:bg-red-500 transition-colors disabled:opacity-40 animate-pulse"
              >
                <Power className="w-3 h-3" />
                {t('controls.confirmReboot')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
