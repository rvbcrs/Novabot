import { useState, useEffect, useCallback } from 'react';
import {
  Play, Pause, Square, PlugZap, ArrowUp, X, ChevronDown, MapPin,
  Map as MapIcon, Lightbulb, Volume2, VolumeX,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MapData } from '../../types';
import { sendCommand, fetchMaps } from '../../api/client';
import { useToast } from '../common/Toast';

const DIR_DEGREES = [0, 45, 90, 135];

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
}

export function MowerControls({ sn, online, sensors, onPathDirectionChange, pendingPolygon, onStarted }: Props) {
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

  const [headlightLocal, setHeadlightLocal] = useState(false);

  const isMappingActive = sensors?.start_edit_or_assistant_map_flag === '1';
  const gpsEnabled = sensors?.gps_state === 'ENABLE';
  const locInitialized = sensors?.localization_state === 'INITIALIZED';
  const mappingReady = gpsEnabled && locInitialized;

  // Headlight state: server tracked via headlight_active (gezet door dashboard.ts bij led_set commando)
  // Lokale state voor optimistische toggle (direct visueel feedback bij klik)
  const serverHeadlight = sensors?.headlight_active === '2';
  useEffect(() => { setHeadlightLocal(serverHeadlight); }, [serverHeadlight]);
  const headlightOn = headlightLocal;
  const soundOn = sensors?.sound === '2';

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
      setMapId(pendingPolygon.mapId);
      setMapName(pendingPolygon.mapName);
      onPathDirectionChange?.(pathDirection);
    }
  }, [pendingPolygon]);

  const send = useCallback(async (cmd: Record<string, unknown>, label?: string, refreshPara?: boolean) => {
    setBusy(true);
    try {
      const result = await sendCommand(sn, cmd);
      const cmdName = label || result.command || Object.keys(cmd)[0];
      toast(`✓ ${cmdName}`, 'success');
      // Herlaad para state zodat toggles direct bijwerken
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

      // Build start_run command — include polygon GPS coordinates if available
      const startCmd: Record<string, unknown> = {
        map_id: mapId || '',
        map_name: mapName || '',
      };

      // Find polygon coordinates: pending polygon or selected map
      const polySource = pendingPolygon?.mapId === mapId
        ? pendingPolygon.mapArea
        : maps.find(m => m.mapId === mapId)?.mapArea;

      if (polySource && polySource.length >= 3) {
        startCmd.workArea = polySource.map(p => ({
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
      onStarted?.();
    } catch (err) {
      const detail = err instanceof Error ? `: ${err.message}` : '';
      toast(`✗ ${t('controls.startMowing')}${detail}`, 'error');
    }
    setBusy(false);
  }, [sn, cuttingHeight, pathDirection, mapId, mapName, maps, pendingPolygon, onPathDirectionChange, onStarted, t, toast]);

  const disabled = busy || !online;
  const btnBase = 'inline-flex items-center justify-center p-1.5 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed';

  return (
    <div className="relative">
      {/* Action buttons row */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => {
            const next = !expanded;
            setExpanded(next);
            onPathDirectionChange?.(next ? pathDirection : null);
          }}
          disabled={disabled}
          className={`inline-flex items-center gap-1 text-xs h-7 px-2.5 rounded transition-colors ${
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

        <button
          onClick={() => send({ go_to_charge: {} }, t('controls.goToCharge'))}
          disabled={disabled}
          className={`${btnBase} bg-gray-700/60 text-yellow-300 hover:bg-yellow-700/40`}
          title={t('controls.goToCharge')}
        >
          <PlugZap className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={() => { setMappingExpanded(!mappingExpanded); setExpanded(false); }}
          disabled={disabled}
          className={`${btnBase} ${
            mappingExpanded || isMappingActive
              ? 'bg-purple-600 text-white'
              : 'bg-gray-700/60 text-purple-400 hover:bg-purple-700/40'
          }`}
          title={t('controls.mapping')}
        >
          <MapIcon className="w-3.5 h-3.5" />
        </button>

        {/* Divider */}
        <div className="w-px h-5 bg-gray-700/60" />

        {/* Headlight toggle */}
        <button
          onClick={() => {
            const next = !headlightOn;
            setHeadlightLocal(next);
            send({ set_para_info: { headlight: next ? 2 : 0 } }, t(next ? 'controls.headlightOn' : 'controls.headlightOff'));
          }}
          disabled={disabled}
          className={`${btnBase} ${
            headlightOn
              ? 'bg-yellow-500/30 text-yellow-300 ring-1 ring-yellow-500/50'
              : 'bg-gray-700/60 text-gray-500 hover:text-yellow-300 hover:bg-yellow-700/30'
          }`}
          title={t('controls.headlight')}
        >
          <Lightbulb className="w-3.5 h-3.5" />
        </button>

        {/* Sound toggle */}
        <button
          onClick={() => send({ set_para_info: { sound: soundOn ? 0 : 2 } }, t('controls.sound'), true)}
          disabled={disabled}
          className={`${btnBase} ${
            soundOn
              ? 'bg-blue-500/30 text-blue-300 ring-1 ring-blue-500/50'
              : 'bg-gray-700/60 text-gray-500 hover:text-blue-300 hover:bg-blue-700/30'
          }`}
          title={t('controls.sound')}
        >
          {soundOn ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* Expanded start settings dropdown */}
      {expanded && (
        <div className="absolute top-full right-0 mt-1 w-72 max-w-[calc(100vw-1rem)] z-[10000] bg-gray-800 rounded-lg border border-gray-700 shadow-xl overflow-hidden">
          <div className="p-3 space-y-3">
            {/* Map selection — show pending polygon or dropdown */}
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

            {/* Cutting height */}
            <div>
              <div className="flex items-center justify-between">
                <label className="text-[9px] text-gray-500 uppercase tracking-wide">{t('controls.cuttingHeight')}</label>
                <span className="text-[11px] text-gray-300 font-mono">{(cuttingHeight / 10).toFixed(1)} cm</span>
              </div>
              <input
                type="range"
                min={20}
                max={80}
                step={5}
                value={cuttingHeight}
                onChange={e => setCuttingHeight(parseInt(e.target.value))}
                className="w-full h-1.5 mt-1 accent-emerald-500 bg-gray-700 rounded-full appearance-none cursor-pointer"
              />
              <div className="flex justify-between text-[8px] text-gray-600 mt-0.5">
                <span>2 cm</span>
                <span>8 cm</span>
              </div>
            </div>

            {/* Path direction */}
            <div>
              <div className="flex items-center justify-between">
                <label className="text-[9px] text-gray-500 uppercase tracking-wide">{t('controls.pathDirection')}</label>
                <span className="text-[11px] text-gray-300 font-mono inline-flex items-center gap-1">
                  <ArrowUp className="w-3 h-3 transition-transform" style={{ transform: `rotate(${pathDirection}deg)` }} />
                  {pathDirection}&deg;
                </span>
              </div>
              <div className="flex gap-1 mt-1 mb-1">
                {DIR_DEGREES.map((deg, i) => (
                  <button
                    key={deg}
                    onClick={() => { setPathDirection(deg); onPathDirectionChange?.(deg); }}
                    className={`flex-1 text-[10px] py-1 rounded transition-colors ${
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
                type="range"
                min={0}
                max={180}
                step={5}
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
                onClick={() => { setExpanded(false); onPathDirectionChange?.(null); }}
                className="flex-1 inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
              >
                <X className="w-3 h-3" />
                {t('common.cancel')}
              </button>
              <button
                onClick={handleStart}
                disabled={busy}
                className="flex-1 inline-flex items-center justify-center gap-1 text-xs px-2 py-2 rounded bg-emerald-600 text-white hover:bg-emerald-500 transition-colors font-medium disabled:opacity-40"
              >
                <Play className="w-3.5 h-3.5" />
                {busy ? t('controls.busy') : t('controls.startMowing')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mapping dropdown */}
      {mappingExpanded && !isMappingActive && (
        <div className="absolute top-full right-0 mt-1 w-64 max-w-[calc(100vw-1rem)] z-[10000] bg-gray-800 rounded-lg border border-gray-700 shadow-xl p-3 space-y-3">
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
    </div>
  );
}
