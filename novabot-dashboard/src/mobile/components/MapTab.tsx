import { useState, useEffect, useMemo } from 'react';
import { ChevronRight, X, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import L from 'leaflet';
import type { MowerDerived, MowerActivity } from '../MobilePage';
import type { MapData } from '../../types';
import { fetchMaps } from '../../api/client';
import { MiniMap } from './MiniMap';
import { JoystickControl } from '../../components/dashboard/JoystickControl';
import { StartMowSheet } from './StartMowSheet';

interface Props {
  mower: MowerDerived;
  liveOutlines: Map<string, Array<{ lat: number; lng: number }>>;
}

const ACTIVITY_DOT: Record<MowerActivity, string> = {
  idle:      'bg-gray-400',
  mowing:    'bg-emerald-400',
  charging:  'bg-blue-400',
  returning: 'bg-amber-400',
  paused:    'bg-yellow-400',
  mapping:   'bg-purple-400',
  error:     'bg-red-400',
  offline:   'bg-gray-600',
};

const TYPE_COLOR: Record<string, string> = {
  work:     'bg-emerald-500',
  obstacle: 'bg-red-500',
  unicom:   'bg-blue-500',
};

/** Compute polygon area in m² using the Shoelace formula with cos(lat) correction */
function computeAreaM2(points: Array<{ lat: number; lng: number }>): number {
  if (points.length < 3) return 0;
  const toRad = Math.PI / 180;
  const R = 6371000;
  const avgLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const cosLat = Math.cos(avgLat * toRad);

  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const xi = points[i].lng * toRad * R * cosLat;
    const yi = points[i].lat * toRad * R;
    const xj = points[j].lng * toRad * R * cosLat;
    const yj = points[j].lat * toRad * R;
    area += xi * yj - xj * yi;
  }
  return Math.abs(area / 2);
}

function formatArea(m2: number): string {
  if (m2 >= 10000) return `${(m2 / 10000).toFixed(1)} ha`;
  return `${Math.round(m2)} m\u00b2`;
}

