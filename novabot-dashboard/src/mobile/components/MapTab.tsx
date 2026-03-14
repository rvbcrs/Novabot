import type { MowerDerived, MowerActivity } from '../MobilePage';
import { useTranslation } from 'react-i18next';
import { MiniMap } from './MiniMap';

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

export function MapTab({ mower, liveOutlines }: Props) {
  const { t } = useTranslation();

  return (
    <div className="h-full relative">
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
      />

      {/* Floating status chip */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1001]
                      bg-gray-900/80 backdrop-blur-sm rounded-full
                      px-4 py-2 flex items-center gap-2.5 border border-gray-700/50
                      shadow-lg shadow-black/30">
        <span className={`w-2.5 h-2.5 rounded-full ${ACTIVITY_DOT[mower.activity]}`} />
        <span className="text-xs font-medium text-white">
          {t(`mobile.activity.${mower.activity}`)}
        </span>
        <span className="text-xs font-bold text-white tabular-nums">
          {mower.battery}%
        </span>
      </div>
    </div>
  );
}
