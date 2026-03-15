import { useState, useEffect } from 'react';
import { Wifi, Satellite, Zap, Home, Pause, Play, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MowerDerived, MowerActivity } from '../MobilePage';
import type { Schedule } from '../../types';
import { sendCommand, fetchSchedules } from '../../api/client';
import { useToast } from '../../components/common/Toast';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { MobileRainBanner } from './MobileRainBanner';
import { StartMowSheet } from './StartMowSheet';

interface Props {
  mower: MowerDerived;
}

// ── Activity styling ────────────────────────────────────────────────

const STATUS_COLOR: Record<MowerActivity, string> = {
  idle:      'text-gray-400 dark:text-gray-500',
  mowing:    'text-emerald-500',
  charging:  'text-blue-500',
  returning: 'text-amber-500',
  paused:    'text-yellow-500',
  mapping:   'text-purple-500',
  error:     'text-red-500',
  offline:   'text-gray-600',
};

const UNDERLINE_COLOR: Record<MowerActivity, string> = {
  idle:      'bg-gray-300 dark:bg-gray-700',
  mowing:    'bg-emerald-500',
  charging:  'bg-blue-500',
  returning: 'bg-amber-500',
  paused:    'bg-yellow-500',
  mapping:   'bg-purple-500',
  error:     'bg-red-500',
  offline:   'bg-gray-700',
};

function batteryColor(pct: number): string {
  if (pct >= 60) return 'text-emerald-500';
  if (pct >= 30) return 'text-yellow-500';
  if (pct >= 15) return 'text-orange-500';
  return 'text-red-500';
}

// ── Next schedule helper ────────────────────────────────────────────

function getNextRun(schedule: Schedule): Date | null {
  if (!schedule.enabled) return null;
  const days = schedule.weekdays;
  if (!days || days.length === 0) return null;
  const [hh, mm] = schedule.startTime.split(':').map(Number);
  const now = new Date();
  const today = now.getDay();
  for (let offset = 0; offset < 7; offset++) {
    const candidateDay = (today + offset) % 7;
    if (!days.includes(candidateDay)) continue;
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    candidate.setHours(hh, mm, 0, 0);
    if (candidate > now) return candidate;
  }
  return null;
}

function getCurrentEndTime(schedules: Schedule[]): string | null {
  const now = new Date();
  const today = now.getDay();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  for (const s of schedules) {
    if (!s.enabled || !s.endTime || !s.weekdays?.includes(today)) continue;
    const [sh, sm] = s.startTime.split(':').map(Number);
    const [eh, em] = s.endTime.split(':').map(Number);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (nowMinutes >= startMin && nowMinutes < endMin) {
      return s.endTime;
    }
  }
  return null;
}

// ── Component ───────────────────────────────────────────────────────

