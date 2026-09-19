import { useState, useEffect } from 'react';
import { Scissors } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWorkSummary, updateBladeMaintenance, type WorkSummary } from '../../api/client';

/** Totalen per periode + mes-onderhoud boven de recordlijst. Zelfde data en
 *  gedrag als het History-scherm in de app (GET .../summary, PUT /maintenance). */
export function WorkSummaryCards({ sn }: { sn: string }) {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<WorkSummary | null>(null);

  useEffect(() => { fetchWorkSummary(sn).then(setSummary).catch(() => setSummary(null)); }, [sn]);

  const setBlade = (body: { bladeReplaced?: boolean; bladeIntervalHours?: number }) => {
    updateBladeMaintenance(sn, body)
      .then(blade => setSummary(prev => (prev ? { ...prev, blade } : prev)))
      .catch(() => {});
  };

  if (!summary) return null;
  const { blade } = summary;
  const pct = Math.min(100, (blade.hoursSince / blade.intervalHours) * 100);
  const periods = [
    ['week', t('history.summary.week', 'This week')],
    ['month', t('history.summary.month', 'This month')],
    ['year', t('history.summary.year', 'This year')],
  ] as const;

  return (
    <div className="space-y-3 mb-4">
      <div className="grid grid-cols-3 gap-2.5">
        {periods.map(([k, label]) => (
          <div key={k} className="bg-gray-800/50 border border-gray-700/60 rounded-xl px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
            <div className="text-lg font-semibold text-white tabular-nums">{summary[k].runs}×</div>
            <div className="text-[11px] text-gray-400 tabular-nums">{(summary[k].minutes / 60).toFixed(1)} h · {Math.round(summary[k].m2)} m²</div>
          </div>
        ))}
      </div>

      <div className={`bg-gray-800/50 border rounded-xl px-4 py-3 ${blade.due ? 'border-amber-500/60' : 'border-gray-700/60'}`}>
        <div className="flex items-center gap-2">
          <Scissors className={`w-4 h-4 ${blade.due ? 'text-amber-400' : 'text-gray-400'}`} />
          <span className="flex-1 text-sm font-semibold text-white">{t('history.summary.blades', 'Blades')}</span>
          <span className={`text-xs font-mono tabular-nums ${blade.due ? 'text-amber-300' : 'text-gray-400'}`}>
            {Math.round(blade.hoursSince)} / {blade.intervalHours} h
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-gray-900/60 mt-2 overflow-hidden">
          <div className={`h-full rounded-full ${blade.due ? 'bg-amber-400' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="text-[11px] text-gray-500 mt-2">
          {blade.replacedAt
            ? t('history.summary.bladesSince', { defaultValue: 'Mowing hours since replacement on {{date}}', date: new Date(blade.replacedAt).toLocaleDateString() })
            : t('history.summary.bladesNever', 'No replacement recorded yet; counting all mowing hours')}
        </div>
        <div className="flex items-center gap-1.5 mt-2.5">
          {[30, 60, 90, 120].map(h => (
            <button
              key={h}
              onClick={() => setBlade({ bladeIntervalHours: h })}
              className={`px-2 py-1 rounded-lg text-[11px] font-mono border transition-colors ${
                blade.intervalHours === h
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-600/40'
                  : 'bg-gray-900/40 text-gray-400 border-gray-700/50 hover:text-gray-200'
              }`}
            >
              {h} h
            </button>
          ))}
          <span className="flex-1" />
          <button
            onClick={() => setBlade({ bladeReplaced: true })}
            className="px-3 py-1 rounded-lg text-xs font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-600/40 hover:bg-emerald-500/25 transition-colors"
          >
            {t('history.summary.markReplaced', 'Mark replaced')}
          </button>
        </div>
      </div>
    </div>
  );
}
