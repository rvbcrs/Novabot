import { useState } from 'react';
import { Play, Pause, Square, Home } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { sendCommand } from '../../api/client';
import { useToast } from '../../components/common/Toast';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import type { MowerActivity } from '../MobilePage';

interface Props {
  sn: string;
  online: boolean;
  activity: MowerActivity;
}

export function QuickActions({ sn, online, activity }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [confirmStop, setConfirmStop] = useState(false);
  const [sending, setSending] = useState<string | null>(null);

  const send = async (label: string, command: Record<string, unknown>) => {
    if (!sn || !online) return;
    setSending(label);
    try {
      await sendCommand(sn, command);
      toast(`${label} ✓`, 'success');
    } catch {
      toast(`${label} failed`, 'error');
    }
    setSending(null);
  };

  const isPaused = activity === 'paused';
  const isMowing = activity === 'mowing';
  const isReturning = activity === 'returning';
  const disabled = !sn || !online || activity === 'offline';

  return (
    <>
      <div className="grid grid-cols-2 gap-2.5">
        {/* Start / Resume */}
        <button
          onClick={() => send(
            isPaused ? t('mobile.resume') : t('mobile.start'),
            isPaused ? { resume_run: {} } : { start_run: {} }
          )}
          disabled={disabled || isMowing || sending !== null}
          className="h-14 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-[0.97]
                     disabled:opacity-40 disabled:active:scale-100
                     flex items-center justify-center gap-2
                     text-white font-semibold text-sm
                     transition-all duration-75"
        >
          <Play className="w-5 h-5" />
          {isPaused ? t('mobile.resume') : t('mobile.start')}
        </button>

        {/* Pause */}
        <button
          onClick={() => send(t('mobile.pause'), { pause_run: {} })}
          disabled={disabled || !isMowing || sending !== null}
          className="h-14 rounded-xl bg-yellow-600 hover:bg-yellow-500 active:scale-[0.97]
                     disabled:opacity-40 disabled:active:scale-100
                     flex items-center justify-center gap-2
                     text-white font-semibold text-sm
                     transition-all duration-75"
        >
          <Pause className="w-5 h-5" />
          {t('mobile.pause')}
        </button>

        {/* Stop */}
        <button
          onClick={() => setConfirmStop(true)}
          disabled={disabled || (activity === 'idle' && !isMowing && !isPaused) || sending !== null}
          className="h-14 rounded-xl bg-red-600 hover:bg-red-500 active:scale-[0.97]
                     disabled:opacity-40 disabled:active:scale-100
                     flex items-center justify-center gap-2
                     text-white font-semibold text-sm
                     transition-all duration-75"
        >
          <Square className="w-5 h-5" />
          {t('mobile.stop')}
        </button>

        {/* Go Home */}
        <button
          onClick={() => send(t('mobile.goHome'), { go_to_charge: {} })}
          disabled={disabled || isReturning || activity === 'charging' || sending !== null}
          className="h-14 rounded-xl bg-blue-600 hover:bg-blue-500 active:scale-[0.97]
                     disabled:opacity-40 disabled:active:scale-100
                     flex items-center justify-center gap-2
                     text-white font-semibold text-sm
                     transition-all duration-75"
        >
          <Home className="w-5 h-5" />
          {t('mobile.goHome')}
        </button>
      </div>

      <ConfirmDialog
        open={confirmStop}
        title={t('mobile.stopConfirm')}
        confirmLabel={t('mobile.stop')}
        variant="danger"
        onConfirm={() => {
          setConfirmStop(false);
          send(t('mobile.stop'), { stop_run: {} });
        }}
        onCancel={() => setConfirmStop(false)}
      />
    </>
  );
}