export function MapTab({ mower, liveOutlines }: Props) {
  const { t } = useTranslation();
  const [maps, setMaps] = useState<MapData[]>([]);
  const [joystickOpen, setJoystickOpen] = useState(false);
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);
  const [mowSheetOpen, setMowSheetOpen] = useState(false);

  useEffect(() => {
    if (!mower.sn) return;
    fetchMaps(mower.sn).then(setMaps).catch(() => {});
  }, [mower.sn]);

  const obstacleMaps = maps.filter(m => m.mapType === 'obstacle');
  const channelMaps = maps.filter(m => m.mapType === 'unicom');

  const selectedMap = maps.find(m => m.mapId === selectedMapId) ?? null;

  // Compute bounds for the selected polygon
  const focusBounds = useMemo(() => {
    if (!selectedMap || selectedMap.mapArea.length < 2) return null;
    return L.latLngBounds(selectedMap.mapArea.map(p => [p.lat, p.lng] as [number, number]));
  }, [selectedMap]);

  const handleMapItemTap = (mapId: string) => {
    setSelectedMapId(prev => prev === mapId ? null : mapId);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Map takes most of the space */}
      <div className="flex-1 min-h-0 relative">
        <MiniMap
          sn={mower.sn}
          lat={mower.lat}
          lng={mower.lng}
          heading={mower.heading}
          chargerLat={mower.chargerLat}
          chargerLng={mower.chargerLng}
          liveOutline={liveOutlines.get(mower.sn) ?? null}
          className="h-full w-full"
          showControls
          joystickOpen={joystickOpen}
          onJoystickToggle={() => setJoystickOpen(o => !o)}
          selectedMapId={selectedMapId}
          focusBounds={focusBounds}
        />

        {/* Floating status chip */}
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1001]
                        bg-white/85 dark:bg-gray-900/80 backdrop-blur-sm rounded-full
                        px-4 py-2 flex items-center gap-2.5
                        border border-gray-200/60 dark:border-gray-700/50
                        shadow-lg shadow-black/10 dark:shadow-black/30">
          <span className={`w-2.5 h-2.5 rounded-full ${ACTIVITY_DOT[mower.activity]}`} />
          <span className="text-xs font-medium text-gray-700 dark:text-white">
            {t(`mobile.activity.${mower.activity}`)}
          </span>
          <span className="text-xs font-bold text-gray-900 dark:text-white tabular-nums">
            {mower.battery}%
          </span>
        </div>

        {/* Selected area action chip */}
        {selectedMap && selectedMap.mapType === 'work' && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[1002]
                          bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm rounded-2xl
                          px-4 py-3 flex items-center gap-3
                          border border-gray-200/60 dark:border-gray-700/50
                          shadow-xl shadow-black/15 dark:shadow-black/40">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                {selectedMap.mapName || t('map.workArea')}
              </p>
              <p className="text-[11px] text-gray-400 dark:text-gray-500">
                {formatArea(computeAreaM2(selectedMap.mapArea))}
              </p>
            </div>
            <button
              onClick={() => setMowSheetOpen(true)}
              disabled={!mower.online}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl
                         bg-emerald-600 text-white text-sm font-semibold
                         active:scale-[0.97] disabled:opacity-40 transition-all flex-shrink-0"
            >
              <Play className="w-4 h-4" />
              {t('mobile.start')}
            </button>
            <button
              onClick={() => setSelectedMapId(null)}
              className="p-1 text-gray-400 active:text-gray-600 dark:active:text-gray-200 flex-shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Joystick overlay */}
        {joystickOpen && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[1002]">
            <div className="bg-gray-900/95 backdrop-blur rounded-2xl border border-gray-700 p-4 shadow-xl">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-medium text-emerald-400">{t('controls.manualControl')}</span>
                <button onClick={() => setJoystickOpen(false)} className="text-gray-500 hover:text-gray-300 p-0.5">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <JoystickControl
                sn={mower.sn}
                online={mower.online}
                speedLevel={mower.manualSpeedLevel}
              />
            </div>
          </div>
        )}
      </div>

      {/* Bottom panel — Map objects */}
      <div className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800
                      rounded-t-2xl -mt-4 relative z-[1001] max-h-[40%] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h3 className="text-base font-semibold text-gray-900 dark:text-white">
            {t('mobile.mapObjects')}
          </h3>
          {(obstacleMaps.length > 0 || channelMaps.length > 0) && (
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {obstacleMaps.length > 0 && t('map.obstacles_other', { count: obstacleMaps.length })}
              {obstacleMaps.length > 0 && channelMaps.length > 0 && ' · '}
              {channelMaps.length > 0 && t('map.channels_other', { count: channelMaps.length })}
            </span>
          )}
        </div>

        {/* Map list */}
        <div className="flex-1 overflow-y-auto pb-2">
          {maps.length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-400 dark:text-gray-500 text-center">
              {t('map.noGps')}
            </p>
          ) : (
            <div className="space-y-0.5">
              {maps.map(m => {
                const area = computeAreaM2(m.mapArea);
                const color = TYPE_COLOR[m.mapType] ?? 'bg-purple-500';
                const typeLabel = m.mapType === 'work'
                  ? t('map.workArea')
                  : m.mapType === 'obstacle'
                    ? t('map.obstacle')
                    : t('map.channel');
                const isSelected = m.mapId === selectedMapId;

                return (
                  <button
                    key={m.mapId}
                    onClick={() => handleMapItemTap(m.mapId)}
                    className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                      isSelected
                        ? 'bg-emerald-50 dark:bg-emerald-900/20'
                        : 'active:bg-gray-50 dark:active:bg-gray-800/50'
                    }`}
                  >
                    <div className={`w-5 h-5 rounded ${color} flex-shrink-0 ${
                      isSelected ? 'ring-2 ring-emerald-400 ring-offset-1 dark:ring-offset-gray-900' : ''
                    }`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                        {m.mapName || typeLabel}
                      </p>
                      <p className="text-[11px] text-gray-400 dark:text-gray-500">
                        {formatArea(area)}
                        {m.mapType !== 'work' && ` · ${typeLabel}`}
                      </p>
                    </div>
                    <ChevronRight className={`w-4 h-4 flex-shrink-0 transition-colors ${
                      isSelected ? 'text-emerald-500' : 'text-gray-300 dark:text-gray-600'
                    }`} />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Start mowing sheet */}
      <StartMowSheet
        open={mowSheetOpen}
        onClose={() => setMowSheetOpen(false)}
        sn={mower.sn}
        onStarted={() => setSelectedMapId(null)}
        initialMapId={selectedMapId}
      />
    </div>
  );
}
