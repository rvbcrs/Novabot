import { useState, type ReactNode } from 'react';
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

export function ActionBar({ sn, online, activity }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [confirmStop, setConfirmStop] = useState(false);
  const [sending, setSending] = useState<string | null>(null);

  const disabled = !sn || !online || activity === 'offline';

  const send = async (label: string, command: Record<string, unknown>) => {
    if (disabled) return;
    setSending(label);
    try {
      await sendCommand(sn, command);
      toast(`${label} ✓`, 'success');
    } catch {
      toast(`${label} failed`, 'error');
    }
    setSending(null);
  };

  const btn = (label: string, icon: typeof Play, color: string, onClick: () => void, isDisabled = false) => (
    <button
      onClick={onClick}
      disabled={disabled || isDisabled || sending !== null}
      className={`flex-1 h-12 rounded-full ${color}
                  disabled:opacity-40 disabled:active:scale-100
                  flex items-center justify-center gap-2
                  text-white font-semibold text-sm
                  active:scale-[0.97] transition-all duration-75`}
    >
      {icon && (() => { const I = icon; return <I className="w-5 h-5" />; })()}
      {label}
    </button>
  );

  const buttons: ReactNode[] = [];

  switch (activity) {
    case 'mowing':
      buttons.push(
        <span key="pause">{btn(t('mobile.pause'), Pause, 'bg-yellow-500', () => send(t('mobile.pause'), { pause_run: {} }))}</span>,
        <span key="home">{btn(t('mobile.goHome'), Home, 'bg-blue-500', () => send(t('mobile.goHome'), { go_to_charge: {} }))}</span>,
      );
      break;
    case 'paused':
      buttons.push(
        <span key="resume">{btn(t('mobile.resume'), Play, 'bg-emerald-500', () => send(t('mobile.resume'), { resume_run: {} }))}</span>,
        <span key="stop">{btn(t('mobile.stop'), Square, 'bg-red-500', () => setConfirmStop(true))}</span>,
        <span key="home">{btn(t('mobile.goHome'), Home, 'bg-blue-500', () => send(t('mobile.goHome'), { go_to_charge: {} }))}</span>,
      );
      break;
    case 'returning':
    case 'mapping':
      buttons.push(
        <span key="stop">{btn(t('mobile.stop'), Square, 'bg-red-500', () => setConfirmStop(true))}</span>,
      );
      break;
    case 'error':
      buttons.push(
        <span key="start">{btn(t('mobile.start'), Play, 'bg-emerald-500', () => send(t('mobile.start'), { start_run: {} }))}</span>,
        <span key="home">{btn(t('mobile.goHome'), Home, 'bg-blue-500', () => send(t('mobile.goHome'), { go_to_charge: {} }))}</span>,
      );
      break;
    default: // idle, charging, offline
      buttons.push(
        <span key="start">{btn(t('mobile.startMowing') || t('mobile.start'), Play, 'bg-emerald-500',
          () => send(t('mobile.start'), { start_run: {} }))}
        </span>,
      );
      break;
  }

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-2">
        {buttons}
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
