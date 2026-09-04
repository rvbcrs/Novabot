import { createPortal } from 'react-dom';
import { X, ScrollText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ReleaseNotesEntry } from '../../api/client';

// Vaste sectievolgorde; de labels zijn eigennamen en gelijk in alle talen.
const SECTION_ORDER = ['dashboard', 'app', 'admin', 'firmware', 'server'] as const;
const SECTION_LABEL: Record<(typeof SECTION_ORDER)[number], string> = {
  dashboard: 'Dashboard',
  app: 'App',
  admin: 'Admin',
  firmware: 'Firmware',
  server: 'Server',
};

interface Props {
  releases: ReleaseNotesEntry[];
  onClose: () => void;
}

/** Popup met release notes per release, nieuwste bovenaan, gegroepeerd op
 *  Dashboard/App/Admin/Firmware/Server. Geopend via het knopje naast het
 *  versienummer in de header. */
export function ReleaseNotesModal({ releases, onClose }: Props) {
  const { t } = useTranslation();

  // Portal naar body: genest in de <header> maakt een ancestor met
  // transform/backdrop-filter van position:fixed een lokaal kader, waardoor
  // de popup tegen de bovenrand plakte in plaats van gecentreerd te staan.
  return createPortal(
    <div
      className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm grid place-items-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[80vh] flex flex-col rounded-2xl border border-gray-700/70 bg-gray-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
          <ScrollText className="w-4 h-4 text-emerald-400" />
          <span className="text-sm font-semibold text-zinc-100">
            {t('releaseNotes.title', 'Release notes')}
          </span>
          <button
            onClick={onClose}
            className="ml-auto p-1 rounded-md text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            aria-label={t('common.close', 'Close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-3 space-y-5">
          {releases.length === 0 && (
            <p className="text-sm text-zinc-500">
              {t('releaseNotes.empty', 'No release notes available.')}
            </p>
          )}
          {releases.map((rel) => {
            const nonEmpty = SECTION_ORDER.filter(s => (rel.sections[s]?.length ?? 0) > 0);
            return (
              <div key={rel.version}>
                <div className="flex items-baseline gap-2 mb-1.5">
                  <span className="text-sm font-mono font-semibold text-emerald-400">v{rel.version}</span>
                  <span className="text-[11px] text-zinc-500">{rel.date}</span>
                </div>
                {nonEmpty.length === 0 && (
                  <p className="text-xs text-zinc-500 pl-1">
                    {t('releaseNotes.noChanges', 'Maintenance release.')}
                  </p>
                )}
                {nonEmpty.map(section => (
                  <div key={section} className="mb-2">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400 mb-1">
                      {SECTION_LABEL[section]}
                    </div>
                    <ul className="space-y-0.5">
                      {rel.sections[section]!.map((line, i) => (
                        <li key={i} className="text-xs text-zinc-300 pl-3 relative">
                          <span className="absolute left-0 text-emerald-500/70">•</span>
                          {line}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
