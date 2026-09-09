import { useTranslation } from 'react-i18next';
import type { DeviceState } from '../types';
import { Scheduler } from '../components/schedule/Scheduler';
import { ScheduleTimeline } from '../components/schedule/ScheduleTimeline';

interface Props {
  mower: DeviceState | null;
}

export function SchedulePage({ mower }: Props) {
  const { t } = useTranslation();
  if (!mower) {
    return <div className="p-8 text-zinc-500">{t('pages.selectMower')}</div>;
  }
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-3xl mx-auto p-4 space-y-4">
        {/* Management first (the "New" + list is the primary action), the
            week-timeline overview below it. */}
        <Scheduler
          sn={mower.sn}
          online={mower.online}
          sensors={mower.sensors}
        />
        <ScheduleTimeline sn={mower.sn} />
      </div>
    </div>
  );
}
