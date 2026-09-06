import { useTranslation } from 'react-i18next';
import { Check, RotateCcw, Trash2, AlertTriangle, UploadCloud, Undo2, Redo2 } from 'lucide-react';

export interface MapEditBarProps {
  pendingCount: number;
  pendingSync: boolean;
  hasVersions: boolean;
  status: string;
  statusKind: 'info' | 'error' | 'warn' | 'ok';
  busy: boolean;
  onApply: () => void;
  onRevert: () => void;
  onDiscard: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** false on stock LFI firmware: applying needs the OpenNova extended channel
   *  (write_map_files), so Apply/Re-sync are disabled and a notice explains
   *  the in-app "Edit map" route instead. Drafting still works. */
  firmwareSupported: boolean;
}

const STATUS_COLORS: Record<MapEditBarProps['statusKind'], string> = {
  error: 'text-red-400',
  warn: 'text-amber-400',
  ok: 'text-emerald-400',
  info: 'text-gray-400',
};

/**
 * Floating apply/revert/discard bar for the draft → apply-to-mower flow.
 * Surfaces the count of pending geometry drafts, a re-sync badge when the
 * last apply only got as far as the server (push to mower failed), a status
 * line, and the three actions. Confirms for revert/discard are handled by
 * the parent (it owns the window.confirm + API call).
 */
export function MapEditBar({
  pendingCount, pendingSync, hasVersions, status, statusKind, busy,
  onApply, onRevert, onDiscard, canUndo, canRedo, onUndo, onRedo, firmwareSupported,
}: MapEditBarProps) {
  const { t } = useTranslation();
  // When the only thing outstanding is a failed push (no fresh drafts), the
  // primary action is "re-sync" rather than "apply".
  const resyncOnly = pendingSync && pendingCount === 0;

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] bg-gray-900/95 backdrop-blur border border-gray-700 rounded-lg p-3 shadow-xl w-[calc(100vw-1.5rem)] sm:w-80">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs font-medium text-gray-200">
          {t('map.edit.pending', { count: pendingCount })}
        </span>
        <div className="flex items-center gap-1">
          {pendingSync && (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-400">
              <AlertTriangle className="w-3 h-3" />
              {t('map.edit.needsResync')}
            </span>
          )}
          <button
            onClick={onUndo}
            disabled={!canUndo}
            className="inline-flex items-center justify-center p-1 rounded text-gray-400 hover:text-white hover:bg-gray-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            title={t('map.edit.undo')}
            aria-label={t('map.edit.undo')}
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onRedo}
            disabled={!canRedo}
            className="inline-flex items-center justify-center p-1 rounded text-gray-400 hover:text-white hover:bg-gray-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            title={t('map.edit.redo')}
            aria-label={t('map.edit.redo')}
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {!firmwareSupported && (
        <p className="text-[11px] mb-2 leading-snug text-amber-400 flex items-start gap-1">
          <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span>{t('map.edit.stockNotice')}</span>
        </p>
      )}

      {status && (
        <p className={`text-[11px] mb-2 leading-snug whitespace-pre-line ${STATUS_COLORS[statusKind]}`}>
          {status}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={onApply}
          disabled={busy || !firmwareSupported}
          title={!firmwareSupported ? t('map.edit.stockNotice') : undefined}
          className="flex-1 inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {resyncOnly ? <UploadCloud className="w-3 h-3" /> : <Check className="w-3 h-3" />}
          {resyncOnly ? t('map.edit.resync') : t('map.edit.apply')}
        </button>
        {hasVersions && (
          <button
            onClick={onRevert}
            disabled={busy}
            className="inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded bg-gray-700 text-gray-300 hover:text-white hover:bg-gray-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={t('map.edit.revert')}
          >
            <RotateCcw className="w-3 h-3" />
            <span className="hidden sm:inline">{t('map.edit.revert')}</span>
          </button>
        )}
        <button
          onClick={onDiscard}
          disabled={busy}
          className="inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded text-gray-500 hover:text-red-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title={t('map.edit.discard')}
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
