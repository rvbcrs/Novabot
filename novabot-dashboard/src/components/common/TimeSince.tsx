import { useState, useEffect } from 'react';
import { Clock } from 'lucide-react';

interface Props {
  timestamp: number;
  className?: string;
}

export function TimeSince({ timestamp, className = '' }: Props) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const seconds = Math.floor((now - timestamp) / 1000);
  let label: string;
  if (seconds < 5) label = 'just now';
  else if (seconds < 60) label = `${seconds}s ago`;
  else if (seconds < 3600) label = `${Math.floor(seconds / 60)}m ago`;
  else label = `${Math.floor(seconds / 3600)}h ago`;

  return (
    <span className={`inline-flex items-center gap-1 text-xs text-gray-500 ${className}`}>
      <Clock className="w-3 h-3" />
      {label}
    </span>
  );
}
