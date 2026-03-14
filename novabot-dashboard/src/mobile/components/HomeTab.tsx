import type { MowerDerived, Tab } from '../MobilePage';
import { StatusHeroCard } from './StatusHeroCard';
import { QuickActions } from './QuickActions';
import { MiniMap } from './MiniMap';
import { MobileRainBanner } from './MobileRainBanner';
import { NextScheduleCard } from './NextScheduleCard';

interface Props {
  mower: MowerDerived;
  liveOutlines: Map<string, Array<{ lat: number; lng: number }>>;
  onNavigate: (tab: Tab) => void;
}

export function HomeTab({ mower, liveOutlines, onNavigate }: Props) {
  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <div className="px-4 pt-2 pb-6 space-y-4">
        {/* Circular battery gauge + status */}
        <StatusHeroCard mower={mower} />

        {/* Quick action buttons */}
        <QuickActions sn={mower.sn} online={mower.online} activity={mower.activity} />

        {/* Rain banner (only when active rain session) */}
        {mower.sn && <MobileRainBanner mowerSn={mower.sn} />}

        {/* Next schedule */}
        {mower.sn && <NextScheduleCard sn={mower.sn} />}

        {/* Mini map — tap to go fullscreen */}
        {mower.sn && (
          <div className="rounded-2xl overflow-hidden border border-gray-800">
            <MiniMap
              sn={mower.sn}
              lat={mower.lat}
              lng={mower.lng}
              heading={mower.heading}
              chargerLat={mower.chargerLat}
              chargerLng={mower.chargerLng}
              liveOutline={liveOutlines.get(mower.sn) ?? null}
              className="h-56"
              onTap={() => onNavigate('map')}
            />
          </div>
        )}
      </div>
    </div>
  );
}
