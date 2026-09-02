import { useState, useEffect } from 'react';
import { Server, ServerOff, Plus, Activity, ScrollText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BleScanner } from '../components/ble/BleScanner';
import { RainBadge } from './RainBadge';
import { ReleaseNotesModal } from '../components/common/ReleaseNotesModal';
import { getServerVersion, fetchReleaseNotes, type ReleaseNotesEntry } from '../api/client';

const LANGS = ['nl', 'en', 'fr', 'de'] as const;

interface Props {
  connected: boolean;
  rainState: 'dry' | 'rain' | 'paused-by-rain' | null;
  onOpenDrawer: () => void;
}

export function Header({ connected, rainState, onOpenDrawer }: Props) {
  const { t, i18n } = useTranslation();
  const [showBle, setShowBle] = useState(false);
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState<ReleaseNotesEntry[]>([]);
  const [showNotes, setShowNotes] = useState(false);
  useEffect(() => { getServerVersion().then(setVersion).catch(() => {}); }, []);
  // Knopje verschijnt alleen als er echt notes zijn (dev-builds hebben ze niet).
  useEffect(() => { fetchReleaseNotes().then(setNotes).catch(() => {}); }, []);

  const changeLang = (lng: string) => {
    i18n.changeLanguage(lng);
    localStorage.setItem('lang', lng);
  };

  return (
    <header className="h-12 md:h-16 bg-gray-900 border-b border-gray-800 flex items-center justify-between px-3 md:px-6">
      {/* Left: logo + title (version sits directly under the DASHBOARD text) */}
      <div className="flex items-center gap-3">
        <img src="/OpenNova.png" alt="OpenNova" className="h-9 w-auto" />
        <div className="hidden md:flex flex-col leading-none">
          <span
            className="text-xl text-gray-300 tracking-widest uppercase"
            style={{ fontFamily: "'Posterama 1919', sans-serif", letterSpacing: '0.2em' }}
          >
            {t('header.dashboard')}
          </span>
          {version && (
            <span className="inline-flex items-center gap-1 mt-1">
              <span
                className="text-[10px] font-mono text-zinc-500"
                title={t('header.serverVersion', 'Server version')}
              >
                v{version}
              </span>
              {notes.length > 0 && (
                <button
                  onClick={() => setShowNotes(true)}
                  title={t('releaseNotes.title', 'Release notes')}
                  aria-label={t('releaseNotes.title', 'Release notes')}
                  className="p-0.5 rounded text-zinc-600 hover:text-emerald-400 transition-colors"
                >
                  <ScrollText className="w-3 h-3" />
                </button>
              )}
            </span>
          )}
        </div>
      </div>

      {/* Right: add device + lang switcher + server status + rain badge + gear */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* Add device */}
        <button
          onClick={() => setShowBle(true)}
          title={t('ble.addDevice')}
          className="grid place-items-center w-8 h-8 rounded-lg text-zinc-400 bg-zinc-800/50 border border-zinc-700/70 hover:text-emerald-400 hover:border-emerald-500/60 transition-colors"
        >
          <Plus className="w-4 h-4" />
        </button>

        {/* Language switcher — segmented control */}
        <div className="hidden sm:inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-zinc-800/50 border border-zinc-700/70">
          {LANGS.map(lng => (
            <button
              key={lng}
              onClick={() => changeLang(lng)}
              className={`px-2 py-1 text-[11px] font-semibold rounded-md transition-colors ${
                i18n.language === lng
                  ? 'bg-emerald-500 text-emerald-950 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-100'
              }`}
            >
              {lng.toUpperCase()}
            </button>
          ))}
        </div>
        {/* Mobile: compact single-language toggle target */}
        <div className="sm:hidden inline-flex items-center gap-0.5">
          {LANGS.map(lng => (
            <button
              key={lng}
              onClick={() => changeLang(lng)}
              className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                i18n.language === lng ? 'bg-emerald-600 text-white font-medium' : 'text-gray-500'
              }`}
            >
              {lng.toUpperCase()}
            </button>
          ))}
        </div>

        {/* Server status — chip with a pulse dot */}
        <div
          className="inline-flex items-center gap-2 h-8 px-2.5 rounded-lg bg-zinc-800/50 border border-zinc-700/70"
          title={t('header.connectionTitle')}
        >
          <span className="relative grid place-items-center">
            <span
              className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-500'}`}
              style={connected ? { boxShadow: '0 0 0 3px rgba(52,211,153,.22)' } : { boxShadow: '0 0 0 3px rgba(239,68,68,.22)' }}
            />
          </span>
          {connected ? (
            <Server className="w-4 h-4 text-emerald-400/90" />
          ) : (
            <ServerOff className="w-4 h-4 text-red-500" />
          )}
          <span className="hidden sm:inline text-xs font-medium text-zinc-300">
            {connected ? t('header.server') : t('header.serverOffline')}
          </span>
        </div>

        {/* Rain badge */}
        <RainBadge rainState={rainState} />

        {/* Diagnostics drawer — Activity icon (not a gear, which reads as
            "settings"); kept subtle so it doesn't compete with the tabs. */}
        <button
          onClick={onOpenDrawer}
          title={t('header.diagnostics', 'Diagnostics & logs')}
          className="grid place-items-center w-8 h-8 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors"
          aria-label="Open diagnostics drawer"
        >
          <Activity className="w-4 h-4" />
        </button>
      </div>

      <BleScanner open={showBle} onClose={() => setShowBle(false)} />
      {showNotes && <ReleaseNotesModal releases={notes} onClose={() => setShowNotes(false)} />}
    </header>
  );
}
