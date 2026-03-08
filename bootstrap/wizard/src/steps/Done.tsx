import type { MowerInfo } from '../App.tsx';

interface Props {
  serverUrl: string | null;
  mower: MowerInfo | null;
}

export default function Done({ serverUrl, mower }: Props) {
  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-8">
      <div className="flex flex-col items-center gap-4 mb-8">
        <div className="w-20 h-20 rounded-full bg-emerald-900/40 border-2 border-emerald-500 flex items-center justify-center overflow-hidden">
          <img src="/OpenNova.png" alt="OpenNova" className="w-16 h-16 object-contain" />
        </div>
        <div className="text-center">
          <h2 className="text-2xl font-bold text-white mb-2">Klaar!</h2>
          <p className="text-gray-400">
            De OpenNova firmware is succesvol geïnstalleerd op je maaier.
          </p>
        </div>
      </div>

      {mower && (
        <div className="p-4 bg-gray-800/50 rounded-xl mb-4">
          <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Maaier</p>
          <p className="text-white font-mono">{mower.sn}</p>
          <p className="text-gray-400 text-sm">{mower.ip}</p>
        </div>
      )}

      {serverUrl ? (
        <div className="mb-6">
          <div className="p-4 bg-emerald-900/20 border border-emerald-700/50 rounded-xl mb-4">
            <p className="text-gray-400 text-xs uppercase tracking-wide mb-2">Dashboard URL</p>
            <p className="text-emerald-400 font-mono text-sm">{serverUrl}</p>
          </div>
          <a
            href={serverUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full py-3 px-6 bg-emerald-700 hover:bg-emerald-600 text-white font-semibold rounded-xl transition-colors text-center"
          >
            Naar het dashboard →
          </a>
        </div>
      ) : (
        <div className="p-4 bg-emerald-900/20 border border-emerald-700/50 rounded-xl mb-6">
          <p className="text-emerald-400 text-sm">
            De maaier is opnieuw verbonden. Open het OpenNova dashboard om verder te gaan.
          </p>
        </div>
      )}

      <div className="space-y-3">
        <h3 className="text-white font-medium">Vervolgstappen</h3>
        <div className="space-y-2">
          {[
            { icon: '📱', text: 'Open de Novabot app — de maaier verbindt automatisch via de Docker server' },
            { icon: '📍', text: 'Teken een maaierkaart in het dashboard' },
            { icon: '✓', text: 'Je kunt de Bootstrap tool nu sluiten' },
          ].map(({ icon, text }, i) => (
            <div key={i} className="flex items-start gap-3 p-3 bg-gray-800/40 rounded-xl">
              <span>{icon}</span>
              <p className="text-gray-300 text-sm">{text}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
