import { useState, useEffect } from 'react';
import { Link2, Loader2, CheckCircle, Cpu, Zap } from 'lucide-react';
import { fetchUnboundDevices, bindDevice, type UnboundDevice } from '../../api/client';

interface Props {
  /** Aangeroepen nadat een device gekoppeld is, zodat de devices-lijst ververst kan worden */
  onBound: () => void;
}

export function UnboundDevices({ onBound }: Props) {
  const [devices, setDevices] = useState<UnboundDevice[]>([]);
  const [binding, setBinding] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchUnboundDevices().then(setDevices).catch(() => {});
  }, []);

  if (devices.length === 0) return null;

  const handleBind = async (sn: string) => {
    setBinding(sn);
    setError(null);
    const result = await bindDevice(sn, names[sn]?.trim() || undefined);
    setBinding(null);
    if (result.ok) {
      setDone(prev => new Set([...prev, sn]));
      setTimeout(() => {
        setDevices(prev => prev.filter(d => d.sn !== sn));
        onBound();
      }, 1000);
    } else {
      setError(result.error ?? 'Koppelen mislukt');
    }
  };

  return (
    <div className="bg-amber-950/20 border border-amber-800/30 rounded-xl p-4 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <Link2 className="w-4 h-4 text-amber-400" />
        <h3 className="text-sm font-medium text-amber-300">Apparaten gevonden — nog niet gekoppeld</h3>
      </div>
      <p className="text-xs text-amber-200/60 mb-4 leading-relaxed">
        De onderstaande apparaten zijn verbonden met je MQTT-server maar nog niet aan je account gekoppeld.
        Geef ze een naam en klik op "Koppel" om ze toe te voegen.
      </p>

      <div className="space-y-2">
        {devices.map(d => {
          const isDone    = done.has(d.sn);
          const isBusy    = binding === d.sn;
          const Icon      = d.deviceType === 'charger' ? Zap : Cpu;
          const typeLabel = d.deviceType === 'charger' ? 'Laadstation' : 'Maaier';

          return (
            <div key={d.sn} className="flex items-center gap-3 bg-gray-900/60 rounded-lg px-3 py-2.5">
              {/* Type icoon + online dot */}
              <div className="relative flex-shrink-0">
                <Icon className="w-5 h-5 text-gray-400" />
                <span className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-gray-900 ${
                  d.online ? 'bg-emerald-400' : 'bg-gray-600'
                }`} />
              </div>

              {/* SN + type */}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-gray-200 truncate">{d.sn}</p>
                <p className="text-[10px] text-gray-500">{typeLabel} · {d.online ? 'Online' : 'Offline'}</p>
              </div>

              {/* Naam invoer */}
              {!isDone && (
                <input
                  type="text"
                  value={names[d.sn] ?? ''}
                  onChange={e => setNames(prev => ({ ...prev, [d.sn]: e.target.value }))}
                  placeholder="Naam (optioneel)"
                  className="w-32 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-emerald-600 transition-colors"
                />
              )}

              {/* Knop / status */}
              {isDone ? (
                <CheckCircle className="w-5 h-5 text-emerald-400 flex-shrink-0" />
              ) : (
                <button
                  onClick={() => handleBind(d.sn)}
                  disabled={isBusy}
                  className="flex items-center gap-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded transition-colors flex-shrink-0"
                >
                  {isBusy
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Koppelen...</>
                    : <><Link2 className="w-3.5 h-3.5" />Koppel</>
                  }
                </button>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <p className="text-xs text-red-400 mt-2">{error}</p>
      )}
    </div>
  );
}
