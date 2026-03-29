import { Scissors } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  progress: number;
}

export function WorkProgress({ progress }: Props) {
  const { t } = useTranslation();
  return (
    <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Scissors className="w-4 h-4 text-emerald-400" />
          <span className="text-sm text-gray-400">{t('status.mowingProgress')}</span>
        </div>
        <span className="text-sm font-medium text-white">{progress}%</span>
      </div>
      <div className="h-3 bg-gray-700 rounded-full overflow-hidden">
        <div
          className="h-full bg-emerald-500 rounded-full transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}
