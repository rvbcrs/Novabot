import { Home, Map, Camera, CalendarDays, Sun, Moon, Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Tab } from '../MobilePage';
import { useTheme } from '../ThemeProvider';

interface Props {
  active: Tab;
  onTabChange: (tab: Tab) => void;
  /** false op stock firmware: geen camera-daemon, dus geen camera-tab. */
  showCamera?: boolean;
}

const TABS: Array<{ key: Tab; icon: typeof Home; labelKey: string }> = [
  { key: 'home',      icon: Home,         labelKey: 'mobile.tabs.home' },
  { key: 'map',       icon: Map,          labelKey: 'mobile.tabs.map' },
  { key: 'camera',    icon: Camera,       labelKey: 'mobile.tabs.camera' },
  { key: 'schedules', icon: CalendarDays, labelKey: 'mobile.tabs.schedules' },
];

export function BottomTabBar({ active, onTabChange, showCamera = true }: Props) {
  const { t } = useTranslation();
  const { preference, toggle } = useTheme();

  const ThemeIcon = preference === 'light' ? Sun : preference === 'dark' ? Moon : Monitor;

  return (
    <div className="bg-white/95 dark:bg-gray-900/95 backdrop-blur-md border-t border-gray-200 dark:border-gray-800 flex safe-bottom">
      {TABS.filter(tb => showCamera || tb.key !== 'camera').map(({ key, icon: Icon, labelKey }) => {
        const isActive = active === key;
        return (
          <button
            key={key}
            onClick={() => onTabChange(key)}
            className="flex-1 flex flex-col items-center justify-center gap-0.5 pt-2 pb-1 transition-colors"
          >
            <Icon className={`w-6 h-6 ${isActive ? 'text-emerald-500 dark:text-emerald-400' : 'text-gray-400 dark:text-gray-500'}`} />
            <span className={`text-[10px] font-medium ${isActive ? 'text-emerald-500 dark:text-emerald-400' : 'text-gray-400 dark:text-gray-500'}`}>
              {t(labelKey)}
            </span>
          </button>
        );
      })}
      {/* Theme toggle */}
      <button
        onClick={toggle}
        className="w-12 flex flex-col items-center justify-center gap-0.5 pt-2 pb-1 transition-colors"
        aria-label="Toggle theme"
      >
        <ThemeIcon className="w-5 h-5 text-gray-400 dark:text-gray-500" />
      </button>
    </div>
  );
}
