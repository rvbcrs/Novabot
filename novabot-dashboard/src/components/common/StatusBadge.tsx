import { Circle } from 'lucide-react';

interface Props {
  online: boolean;
  className?: string;
}

export function StatusBadge({ online, className = '' }: Props) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${className}`}>
      <Circle className={`w-2 h-2 fill-current ${online ? 'text-green-500' : 'text-gray-500'}`} />
      {online ? 'Online' : 'Offline'}
    </span>
  );
}
