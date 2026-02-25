import { Bot, Server, ServerOff } from 'lucide-react';

interface Props {
  connected: boolean;
}

export function Header({ connected }: Props) {
  return (
    <header className="h-16 bg-gray-900 border-b border-gray-800 flex items-center justify-between px-6">
      <div className="flex items-center gap-3">
        <Bot className="w-6 h-6 text-emerald-500" />
        <span className="text-xl font-bold text-white">Novabot</span>
        <span className="text-sm text-gray-400">Dashboard</span>
      </div>
      <div className="flex items-center gap-2 text-sm" title="Connection to novabot-server">
        {connected ? (
          <Server className="w-4 h-4 text-green-500" />
        ) : (
          <ServerOff className="w-4 h-4 text-red-500" />
        )}
        <span className="text-gray-400">{connected ? 'Server' : 'Server offline'}</span>
      </div>
    </header>
  );
}
