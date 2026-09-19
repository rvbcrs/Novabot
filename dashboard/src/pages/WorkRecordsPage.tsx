import { useTranslation } from 'react-i18next';
import type { DeviceState } from '../types';
import { WorkHistory } from '../components/history/WorkHistory';
import { WorkSummaryCards } from '../components/history/WorkSummaryCards';

interface Props {
  mower: DeviceState | null;
}

export function WorkRecordsPage({ mower }: Props) {
  const { t } = useTranslation();
  if (!mower) {
    return <div className="p-8 text-zinc-500">{t('pages.selectMower')}</div>;
  }
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-3xl mx-auto p-4">
        <WorkSummaryCards sn={mower.sn} />
        <WorkHistory sn={mower.sn} />
      </div>
    </div>
  );
}
