import { useState, useEffect } from 'react';
import { Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  timestamp: number;
  className?: string;
}

export function TimeSince({ timestamp, className = '' }: Props) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const seconds = Math.floor((now - timestamp) / 1000);
  let label: string;
  if (seconds < 5) label = t('time.justNow');
  else if (seconds < 60) label = t('time.secondsAgo', { seconds });
  else if (seconds < 3600) label = t('time.minutesAgo', { minutes: Math.floor(seconds / 60) });
  else label = t('time.hoursAgo', { hours: Math.floor(seconds / 3600) });

  return (
    <span className={`inline-flex items-center gap-1 text-xs text-gray-500 ${className}`}>
      <Clock className="w-3 h-3" />
      {label}
    </span>
  );
}
