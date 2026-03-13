import { useState, useCallback, useEffect, useRef } from 'react';
import {
  ShieldAlert, Gauge, Navigation, RotateCcw, Lightbulb, Volume2, VolumeX,
  Lock, Search, KeyRound, Send,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { io, Socket } from 'socket.io-client';
import { sendCommand, pinQuery, pinSet, pinVerify, pinRaw } from '../../api/client';
import { useToast } from '../common/Toast';

interface Props {
  sn: string;
  online: boolean;
  sensors: Record<string, string>;
}

const LEVELS = [1, 2, 3] as const;

const DEFAULTS = {
  obstacle_avoidance_sensitivity: 3,
  manual_controller_v: 2,
  manual_controller_w: 2,
  headlight: 0,
  sound: 0,
};

export function SettingsPanel({ sn, online, sensors }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const send = useCallback(async (payload: Record<string, unknown>, label: string) => {
    setBusy(true);
    try {
      await sendCommand(sn, { set_para_info: payload });
      toast(`${label}`, 'success');
    } catch {
      toast(`${label} — failed`, 'error');
    }
    setBusy(false);
  }, [sn, toast]);

  const handleReset = useCallback(async () => {
    setBusy(true);
    try {
      await sendCommand(sn, { set_para_info: DEFAULTS });
      toast(t('settings.resetDone'), 'success');
    } catch {
      toast(t('settings.resetDone') + ' — failed', 'error');
    }
    setBusy(false);
  }, [sn, t, toast]);

  const disabled = busy || !online;

  const sensitivity = parseInt(sensors.obstacle_avoidance_sensitivity ?? '0', 10);
  const maxSpeed = parseInt(sensors.manual_controller_v ?? '0', 10);
  const handling = parseInt(sensors.manual_controller_w ?? '0', 10);
  const headlightOn = sensors.headlight === '2';
  const soundOn = sensors.sound === '2';

  const levelLabels = [t('settings.low'), t('settings.medium'), t('settings.high')];

  return (
    <div className="p-4 space-y-5">
      {/* Obstacle Sensitivity */}
      <SegmentedSetting
        icon={ShieldAlert}
        label={t('settings.obstacleSensitivity')}
        value={sensitivity}
        levels={LEVELS}
        levelLabels={levelLabels}
        disabled={disabled}
        colors={['text-green-400', 'text-yellow-400', 'text-red-400']}
        onChange={(v) => send({ obstacle_avoidance_sensitivity: v }, t('settings.obstacleSensitivity'))}
      />

      {/* Max Speed */}
      <SegmentedSetting
        icon={Gauge}
        label={t('settings.maxSpeed')}
        value={maxSpeed}
        levels={LEVELS}
        levelLabels={levelLabels}
        disabled={disabled}
        colors={['text-green-400', 'text-yellow-400', 'text-red-400']}
        onChange={(v) => send({ manual_controller_v: v }, t('settings.maxSpeed'))}
      />

      {/* Handling */}
      <SegmentedSetting
        icon={Navigation}
        label={t('settings.handling')}
        value={handling}
        levels={LEVELS}
        levelLabels={levelLabels}
        disabled={disabled}
        colors={['text-green-400', 'text-yellow-400', 'text-red-400']}
        onChange={(v) => send({ manual_controller_w: v }, t('settings.handling'))}
      />

      <div className="border-t border-gray-700" />

      {/* Headlight & Sound — mowing preferences */}
      <div className="flex gap-2">
        <ToggleRow
          icon={Lightbulb}
          label={t('settings.headlight')}
          active={headlightOn}
          disabled={disabled}
          onToggle={() => send({ headlight: headlightOn ? 0 : 2 }, t('settings.headlight'))}
        />
        <ToggleRow
          icon={soundOn ? Volume2 : VolumeX}
          label={t('settings.sound')}
          active={soundOn}
          disabled={disabled}
          onToggle={() => send({ sound: soundOn ? 0 : 2 }, t('settings.sound'))}
        />
      </div>

      <div className="border-t border-gray-700" />

      {/* Reset to defaults */}
      <button
        onClick={handleReset}
        disabled={disabled}
        className="w-full inline-flex items-center justify-center gap-2 text-xs px-3 py-2 rounded bg-gray-700 text-gray-400 hover:text-white hover:bg-gray-600 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <RotateCcw className="w-3.5 h-3.5" />
        {t('settings.reset')}
      </button>

      <div className="border-t border-gray-700" />

      {/* PIN Code Management */}
      <PinPanel sn={sn} online={online} />
    </div>
  );
}

/* ── Toggle Row ───────────────────────────────────────── */

function ToggleRow({ icon: Icon, label, active, disabled, onToggle }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className={`flex-1 flex items-center gap-2 px-3 py-2.5 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
        active
          ? 'bg-yellow-500/15 border border-yellow-500/30 text-yellow-300'
          : 'bg-gray-800 border border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-600'
      }`}
    >
      <Icon className={`w-4.5 h-4.5 flex-shrink-0 ${active ? 'text-yellow-300' : 'text-gray-500'}`} />
      <span className="text-sm font-medium">{label}</span>
      <span className={`ml-auto text-[10px] uppercase tracking-wider font-semibold ${active ? 'text-yellow-400' : 'text-gray-600'}`}>
        {active ? 'ON' : 'OFF'}
      </span>
    </button>
  );
}

