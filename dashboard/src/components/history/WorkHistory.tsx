import { useState, useEffect, useCallback } from 'react';
import { Clock, Ruler, TreePine, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WorkRecord } from '../../types';
import { fetchWorkRecords } from '../../api/client';

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
    try {
      const data = await fetchWorkRecords(sn, PAGE_SIZE, offset);
      setRecords(prev => append ? [...prev, ...data.records] : data.records);
      setTotal(data.total);
    } catch { /* ignore */ }
    setLoading(false);
  }, [sn]);

  useEffect(() => {
    setLoading(true);
    loadMore(0, false);
  }, [sn, loadMore]);

  const hasMore = records.length < total;

  if (loading && records.length === 0) {
    return <div className="p-6 text-center text-sm text-gray-500">{t('devices.loading')}</div>;
  }

  if (records.length === 0) {
    return <div className="p-6 text-center text-sm text-gray-500">{t('history.empty')}</div>;
  }

  return (
    <div className="divide-y divide-gray-700/50">
      {records.map(r => (
        <RecordRow key={r.recordId} record={r} />
      ))}
      {hasMore && (
        <button
          onClick={() => loadMore(records.length, true)}
          className="w-full flex items-center justify-center gap-1.5 py-3 text-xs text-blue-400 hover:text-blue-300 hover:bg-gray-800/50 transition-colors"
        >
          <ChevronDown className="w-3.5 h-3.5" />
          {t('history.loadMore')} ({records.length}/{total})
        </button>
      )}
    </div>
  );
}

function RecordRow({ record }: { record: WorkRecord }) {
  const { t } = useTranslation();
  const date = record.dateTime ?? record.workRecordDate;
  const d = new Date(date.includes('T') || date.includes(' ') ? date : date + 'Z');
  const dateStr = isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const timeStr = isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  const statusColor = record.workStatus === 'complete' || record.workStatus === 'COMPLETE'
    ? 'text-emerald-400' : record.workStatus === 'cancelled' || record.workStatus === 'CANCELLED'
    ? 'text-red-400' : 'text-gray-400';

  return (
    <div className="px-4 py-3">
      {/* Date + status */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white">{dateStr}</span>
          {timeStr && <span className="text-xs text-gray-500">{timeStr}</span>}
        </div>
        {record.workStatus && (
          <span className={`text-[10px] font-medium uppercase ${statusColor}`}>
            {record.workStatus}
          </span>
        )}
      </div>
      {/* Stats row */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-400">
        {record.workTime != null && record.workTime > 0 && (
          <span className="inline-flex items-center gap-1">
            <Clock className="w-3 h-3 text-blue-400" />
            {t('history.duration', { min: record.workTime })}
          </span>
        )}
        {record.workArea != null && record.workArea > 0 && (
          <span className="inline-flex items-center gap-1">
            <TreePine className="w-3 h-3 text-emerald-400" />
            {t('history.area', { area: record.workArea.toFixed(0) })}
          </span>
        )}
        {record.cutGrassHeight != null && record.cutGrassHeight > 0 && (
          <span className="inline-flex items-center gap-1">
            <Ruler className="w-3 h-3 text-yellow-400" />
            {t('history.height', { cm: (record.cutGrassHeight / 10).toFixed(1) })}
          </span>
        )}
        {record.mapNames && (
          <span className="text-gray-500 truncate max-w-[120px]">{record.mapNames}</span>
        )}
      </div>
    </div>
  );
}
