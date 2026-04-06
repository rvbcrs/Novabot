import { Circle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  online: boolean;
  className?: string;
}

export function StatusBadge({ online, className = '' }: Props) {
  const { t } = useTranslation();
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${className}`}>
      <Circle className={`w-2 h-2 fill-current ${online ? 'text-green-500' : 'text-gray-500'}`} />
      {online ? t('common.online') : t('common.offline')}
    </span>
  );
}
