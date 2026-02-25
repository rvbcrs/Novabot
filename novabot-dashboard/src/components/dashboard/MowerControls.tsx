import { useState, useEffect, useCallback } from 'react';
import {
  Play, Pause, Square, PlugZap, ArrowUp, X, ChevronDown,
} from 'lucide-react';
import type { MapData } from '../../types';
import { sendCommand, fetchMaps } from '../../api/client';

const DIR_PRESETS = [
  { label: 'N–Z', deg: 0 },
  { label: 'NO–ZW', deg: 45 },
  { label: 'O–W', deg: 90 },
  { label: 'ZO–NW', deg: 135 },
];

interface Props {
  sn: string;
  online: boolean;
  onPathDirectionChange?: (deg: number | null) => void;
}

export function MowerControls({ sn, online, onPathDirectionChange }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [maps, setMaps] = useState<MapData[]>([]);
  const [cuttingHeight, setCuttingHeight] = useState(40);
  const [pathDirection, setPathDirection] = useState(0);
  const [mapId, setMapId] = useState('');
  const [mapName, setMapName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (expanded && maps.length === 0) {
      fetchMaps(sn).then(m => setMaps(m.filter(x => x.mapArea.length >= 3))).catch(() => {});
    }
  }, [sn, expanded, maps.length]);

  const send = useCallback(async (cmd: Record<string, unknown>) => {
    setBusy(true);
    try { await sendCommand(sn, cmd); } catch { /* ignore */ }
    setBusy(false);
  }, [sn]);

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
      // Then send start command
      await sendCommand(sn, {
        start_run: {
          map_id: mapId || '',
          map_name: mapName || '',
        },
      });
      setExpanded(false);
      onPathDirectionChange?.(null);
    } catch { /* ignore */ }
    setBusy(false);
  }, [sn, cuttingHeight, pathDirection, mapId, mapName, onPathDirectionChange]);

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
          title={online ? 'Start maaien' : 'Mower offline'}
        >
          <Play className="w-3.5 h-3.5" />
          Start
          <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>

        <button
          onClick={() => send({ pause_run: {} })}
          disabled={disabled}
          className={`${btnBase} bg-gray-700/60 text-yellow-400 hover:bg-yellow-700/40`}
          title="Pauzeer"
        >
          <Pause className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={() => send({ resume_run: {} })}
          disabled={disabled}
          className={`${btnBase} bg-gray-700/60 text-blue-400 hover:bg-blue-700/40`}
          title="Hervat"
        >
          <Play className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={() => send({ stop_run: {} })}
          disabled={disabled}
          className={`${btnBase} bg-gray-700/60 text-red-400 hover:bg-red-700/40`}
          title="Stop"
        >
          <Square className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={() => send({ go_to_charge: {} })}
          disabled={disabled}
          className={`${btnBase} bg-gray-700/60 text-yellow-300 hover:bg-yellow-700/40`}
          title="Naar laadstation"
        >
          <PlugZap className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Expanded start settings dropdown */}
      {expanded && (
        <div className="absolute top-full right-0 mt-1 w-72 z-[10000] bg-gray-800 rounded-lg border border-gray-700 shadow-xl overflow-hidden">
          <div className="p-3 space-y-3">
            {/* Map selection */}
            {maps.length > 0 && (
              <div>
                <label className="text-[9px] text-gray-500 uppercase tracking-wide">Werkgebied</label>
                <select
                  value={mapId}
                  onChange={e => {
                    const m = maps.find(x => x.mapId === e.target.value);
                    setMapId(e.target.value);
                    setMapName(m?.mapName ?? '');
                  }}
                  className="mt-1 w-full text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500"
                >
                  <option value="">Alle werkgebieden</option>
                  {maps.map(m => (
                    <option key={m.mapId} value={m.mapId}>{m.mapName || m.mapId}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Cutting height */}
            <div>
              <div className="flex items-center justify-between">
                <label className="text-[9px] text-gray-500 uppercase tracking-wide">Maaihoogte</label>
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
                <label className="text-[9px] text-gray-500 uppercase tracking-wide">Maairichting</label>
                <span className="text-[11px] text-gray-300 font-mono inline-flex items-center gap-1">
                  <ArrowUp className="w-3 h-3 transition-transform" style={{ transform: `rotate(${pathDirection}deg)` }} />
                  {pathDirection}&deg;
                </span>
              </div>
              <div className="flex gap-1 mt-1 mb-1">
                {DIR_PRESETS.map(p => (
                  <button
                    key={p.deg}
                    onClick={() => { setPathDirection(p.deg); onPathDirectionChange?.(p.deg); }}
                    className={`flex-1 text-[10px] py-1 rounded transition-colors ${
                      pathDirection === p.deg
                        ? 'bg-blue-600 text-white font-medium'
                        : 'bg-gray-900 text-gray-500 hover:text-gray-300 border border-gray-700'
                    }`}
                  >
                    {p.label}
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
                Annuleer
              </button>
              <button
                onClick={handleStart}
                disabled={busy}
                className="flex-1 inline-flex items-center justify-center gap-1 text-xs px-2 py-2 rounded bg-emerald-600 text-white hover:bg-emerald-500 transition-colors font-medium disabled:opacity-40"
              >
                <Play className="w-3.5 h-3.5" />
                {busy ? 'Bezig...' : 'Start maaien'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