/* ── PIN Code Panel ──────────────────────────────────── */

interface PinEvent {
  sn: string;
  data: { result?: number; value?: string | { cfg_value?: number; code?: string } };
  timestamp: number;
}

function PinPanel({ sn, online }: { sn: string; online: boolean }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [currentPin, setCurrentPin] = useState<string | null>(null);
  const [newPin, setNewPin] = useState('');
  const [rawType, setRawType] = useState('2');
  const [busy, setBusy] = useState(false);
  const [lastResponse, setLastResponse] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  // Listen for pin:event via socket.io
  useEffect(() => {
    const socket = io({ transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('pin:event', (e: PinEvent) => {
      if (e.sn !== sn) return;
      const result = e.data?.result;
      const value = e.data?.value;

      // Mower response format: {"result":0,"value":"3053"} — value is a direct string
      // Or possibly object format: {"result":0,"value":{"cfg_value":0,"code":"3053"}}
      if (typeof value === 'string' && value.length > 0 && value !== 'xxxx') {
        setCurrentPin(value);
        setLastResponse(`PIN: ${value} (result=${result})`);
        toast(`${t('settings.pinReceived')}: ${value}`, 'success');
      } else if (typeof value === 'object' && value?.code) {
        setCurrentPin(value.code);
        setLastResponse(`PIN: ${value.code} (result=${result})`);
        toast(`${t('settings.pinReceived')}: ${value.code}`, 'success');
      } else {
        // Masked response (e.g., "xxxx" from cfg_value=2,3) or error
        setLastResponse(`result=${result}, value=${JSON.stringify(value)}`);
        toast(t('settings.pinReceived'), result === 0 ? 'success' : 'info');
      }
      setBusy(false);
    });

    return () => { socket.disconnect(); };
  }, [sn, t, toast]);

  const handleQuery = useCallback(async () => {
    setBusy(true);
    setLastResponse(null);
    try {
      await pinQuery(sn);
      toast(t('settings.pinSent'), 'info');
      // Response arrives via socket — timeout fallback
      setTimeout(() => setBusy(prev => { if (prev) { setLastResponse(t('settings.pinNoResponse')); return false; } return prev; }), 5000);
    } catch {
      toast('Query failed', 'error');
      setBusy(false);
    }
  }, [sn, t, toast]);

  const handleSet = useCallback(async () => {
    if (newPin.length !== 4 || !/^\d{4}$/.test(newPin)) return;
    setBusy(true);
    setLastResponse(null);
    try {
      await pinSet(sn, newPin);
      toast(t('settings.pinSent'), 'info');
      setTimeout(() => setBusy(prev => { if (prev) { setLastResponse(t('settings.pinNoResponse')); return false; } return prev; }), 5000);
    } catch {
      toast('Set failed', 'error');
      setBusy(false);
    }
  }, [sn, newPin, t, toast]);

  const handleVerify = useCallback(async () => {
    const code = newPin.length === 4 ? newPin : currentPin;
    if (!code || code.length !== 4) return;
    setBusy(true);
    setLastResponse(null);
    try {
      await pinVerify(sn, code);
      toast(t('settings.pinSent'), 'info');
      setTimeout(() => setBusy(prev => { if (prev) { setLastResponse(t('settings.pinNoResponse')); return false; } return prev; }), 5000);
    } catch {
      toast('Verify failed', 'error');
      setBusy(false);
    }
  }, [sn, newPin, currentPin, t, toast]);

  const handleRawSend = useCallback(async () => {
    const code = newPin.length === 4 ? newPin : (currentPin ?? '0000');
    const typeNum = parseInt(rawType, 10);
    if (isNaN(typeNum)) return;
    setBusy(true);
    setLastResponse(null);
    try {
      await pinRaw(sn, typeNum, code);
      toast(`${t('settings.pinSent')} (type=${typeNum})`, 'info');
      setTimeout(() => setBusy(prev => { if (prev) { setLastResponse(t('settings.pinNoResponse')); return false; } return prev; }), 5000);
    } catch {
      toast('Send failed', 'error');
      setBusy(false);
    }
  }, [sn, newPin, currentPin, rawType, t, toast]);

  const disabled = busy || !online;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Lock className="w-4 h-4 text-amber-400" />
        <div>
          <span className="text-sm text-gray-300">{t('settings.pin')}</span>
          <p className="text-[10px] text-gray-500 leading-tight">{t('settings.pinDesc')}</p>
        </div>
      </div>

      {/* Current PIN display */}
      <div className="flex items-center gap-2 bg-gray-800 rounded px-3 py-2">
        <span className="text-xs text-gray-500">{t('settings.pinCurrentCode')}:</span>
        <span className="text-sm font-mono font-bold text-amber-300 tracking-widest">
          {currentPin ?? t('settings.pinUnknown')}
        </span>
        <button
          onClick={handleQuery}
          disabled={disabled}
          className="ml-auto text-xs px-2 py-1 rounded bg-gray-700 text-gray-400 hover:text-white hover:bg-gray-600 transition-colors disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center gap-1"
        >
          <Search className="w-3 h-3" />
          {busy ? t('settings.pinQuerying') : t('settings.pinQuery')}
        </button>
      </div>

      {/* PIN input + actions */}
      <div className="flex gap-2">
        <input
          type="text"
          inputMode="numeric"
          maxLength={4}
          pattern="\d{4}"
          placeholder={t('settings.pinPlaceholder')}
          value={newPin}
          onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
          className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-sm font-mono text-center tracking-widest text-white placeholder-gray-600 focus:outline-none focus:border-amber-500"
        />
        <button
          onClick={handleSet}
          disabled={disabled || newPin.length !== 4}
          className="text-xs px-2.5 py-1.5 rounded bg-amber-700 text-amber-100 hover:bg-amber-600 transition-colors disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center gap-1"
          title={t('settings.pinSet')}
        >
          <KeyRound className="w-3 h-3" />
          {t('settings.pinSet')}
        </button>
      </div>

      {/* Verify + Raw send */}
      <div className="flex gap-2">
        <button
          onClick={handleVerify}
          disabled={disabled || (!newPin && !currentPin)}
          className="flex-1 text-xs px-2.5 py-1.5 rounded bg-emerald-800 text-emerald-200 hover:bg-emerald-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1"
          title={`${t('settings.pinVerify')} (type=2)`}
        >
          <Send className="w-3 h-3" />
          {t('settings.pinVerify')} (type=2)
        </button>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-gray-600">type=</span>
          <input
            type="text"
            inputMode="numeric"
            maxLength={2}
            value={rawType}
            onChange={(e) => setRawType(e.target.value.replace(/\D/g, '').slice(0, 2))}
            className="w-8 bg-gray-800 border border-gray-600 rounded px-1 py-1.5 text-xs font-mono text-center text-white focus:outline-none focus:border-amber-500"
          />
          <button
            onClick={handleRawSend}
            disabled={disabled}
            className="text-xs px-2 py-1.5 rounded bg-gray-700 text-gray-400 hover:text-white hover:bg-gray-600 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="Send raw type"
          >
            <Send className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Last response */}
      {lastResponse && (
        <div className="text-[10px] font-mono text-gray-500 bg-gray-800/50 rounded px-2 py-1 break-all">
          {lastResponse}
        </div>
      )}
    </div>
  );
}

/* ── Segmented Setting ────────────────────────────────── */

function SegmentedSetting({ icon: Icon, label, value, levels, levelLabels, disabled, colors, onChange }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  levels: readonly number[];
  levelLabels: string[];
  disabled: boolean;
  colors: string[];
  onChange: (v: number) => void;
}) {
  const activeIdx = levels.indexOf(value as 1 | 2 | 3);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Icon className={`w-4 h-4 ${activeIdx >= 0 ? colors[activeIdx] : 'text-gray-500'}`} />
        <span className="text-sm text-gray-300">{label}</span>
      </div>
      <div className="flex gap-1">
        {levels.map((lvl, i) => (
          <button
            key={lvl}
            onClick={() => onChange(lvl)}
            disabled={disabled}
            className={`flex-1 text-xs py-1.5 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
              value === lvl
                ? 'bg-gray-600 text-white font-medium ring-1 ring-gray-500'
                : 'bg-gray-800 text-gray-500 hover:text-gray-300 hover:bg-gray-700'
            }`}
          >
            {levelLabels[i]}
          </button>
        ))}
      </div>
    </div>
  );
}
