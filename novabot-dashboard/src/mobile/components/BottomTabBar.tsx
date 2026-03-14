import { Home, Map, Camera, CalendarDays } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Tab } from '../MobilePage';

interface Props {
  active: Tab;
  onTabChange: (tab: Tab) => void;
}

const TABS: Array<{ key: Tab; icon: typeof Home; labelKey: string }> = [
  { key: 'home',      icon: Home,         labelKey: 'mobile.tabs.home' },
  { key: 'map',       icon: Map,          labelKey: 'mobile.tabs.map' },
  { key: 'camera',    icon: Camera,       labelKey: 'mobile.tabs.camera' },
  { key: 'schedules', icon: CalendarDays, labelKey: 'mobile.tabs.schedules' },
];

export function BottomTabBar({ active, onTabChange }: Props) {
  const { t } = useTranslation();

  return (
    <div className="bg-gray-900/95 backdrop-blur-md border-t border-gray-800 flex safe-bottom">
      {TABS.map(({ key, icon: Icon, labelKey }) => {
        const isActive = active === key;
        return (
          <button
            key={key}
            onClick={() => onTabChange(key)}
            className="flex-1 flex flex-col items-center justify-center gap-0.5 pt-2 pb-1 transition-colors"
          >
            <Icon className={`w-6 h-6 ${isActive ? 'text-emerald-400' : 'text-gray-500'}`} />
            <span className={`text-[10px] font-medium ${isActive ? 'text-emerald-400' : 'text-gray-500'}`}>
              {t(labelKey)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
