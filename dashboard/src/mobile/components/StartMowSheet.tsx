import { useState, useEffect, useRef, type TouchEvent as ReactTouchEvent } from 'react';
import { Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MapData } from '../../types';
import { sendCommand, fetchMaps } from '../../api/client';
import { useToast } from '../../components/common/Toast';

interface Props {
  open: boolean;
  onClose: () => void;
  sn: string;
  onStarted: () => void;
  initialMapId?: string | null;
}

export function StartMowSheet({ open, onClose, sn, onStarted, initialMapId = null }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [starting, setStarting] = useState(false);

  // Form state
  const [cuttingHeight, setCuttingHeight] = useState(40);
  const [pathDirection, setPathDirection] = useState(0);
  const [mapId, setMapId] = useState<string | null>(null);
  const [maps, setMaps] = useState<MapData[]>([]);

  // Swipe-to-dismiss
  const sheetRef = useRef<HTMLDivElement>(null);
  const startY = useRef(0);
  const currentY = useRef(0);

  // Load maps when opening
  useEffect(() => {
    if (!open || !sn) return;
    fetchMaps(sn).then(setMaps).catch(() => {});
    // Reset to defaults (pre-select area if provided)
    setCuttingHeight(40);
    setPathDirection(0);
    setMapId(initialMapId ?? null);
  }, [open, sn]);

  const handleStart = async () => {
    setStarting(true);
    try {
      // 1. Set cutting height + direction
      await sendCommand(sn, {
        set_para_info: {
          cutGrassHeight: cuttingHeight,
          defaultCuttingHeight: cuttingHeight,
          target_height: cuttingHeight,
          path_direction: pathDirection,
        },
      });

      // 2. Build start_run command
      const startCmd: Record<string, unknown> = {};
      if (mapId) {
        const selectedMap = maps.find(m => m.mapId === mapId);
        startCmd.map_id = mapId;
        startCmd.map_name = selectedMap?.mapName ?? '';
        if (selectedMap?.mapArea && selectedMap.mapArea.length >= 3) {
          startCmd.workArea = selectedMap.mapArea.map(p => ({
            latitude: p.lat,
            longitude: p.lng,
          }));
          startCmd.cutGrassHeight = cuttingHeight;
        }
      }

      await sendCommand(sn, { start_run: startCmd });
      toast(`${t('mobile.startMowing')} ✓`, 'success');
      onStarted();
      onClose();
    } catch {
      toast(`${t('mobile.startMowing')} failed`, 'error');
    }
    setStarting(false);
  };

  // Touch handlers
  const onTouchStart = (e: ReactTouchEvent) => {
    startY.current = e.touches[0].clientY;
    currentY.current = 0;
  };
  const onTouchMove = (e: ReactTouchEvent) => {
    const dy = e.touches[0].clientY - startY.current;
    currentY.current = Math.max(0, dy);
    if (sheetRef.current) {
      sheetRef.current.style.transform = `translateY(${currentY.current}px)`;
    }
  };
  const onTouchEnd = () => {
    if (currentY.current > 100) {
      onClose();
    }
    if (sheetRef.current) {
      sheetRef.current.style.transform = '';
    }
  };

  if (!open) return null;

  const workMaps = maps.filter(m => m.mapType === 'work');

  return (
    <div className="fixed inset-0 z-[9998]">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Sheet */}
      <div
        ref={sheetRef}
        className="absolute bottom-0 left-0 right-0 bg-white dark:bg-gray-900
                   rounded-t-2xl shadow-2xl animate-slide-up max-h-[80vh] flex flex-col"
      >
        {/* Drag handle */}
        <div
          className="flex justify-center py-3 cursor-grab"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          <div className="w-10 h-1 rounded-full bg-gray-300 dark:bg-gray-700" />
        </div>

        {/* Scrollable form */}
        <div className="flex-1 overflow-y-auto px-5 pb-8 space-y-5">
          {/* Header */}
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            {t('mobile.startMowing')}
          </h3>

          {/* Work area */}
          {workMaps.length > 0 && (
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                {t('schedule.workArea')}
              </label>
              <select
                value={mapId ?? ''}
                onChange={(e) => setMapId(e.target.value || null)}
                className="w-full h-10 px-3 rounded-lg border border-gray-200 dark:border-gray-700
                           bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white text-sm
                           focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
              >
                <option value="">{t('schedule.allWorkAreas')}</option>
                {workMaps.map(m => (
                  <option key={m.mapId} value={m.mapId}>{m.mapName || m.mapId}</option>
                ))}
              </select>
            </div>
          )}

          {/* Cutting height */}
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
              {t('schedule.cuttingHeight')} — {(cuttingHeight / 10).toFixed(0)} cm
            </label>
            <input
              type="range"
              min={20}
              max={80}
              step={5}
              value={cuttingHeight}
              onChange={(e) => setCuttingHeight(Number(e.target.value))}
              className="w-full accent-emerald-500"
            />
            <div className="flex justify-between text-[10px] text-gray-400 dark:text-gray-600 mt-0.5">
              <span>2 cm</span>
              <span>8 cm</span>
            </div>
          </div>

          {/* Path direction */}
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-2">
              {t('schedule.pathDirection')}
            </label>
            <div className="grid grid-cols-4 gap-1.5">
              {(t('schedule.compass', { returnObjects: true }) as unknown as string[]).map((label, i) => {
                const deg = i * 45;
                return (
                  <button
                    key={deg}
                    onClick={() => setPathDirection(deg)}
                    className={`h-9 rounded-lg text-xs font-semibold transition-colors
                      ${pathDirection === deg
                        ? 'bg-emerald-500 text-white'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
                      }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex gap-3 pt-2">
            <button
              onClick={onClose}
              disabled={starting}
              className="flex-1 h-11 rounded-xl bg-gray-100 dark:bg-gray-800
                         text-gray-700 dark:text-gray-300 text-sm font-semibold
                         active:scale-[0.97] disabled:opacity-50 transition-all"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleStart}
              disabled={starting}
              className="flex-1 h-11 rounded-xl bg-emerald-600 hover:bg-emerald-500
                         text-white text-sm font-semibold flex items-center justify-center gap-2
                         active:scale-[0.97] disabled:opacity-50 transition-all"
            >
              <Play className="w-4 h-4" />
              {starting ? t('mobile.starting') : t('mobile.startMowing')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
