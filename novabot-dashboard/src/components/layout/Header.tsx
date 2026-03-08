import { useState } from 'react';
import { Server, ServerOff, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BleScanner } from '../ble/BleScanner';

const LANGS = ['nl', 'en', 'fr'] as const;

interface Props {
  connected: boolean;
}

export function Header({ connected }: Props) {
  const { t, i18n } = useTranslation();
  const [showBle, setShowBle] = useState(false);

  const changeLang = (lng: string) => {
    i18n.changeLanguage(lng);
    localStorage.setItem('lang', lng);
  };

  return (
    <header className="h-16 bg-gray-900 border-b border-gray-800 flex items-center justify-between px-6">
      <div className="flex items-center gap-3">
        <img src="/OpenNova.png" alt="OpenNova" className="h-9 w-auto" />
        <span className="text-xl text-gray-300 tracking-widest uppercase" style={{ fontFamily: "'Posterama 1919', sans-serif", letterSpacing: '0.2em' }}>{t('header.dashboard')}</span>
      </div>
      <div className="flex items-center gap-4">
        {/* Add device */}
        <button
          onClick={() => setShowBle(true)}
          title={t('ble.addDevice')}
          className="p-1.5 rounded-lg text-gray-500 hover:text-emerald-400 hover:bg-gray-800 transition-colors"
        >
          <Plus className="w-4 h-4" />
        </button>
        {/* Language switcher */}
        <div className="flex items-center gap-0.5">
          {LANGS.map(lng => (
            <button
              key={lng}
              onClick={() => changeLang(lng)}
              className={`px-2 py-0.5 text-xs rounded transition-colors ${
                i18n.language === lng
                  ? 'bg-emerald-600 text-white font-medium'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
              }`}
            >
              {lng.toUpperCase()}
            </button>
          ))}
        </div>
        {/* Server status */}
        <div className="flex items-center gap-2 text-sm" title={t('header.connectionTitle')}>
          {connected ? (
            <Server className="w-4 h-4 text-green-500" />
          ) : (
            <ServerOff className="w-4 h-4 text-red-500" />
          )}
          <span className="text-gray-400">{connected ? t('header.server') : t('header.serverOffline')}</span>
        </div>
      </div>
      <BleScanner open={showBle} onClose={() => setShowBle(false)} />
    </header>
  );
}