export function HomeTab({ mower }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [confirmStop, setConfirmStop] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [showStartSheet, setShowStartSheet] = useState(false);

  const disabled = !mower.sn || !mower.online || mower.activity === 'offline';

  useEffect(() => {
    if (!mower.sn) return;
    fetchSchedules(mower.sn).then(setSchedules).catch(() => {});
  }, [mower.sn]);

  const send = async (label: string, command: Record<string, unknown>) => {
    if (disabled) return;
    setSending(label);
    try {
      await sendCommand(mower.sn, command);
      toast(`${label} ✓`, 'success');
    } catch {
      toast(`${label} failed`, 'error');
    }
    setSending(null);
  };

  // Session info
  const isMowing = mower.activity === 'mowing';
  const endTime = isMowing ? getCurrentEndTime(schedules) : null;

  let sessionText = '';
  if (isMowing && endTime) {
    sessionText = `${t('mobile.sessionEnds')} ${endTime}`;
  } else if (!isMowing) {
    // Find next schedule
    let nextRun: Date | null = null;
    for (const s of schedules) {
      const run = getNextRun(s);
      if (run && (!nextRun || run < nextRun)) nextRun = run;
    }
    if (nextRun) {
      const now = new Date();
      const diffDays = Math.floor((nextRun.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
      const time = nextRun.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (diffDays === 0) sessionText = `${t('mobile.nextSchedule')}: ${t('time.today')} ${time}`;
      else if (diffDays === 1) sessionText = `${t('mobile.nextSchedule')}: ${t('time.tomorrow')} ${time}`;
      else {
        const weekdays = t('schedule.weekdays', { returnObjects: true }) as unknown as string[];
        sessionText = `${t('mobile.nextSchedule')}: ${weekdays[nextRun.getDay()]} ${time}`;
      }
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header: Logo + name */}
      <div className="flex items-center justify-between px-5 pt-3 pb-1">
        <div className="flex items-center gap-3">
          <img
            src="/OpenNova.png"
            alt="OpenNova"
            className="w-8 h-8 rounded-lg"
          />
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
              {mower.nickname || 'OpenNova'}
            </h1>
            <p className="text-[11px] text-gray-400 dark:text-gray-500">Novabot Mower</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${mower.online ? 'bg-emerald-400' : 'bg-gray-300 dark:bg-gray-600'}`} />
        </div>
      </div>

      {/* Main content — centered */}
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        {/* Large activity status */}
        <div className="flex flex-col items-center mb-4">
          <h2 className={`text-3xl font-bold tracking-tight ${STATUS_COLOR[mower.activity]}`}>
            {t(`mobile.activity.${mower.activity}`)}
          </h2>
          <div className={`w-12 h-1 rounded-full mt-2 ${UNDERLINE_COLOR[mower.activity]}`} />
        </div>

        {/* Logo image — shown when not actively mowing */}
        {!isMowing && (
          <img
            src="/OpenNova.png"
            alt="OpenNova"
            className="w-36 h-36 object-contain mb-4 opacity-90 dark:opacity-80"
          />
        )}

        {/* Info chips */}
        <div className="flex items-center gap-4 mb-6">
          <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            <Wifi className="w-3.5 h-3.5" />
            <span className="tabular-nums">{mower.wifiRssi ?? '—'}</span>
          </div>
          <div className="w-px h-4 bg-gray-200 dark:bg-gray-700" />
          <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            <Satellite className="w-3.5 h-3.5" />
            <span className="tabular-nums">{mower.rtkSat ?? '—'}</span>
          </div>
          <div className="w-px h-4 bg-gray-200 dark:bg-gray-700" />
          <div className={`flex items-center gap-1.5 text-xs font-semibold ${batteryColor(mower.battery)}`}>
            {mower.batteryCharging && <Zap className="w-3.5 h-3.5" />}
            <span className="tabular-nums">{mower.battery}%</span>
          </div>
        </div>

        {/* Mowing progress bar */}
        {isMowing && mower.mowingProgress > 0 && (
          <div className="w-56 mb-4">
            <div className="flex items-center justify-between text-[10px] text-gray-500 dark:text-gray-400 mb-1">
              <span>{t('mobile.progress')}</span>
              <span className="tabular-nums">{mower.mowingProgress}%</span>
            </div>
            <div className="h-1.5 bg-gray-200 dark:bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                style={{ width: `${mower.mowingProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* Session info */}
        {sessionText && (
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center">
            {sessionText}
          </p>
        )}
      </div>

      {/* Rain banner */}
      {mower.sn && (
        <div className="px-4">
          <MobileRainBanner mowerSn={mower.sn} />
        </div>
      )}

      {/* Action buttons — bottom */}
      <div className="px-5 pb-4 pt-2">
        {mower.activity === 'mowing' && (
          <div className="flex items-center gap-3">
            <button
              onClick={() => send(t('mobile.goHome'), { go_to_charge: {} })}
              disabled={disabled || sending !== null}
              className="w-16 h-16 rounded-2xl bg-gray-200 dark:bg-gray-800
                         flex items-center justify-center
                         active:scale-[0.95] disabled:opacity-40 transition-all"
            >
              <Home className="w-7 h-7 text-gray-600 dark:text-gray-300" />
            </button>
            <button
              onClick={() => send(t('mobile.pause'), { pause_run: {} })}
              disabled={disabled || sending !== null}
              className="w-16 h-16 rounded-2xl bg-gray-200 dark:bg-gray-800
                         flex items-center justify-center
                         active:scale-[0.95] disabled:opacity-40 transition-all"
            >
              <Pause className="w-7 h-7 text-gray-600 dark:text-gray-300" />
            </button>
          </div>
        )}

        {mower.activity === 'paused' && (
          <div className="flex items-center gap-3">
            <button
              onClick={() => send(t('mobile.resume'), { resume_run: {} })}
              disabled={disabled || sending !== null}
              className="flex-1 h-14 rounded-2xl bg-emerald-600
                         flex items-center justify-center gap-2
                         text-white font-semibold
                         active:scale-[0.97] disabled:opacity-40 transition-all"
            >
              <Play className="w-6 h-6" />
              {t('mobile.resume')}
            </button>
            <button
              onClick={() => setConfirmStop(true)}
              disabled={disabled || sending !== null}
              className="w-14 h-14 rounded-2xl bg-red-600
                         flex items-center justify-center
                         active:scale-[0.95] disabled:opacity-40 transition-all"
            >
              <Square className="w-6 h-6 text-white" />
            </button>
          </div>
        )}

        {mower.activity === 'returning' && (
          <button
            onClick={() => setConfirmStop(true)}
            disabled={disabled || sending !== null}
            className="w-full h-14 rounded-2xl bg-red-600
                       flex items-center justify-center gap-2
                       text-white font-semibold
                       active:scale-[0.97] disabled:opacity-40 transition-all"
          >
            <Square className="w-6 h-6" />
            {t('mobile.stop')}
          </button>
        )}

        {(mower.activity === 'idle' || mower.activity === 'charging' || mower.activity === 'offline' || mower.activity === 'error') && (
          <button
            onClick={() => setShowStartSheet(true)}
            disabled={disabled || sending !== null}
            className="w-full h-14 rounded-2xl bg-emerald-600
                       flex items-center justify-center gap-2
                       text-white font-semibold text-base
                       active:scale-[0.97] disabled:opacity-40 transition-all"
          >
            <Play className="w-6 h-6" />
            {t('mobile.startMowing')}
          </button>
        )}
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

      <StartMowSheet
        open={showStartSheet}
        onClose={() => setShowStartSheet(false)}
        sn={mower.sn}
        onStarted={() => setShowStartSheet(false)}
      />
    </div>
  );
}
