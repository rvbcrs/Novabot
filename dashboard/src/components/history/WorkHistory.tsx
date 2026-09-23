import { useState, useEffect, useCallback } from 'react';
import { Clock, Ruler, TreePine, ChevronDown, Map as MapIcon, Loader2, ScrollText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WorkRecord } from '../../types';
import { fetchWorkRecords } from '../../api/client';
import { formatCutGrassHeightCm } from '../../utils/workRecords';

interface Props {
  sn: string;
}

const PAGE_SIZE = 30;

export function WorkHistory({ sn }: Props) {
  const { t } = useTranslation();
  const [records, setRecords] = useState<WorkRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const loadMore = useCallback(async (offset: number, append: boolean) => {
    if (!append) setLoading(true);
    try {
      const data = await fetchWorkRecords(sn, PAGE_SIZE, offset);
      setRecords(prev => append ? [...prev, ...data.records] : data.records);
      setTotal(data.total);
    } catch { /* ignore */ }
    setLoading(false);
  }, [sn]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadMore(0, false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [sn, loadMore]);

  const hasMore = records.length < total;

  if (loading && records.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-500">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t('devices.loading')}
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <span className="grid place-items-center w-12 h-12 rounded-2xl bg-gray-800/60 border border-gray-700/60 text-gray-600">
          <ScrollText className="w-6 h-6" />
        </span>
        <span className="text-sm text-gray-500">{t('history.empty')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Section header */}
      <div className="flex items-center gap-2 px-1">
        <ScrollText className="w-4 h-4 text-emerald-400" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400">{t('tabs.records', 'Records')}</span>
        <span className="text-[11px] font-mono text-gray-600">{total}</span>
      </div>

      <div className="space-y-2.5">
        {records.map(r => (
          <RecordRow key={r.recordId} record={r} />
        ))}
      </div>

      {hasMore && (
        <button
          onClick={() => loadMore(records.length, true)}
          className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-gray-700/60 bg-gray-800/40 text-xs font-medium text-gray-400 hover:text-gray-100 hover:bg-gray-700/40 transition-colors"
        >
          <ChevronDown className="w-3.5 h-3.5" />
          {t('history.loadMore')} <span className="font-mono text-gray-500">({records.length}/{total})</span>
        </button>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const s = status.toUpperCase();
  const style = s === 'COMPLETE'
    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-600/30'
    : s === 'CANCELLED'
    ? 'bg-red-500/15 text-red-300 border-red-600/30'
    : 'bg-gray-700/40 text-gray-400 border-gray-600/40';
  return (
    <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${style}`}>
      {s === 'COMPLETE' ? t('history.result.complete') : s === 'CANCELLED' ? t('history.result.cancelled') : status}
    </span>
  );
}

function MiniStat({ icon: Icon, iconColor, value }: { icon: React.ComponentType<{ className?: string }>; iconColor: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gray-900/40 border border-gray-700/50">
      <Icon className={`w-3.5 h-3.5 ${iconColor}`} />
      <span className="text-[11px] font-mono font-medium text-gray-200 tabular-nums">{value}</span>
    </span>
  );
}

function RecordRow({ record }: { record: WorkRecord }) {
  const { t } = useTranslation();
  const date = record.dateTime ?? record.workRecordDate;
  const d = new Date(date.includes('T') || date.includes(' ') ? date : date + 'Z');
  const dateStr = isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const timeStr = isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const cutGrassHeightCm = formatCutGrassHeightCm(record.cutGrassHeight);

  return (
    <div className="bg-gray-800/50 border border-gray-700/60 rounded-xl px-4 py-3 hover:border-gray-600 transition-colors">
      {/* Date + status */}
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-white">{dateStr}</span>
          {timeStr && <span className="text-[11px] font-mono text-gray-500 tabular-nums">{timeStr}</span>}
        </div>
        {record.workStatus && <StatusBadge status={record.workStatus} />}
      </div>
      {/* Stats row */}
      <div className="flex flex-wrap items-center gap-2">
        {record.workTime != null && record.workTime > 0 && (
          <MiniStat icon={Clock} iconColor="text-sky-400" value={t('history.duration', { min: record.workTime })} />
        )}
        {record.workArea != null && record.workArea > 0 && (
          <MiniStat icon={TreePine} iconColor="text-emerald-400" value={t('history.area', { area: record.workArea.toFixed(0) })} />
        )}
        {cutGrassHeightCm != null && (
          <MiniStat icon={Ruler} iconColor="text-yellow-400" value={t('history.height', { cm: cutGrassHeightCm })} />
        )}
        {record.mapNames && (
          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gray-900/40 border border-gray-700/50 text-[11px] text-gray-400 truncate max-w-[160px]">
            <MapIcon className="w-3.5 h-3.5 text-gray-500 shrink-0" />
            <span className="truncate">{record.mapNames}</span>
          </span>
        )}
      </div>
    </div>
  );
}
