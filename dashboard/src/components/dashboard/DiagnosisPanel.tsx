/**
 * DiagnosisPanel — where is this device stuck in coming online.
 *
 * Novabot is bankrupt and there is no support, so someone whose mower or
 * charger will not connect has nowhere to ask. The server already holds the
 * evidence; this shows the chain, stops at the first broken link, and gives one
 * next action instead of a wall of logs.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, XCircle, AlertTriangle, MinusCircle, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchDiagnosis, type Diagnosis, type DiagnosisStep } from '../../api/client';

const STEP_LABEL: Record<string, [string, string]> = {
  seen: ['diagnose.seen', 'Ooit verbonden'],
  attempts: ['diagnose.attempts', 'Verbindingspogingen'],
  binding: ['diagnose.binding', 'Koppeling'],
  ble_mac: ['diagnose.bleMac', 'BLE MAC'],
  counterpart: ['diagnose.counterpart', 'Tegenhanger'],
  lora: ['diagnose.lora', 'LoRa-paar'],
};

function Icon({ status }: { status: DiagnosisStep['status'] }) {
  if (status === 'ok') return <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />;
  if (status === 'fail') return <XCircle className="w-4 h-4 text-red-400 shrink-0" />;
  if (status === 'warn') return <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />;
  return <MinusCircle className="w-4 h-4 text-zinc-600 shrink-0" />;
}

export function DiagnosisPanel({ sn, onClose }: { sn: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [data, setData] = useState<Diagnosis | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    setError('');
    fetchDiagnosis(sn)
      .then(setData)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [sn]);

  return createPortal(
    <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-gray-900 border border-gray-700/50 rounded-2xl shadow-2xl
                      max-w-lg w-full p-5 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-white font-medium">
            {t('diagnose.title', 'Waarom komt hij niet online?')}
          </h2>
          <button onClick={load} disabled={loading}
                  title={t('diagnose.refresh', 'Opnieuw nakijken')}
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 disabled:opacity-40">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {loading && !data && (
          <div className="flex items-center gap-2 text-sm text-zinc-400 py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> {t('diagnose.checking', 'Nakijken…')}
          </div>
        )}
        {error && <div className="text-sm text-red-400 py-4">{error}</div>}

        {data && (
          <>
            <div className={`text-sm rounded-lg px-3 py-2 mb-3 ${
              data.stuckAt ? 'bg-red-500/10 text-red-300' : 'bg-emerald-500/10 text-emerald-300'}`}>
              {data.summary}
            </div>
            <ol className="space-y-2">
              {data.steps.map(s => (
                <li key={s.id} className="flex gap-2.5">
                  <Icon status={s.status} />
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-zinc-200">
                      {t(STEP_LABEL[s.id]?.[0] ?? s.id, STEP_LABEL[s.id]?.[1] ?? s.id)}
                    </div>
                    <div className="text-[11px] text-zinc-400 break-words">{s.evidence}</div>
                    {s.action && (
                      <div className="text-[11px] text-amber-300/90 mt-0.5 break-words">
                        → {s.action}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </>
        )}

        <button onClick={onClose}
                className="w-full mt-4 py-2 bg-white/10 hover:bg-white/15 text-gray-300 text-sm rounded-xl">
          {t('common.close', 'Sluiten')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
