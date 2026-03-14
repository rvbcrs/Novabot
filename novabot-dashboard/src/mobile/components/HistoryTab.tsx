import { useTranslation } from 'react-i18next';
import { WorkHistory } from '../../components/history/WorkHistory';

interface Props {
  sn: string;
}

export function HistoryTab({ sn }: Props) {
  const { t } = useTranslation();

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-4 pt-5 pb-3">
        <h2 className="text-lg font-semibold text-white">{t('mobile.tabs.history')}</h2>
      </div>
      <WorkHistory sn={sn} />
    </div>
  );
}
