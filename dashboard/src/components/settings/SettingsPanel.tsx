import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ShieldAlert, Gauge, Navigation, RotateCcw, Lightbulb, Volume2, VolumeX,
  Lock, Search, KeyRound, Send, Brain, Eye, Route, Clock, CloudRain, Compass, Save, Minus, Plus,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { io, Socket } from 'socket.io-client';
import {
  sendCommand, pinQuery, pinSet, pinVerify, pinRaw, setPerceptionMode, setSemanticMode, getPerceptionStatus,
  fetchRainSettings, updateRainSettings, type RainSettings, getToken,
} from '../../api/client';
import { useToast } from '../common/Toast';

// Headlight brightness levels (set_para_info.headlight = 0..255; 0 = off). The
// app sends the full brightness value (default 255) — NOT the enum 2 — and 255
// is the proven night-docking value (see CLAUDE.md LED patch).
const HEADLIGHT_LEVELS = [
  { value: 0, labelKey: 'settings.off' },
  { value: 128, labelKey: 'settings.dim' },
  { value: 255, labelKey: 'settings.bright' },
] as const;

// Common IANA timezones for the picker (mirrors the app MowerSettingsScreen).
const TIMEZONES = [
  'Europe/Amsterdam', 'Europe/Berlin', 'Europe/Paris', 'Europe/London',
  'Europe/Madrid', 'Europe/Rome', 'Europe/Brussels', 'Europe/Vienna',
  'Europe/Zurich', 'Europe/Stockholm', 'Europe/Helsinki', 'Europe/Warsaw',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Australia/Sydney', 'Asia/Tokyo', 'Asia/Shanghai', 'UTC',
];

function detectTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam'; }
  catch { return 'Europe/Amsterdam'; }
}

interface Props {
  sn: string;
  online: boolean;
  sensors: Record<string, string>;
}

const LEVELS = [1, 2, 3] as const;
// Joystick speed/handling levels — the firmware expects 100/200/300 (NOT 1/2/3).
// Mirrors the app MowerSettingsScreen CONTROLLER_LEVELS.
const CONTROLLER_LEVELS = [100, 200, 300] as const;

// All set_para_info fields the mower accepts. mqtt_node treats every set_para_info
// as a FULL overwrite of para.value, so sending one field clobbers the rest back
// to defaults (e.g. path_direction → 0). We therefore batch ALL fields behind one
// explicit Save, exactly like the app's "Confirm" flow.
interface ParaState {
  sensitivity: number;       // obstacle_avoidance_sensitivity 1..3
  pathDirection: number;     // path_direction 0..180 (default mowing direction)
  speed: number;             // manual_controller_v 100/200/300
  handling: number;          // manual_controller_w 100/200/300
  headlight: number;         // 0..255 (0 = off)
  sound: boolean;            // sound 2/0
}

const PARA_DEFAULTS: ParaState = { sensitivity: 3, pathDirection: 0, speed: 200, handling: 200, headlight: 0, sound: false };

function readPara(s: Record<string, string>, prevHeadlight: number): ParaState {
  const intIn = (v: string | undefined, lo: number, hi: number, dflt: number) => {
    const n = parseInt(v ?? '', 10);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  };
  const levelIn = (v: string | undefined, levels: readonly number[], dflt: number) => {
    const n = parseInt(v ?? '', 10);
    return levels.includes(n) ? n : dflt;
  };
  return {
    sensitivity: levelIn(s.obstacle_avoidance_sensitivity, LEVELS, 2),
    pathDirection: intIn(s.path_direction, 0, 180, 0),
    speed: levelIn(s.manual_controller_v, CONTROLLER_LEVELS, 200),
    handling: levelIn(s.manual_controller_w, CONTROLLER_LEVELS, 200),
    // The sensor only reports headlight on/off (2 vs other), not the brightness
    // level — preserve the last chosen brightness when it reports on.
    headlight: s.headlight === '2' ? (prevHeadlight > 0 ? prevHeadlight : 255) : 0,
    sound: s.sound === '2',
  };
}

export function SettingsPanel({ sn, online, sensors }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const [para, setPara] = useState<ParaState>(() => readPara(sensors, 255));
  const [saved, setSaved] = useState<ParaState>(para);
  const dirty = useMemo(() => JSON.stringify(para) !== JSON.stringify(saved), [para, saved]);
  const dirtyRef = useRef(dirty);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  const headlightRef = useRef(para.headlight);
  useEffect(() => { headlightRef.current = para.headlight; }, [para.headlight]);

  // Hydrate from the live sensors, but never stomp on the operator's pending
  // edits — only re-sync when there is nothing unsaved.
  useEffect(() => {
    if (dirtyRef.current) return;
    const next = readPara(sensors, headlightRef.current);
    // Only re-sync when something actually changed — sensors tick frequently and
    // we don't want to re-render the panel (or fight the operator) for no reason.
    setPara(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    setSaved(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [sensors]);

  const setField = useCallback(<K extends keyof ParaState>(k: K, v: ParaState[K]) => {
    setPara(p => ({ ...p, [k]: v }));
  }, []);

  const handleSave = useCallback(async () => {
    setBusy(true);
    try {
      // One batched set_para_info — all fields together so none get clobbered.
      await sendCommand(sn, { set_para_info: {
        sound: para.sound ? 2 : 0,
        headlight: para.headlight,
        path_direction: para.pathDirection,
        obstacle_avoidance_sensitivity: para.sensitivity,
        manual_controller_v: para.speed,
        manual_controller_w: para.handling,
      } });
      setSaved(para);
      toast(t('settings.saved', 'Instellingen opgeslagen'), 'success');
    } catch {
      toast(t('settings.mower.saveFailed', 'Kon instellingen niet opslaan'), 'error');
    }
    setBusy(false);
  }, [sn, para, t, toast]);

  // Reset is LOCAL only — sets the defaults into the editor; the operator still
  // presses Save to push them (keeps the single-overwrite contract intact).
  const handleReset = useCallback(() => setPara({ ...PARA_DEFAULTS }), []);

  const disabled = busy || !online;
  const levelLabels = [t('settings.low'), t('settings.medium'), t('settings.high')];

  return (
    <div className="p-4 space-y-5">
      {/* Obstacle Sensitivity */}
      <SegmentedSetting
        icon={ShieldAlert}
        label={t('settings.obstacleSensitivity')}
        value={para.sensitivity}
        levels={LEVELS}
        levelLabels={levelLabels}
        disabled={disabled}
        colors={['text-green-400', 'text-yellow-400', 'text-red-400']}
        onChange={(v) => setField('sensitivity', v)}
      />

      {/* Default mowing direction (path_direction 0..180°, 15° steps) */}
      <DirectionStepper
        value={para.pathDirection}
        disabled={disabled}
        onChange={(v) => setField('pathDirection', v)}
      />

      {/* AI Perception Controls (own immediate commands — not set_para_info) */}
      <PerceptionPanel sn={sn} online={online} />

      <div className="border-t border-gray-700" />

      {/* Max Speed (manual_controller_v 100/200/300) */}
      <SegmentedSetting
        icon={Gauge}
        label={t('settings.maxSpeed')}
        value={para.speed}
        levels={CONTROLLER_LEVELS}
        levelLabels={levelLabels}
        disabled={disabled}
        colors={['text-green-400', 'text-yellow-400', 'text-red-400']}
        onChange={(v) => setField('speed', v)}
      />

      {/* Handling (manual_controller_w 100/200/300) */}
      <SegmentedSetting
        icon={Navigation}
        label={t('settings.handling')}
        value={para.handling}
        levels={CONTROLLER_LEVELS}
        levelLabels={levelLabels}
        disabled={disabled}
        colors={['text-green-400', 'text-yellow-400', 'text-red-400']}
        onChange={(v) => setField('handling', v)}
      />

      <div className="border-t border-gray-700" />

      {/* Headlight brightness — set_para_info.headlight 0..255 (0 = off). */}
      <HeadlightControl
        value={para.headlight}
        disabled={disabled}
        onChange={(v) => setField('headlight', v)}
      />

      {/* Sound */}
      <ToggleRow
        icon={para.sound ? Volume2 : VolumeX}
        label={t('settings.sound')}
        active={para.sound}
        disabled={disabled}
        onToggle={() => setField('sound', !para.sound)}
      />

      {/* Batched Save + local Reset — all set_para_info fields go together. */}
      <div className="flex gap-2">
        <button
          onClick={handleReset}
          disabled={disabled}
          className="inline-flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded bg-gray-700 text-gray-400 hover:text-white hover:bg-gray-600 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          {t('settings.reset')}
        </button>
        <button
          onClick={handleSave}
          disabled={disabled || !dirty}
          className={`flex-1 inline-flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
            dirty ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-700 text-gray-400'
          }`}
        >
          <Save className="w-3.5 h-3.5" />
          {dirty ? t('settings.saveToMower', 'Opslaan naar maaier') : t('settings.saved', 'Instellingen opgeslagen')}
        </button>
      </div>

      <div className="border-t border-gray-700" />

      {/* Timezone — set_cfg_info { cfg_value: 1, tz } (separate command). */}
      <TimezonePanel sn={sn} disabled={disabled} />

      <div className="border-t border-gray-700" />

      {/* Rain auto-pause thresholds (server-side, immediate) */}
      <RainSettingsPanel sn={sn} online={online} />

      <div className="border-t border-gray-700" />

      {/* PIN Code Management */}
      <PinPanel sn={sn} online={online} />

    </div>
  );
}

/* ── Default mowing direction stepper (0..180°, 15° steps) ───── */

function DirectionStepper({ value, disabled, onChange }: {
  value: number;
  disabled: boolean;
  onChange: (deg: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Compass className="w-4 h-4 text-sky-400" />
        <span className="text-sm text-gray-300">{t('settings.defaultDirection', 'Standaard maairichting')}</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onChange(Math.max(0, value - 15))}
          disabled={disabled || value <= 0}
          className="w-9 h-9 rounded bg-gray-800 text-white text-lg hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <Minus className="w-4 h-4 mx-auto" />
        </button>
        <div className="flex-1 flex items-center justify-center gap-2 bg-gray-800 rounded py-1.5">
          <Navigation className="w-4 h-4 text-sky-300" style={{ transform: `rotate(${value}deg)` }} />
          <span className="text-sm font-mono text-white tabular-nums">{value}°</span>
        </div>
        <button
          onClick={() => onChange(Math.min(180, value + 15))}
          disabled={disabled || value >= 180}
          className="w-9 h-9 rounded bg-gray-800 text-white text-lg hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <Plus className="w-4 h-4 mx-auto" />
        </button>
      </div>
    </div>
  );
}

/* ── Headlight brightness ─────────────────────────────── */

function HeadlightControl({ value, disabled, onChange }: {
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Lightbulb className={`w-4 h-4 ${value > 0 ? 'text-yellow-300' : 'text-gray-500'}`} />
        <span className="text-sm text-gray-300">{t('settings.headlight')}</span>
      </div>
      <div className="flex gap-1">
        {HEADLIGHT_LEVELS.map(({ value: lvl, labelKey }) => (
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
            {t(labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Timezone ─────────────────────────────────────────── */

function TimezonePanel({ sn, disabled }: { sn: string; disabled: boolean }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [tz, setTz] = useState<string>(detectTimezone());
  const [busy, setBusy] = useState(false);

  // Ensure the detected device tz is selectable even if not in the curated list.
  const options = TIMEZONES.includes(tz) ? TIMEZONES : [tz, ...TIMEZONES];

  const save = useCallback(async () => {
    setBusy(true);
    try {
      await sendCommand(sn, { set_cfg_info: { cfg_value: 1, tz } });
      toast(t('settings.timezoneSaved', 'Tijdzone opgeslagen'), 'success');
    } catch {
      toast(t('settings.timezoneSaveFailed', 'Tijdzone opslaan mislukt'), 'error');
    }
    setBusy(false);
  }, [sn, tz, t, toast]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Clock className="w-4 h-4 text-sky-400" />
        <span className="text-sm text-gray-300">{t('settings.timezone', 'Tijdzone')}</span>
      </div>
      <div className="flex gap-2">
        <select
          value={tz}
          onChange={(e) => setTz(e.target.value)}
          disabled={disabled || busy}
          className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-sky-500 disabled:opacity-40"
        >
          {options.map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
        <button
          onClick={save}
          disabled={disabled || busy}
          className="text-xs px-3 py-1.5 rounded bg-sky-700 text-sky-100 hover:bg-sky-600 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {t('controls.apply', 'Toepassen')}
        </button>
      </div>
    </div>
  );
}

/* ── Rain auto-pause settings ─────────────────────────── */

function RainSettingsPanel({ sn, online }: { sn: string; online: boolean }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [settings, setSettings] = useState<RainSettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchRainSettings(sn).then(s => { if (!cancelled) setSettings(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, [sn]);

  const patch = useCallback(async (body: Partial<RainSettings>) => {
    setBusy(true);
    try {
      const updated = await updateRainSettings(sn, body);
      setSettings(updated);
    } catch {
      toast(t('settings.rainSaveFailed', 'Opslaan mislukt'), 'error');
    }
    setBusy(false);
  }, [sn, t, toast]);

  if (!settings) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <CloudRain className="w-4 h-4" />
        <span>{t('settings.rainLoading', 'Regen-instellingen laden...')}</span>
      </div>
    );
  }

  const disabled = busy || !online;

  return (
    <div className="space-y-3">
      <ToggleRow
        icon={CloudRain}
        label={t('settings.rainAutoPause', 'Auto-pauze bij regen')}
        active={settings.enabled}
        disabled={disabled}
        onToggle={() => patch({ enabled: !settings.enabled })}
      />
      {settings.enabled && (
        <div className="space-y-3 pl-1">
          <SliderRow
            label={t('settings.rainThresholdMm', 'Drempel (mm/u)')}
            value={settings.thresholdMm}
            min={0} max={5} step={0.1}
            format={(v) => `${v.toFixed(1)} mm`}
            disabled={disabled}
            onCommit={(v) => patch({ thresholdMm: v })}
          />
          <SliderRow
            label={t('settings.rainThresholdProb', 'Drempel (kans %)')}
            value={settings.thresholdProbability}
            min={0} max={100} step={5}
            format={(v) => `${Math.round(v)}%`}
            disabled={disabled}
            onCommit={(v) => patch({ thresholdProbability: v })}
          />
          <SliderRow
            label={t('settings.rainLookahead', 'Vooruitkijken (uur)')}
            value={settings.lookaheadHours}
            min={0.25} max={6} step={0.25}
            format={(v) => `${v.toFixed(2)} h`}
            disabled={disabled}
            onCommit={(v) => patch({ lookaheadHours: v })}
          />
        </div>
      )}
    </div>
  );
}

/* ── Slider Row (commit on release) ───────────────────── */

function SliderRow({ label, value, min, max, step, format, disabled, onCommit }: {
  label: string;
  value: number;
  min: number; max: number; step: number;
  format: (v: number) => string;
  disabled: boolean;
  onCommit: (v: number) => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => { setLocal(value); }, [value]);
  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</label>
        <span className="text-[11px] text-gray-300 font-mono">{format(local)}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={local}
        disabled={disabled}
        onChange={(e) => setLocal(parseFloat(e.target.value))}
        onMouseUp={() => onCommit(local)}
        onTouchEnd={() => onCommit(local)}
        className="w-full h-1.5 mt-1 accent-sky-500 bg-gray-700 rounded-full appearance-none cursor-pointer disabled:opacity-40"
      />
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
  const { t } = useTranslation();
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
        {active ? t('settings.on') : t('settings.off')}
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
    const socket = io({ transports: ['websocket', 'polling'], auth: { token: getToken() || undefined } });
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
      toast(t('settings.pinQueryFailed'), 'error');
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
      toast(t('settings.pinSetFailed'), 'error');
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
      toast(t('settings.pinVerifyFailed'), 'error');
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
      toast(t('settings.pinSendFailed'), 'error');
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
            title={t('settings.pinSendRaw')}
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

/* ── AI Perception Panel ─────────────────────────────── */

const PERCEPTION_MODES = [
  { value: 1, labelKey: 'ai.segmentation', tipKey: 'ai.tipSegmentation', color: 'text-green-400' },
  { value: 2, labelKey: 'ai.detection', tipKey: 'ai.tipDetection', color: 'text-blue-400' },
  { value: 3, labelKey: 'ai.segHigh', tipKey: 'ai.tipSegHigh', color: 'text-yellow-400' },
  { value: 4, labelKey: 'ai.segLow', tipKey: 'ai.tipSegLow', color: 'text-gray-400' },
] as const;

const SEMANTIC_MODES = [
  { value: 0, labelKey: 'ai.lawnCover', tipKey: 'ai.tipLawnCover', color: 'text-green-400' },
  { value: 1, labelKey: 'ai.freeMove', tipKey: 'ai.tipFreeMove', color: 'text-blue-400' },
  { value: 2, labelKey: 'ai.boundaryFollow', tipKey: 'ai.tipBoundaryFollow', color: 'text-yellow-400' },
] as const;

interface ExtendedResponseEvent {
  sn: string;
  command: string;
  data: Record<string, unknown>;
  timestamp: number;
}

function PerceptionPanel({ sn, online }: { sn: string; online: boolean }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [perceptionMode, setPerceptionModeState] = useState<number | null>(null);
  const [semanticMode, setSemanticModeState] = useState<number | null>(null);
  const [perceptionRunning, setPerceptionRunning] = useState<boolean | null>(null);
  const socketRef = useRef<Socket | null>(null);

  // Listen for extended:response events
  useEffect(() => {
    const socket = io({ transports: ['websocket', 'polling'], auth: { token: getToken() || undefined } });
    socketRef.current = socket;

    socket.on('extended:response', (e: ExtendedResponseEvent) => {
      if (e.sn !== sn) return;

      if (e.command === 'set_perception_mode_respond') {
        const result = e.data?.result as number;
        const mode = e.data?.mode as number;
        const modeName = e.data?.mode_name as string;
        if (result === 0) {
          setPerceptionModeState(mode);
          toast(`${t('ai.perceptionMode')}: ${modeName}`, 'success');
        } else {
          toast(`${t('ai.perceptionMode')}: ${e.data?.error ?? t('common.failed')}`, 'error');
        }
        setBusy(false);
      }

      if (e.command === 'set_semantic_mode_respond') {
        const result = e.data?.result as number;
        const mode = e.data?.mode as number;
        const modeName = e.data?.mode_name as string;
        if (result === 0) {
          setSemanticModeState(mode);
          toast(`${t('ai.semanticMode')}: ${modeName}`, 'success');
        } else {
          toast(`${t('ai.semanticMode')}: ${e.data?.error ?? t('common.failed')}`, 'error');
        }
        setBusy(false);
      }

      if (e.command === 'get_perception_status_respond') {
        setPerceptionRunning(e.data?.perception_running as boolean ?? false);
        if (typeof e.data?.perception_mode === 'number') setPerceptionModeState(e.data.perception_mode as number);
        if (typeof e.data?.semantic_mode === 'number') setSemanticModeState(e.data.semantic_mode as number);
        setBusy(false);
      }
    });

    return () => { socket.disconnect(); };
  }, [sn, t, toast]);

  // Query status on mount when online
  useEffect(() => {
    if (online) {
      getPerceptionStatus(sn).catch(() => {});
    }
  }, [sn, online]);

  const handlePerceptionMode = useCallback(async (mode: number) => {
    setBusy(true);
    try {
      await setPerceptionMode(sn, mode);
      // Response arrives via socket — timeout fallback
      setTimeout(() => setBusy(prev => prev ? false : prev), 8000);
    } catch {
      toast(`${t('ai.perceptionMode')}: ${t('common.failed')}`, 'error');
      setBusy(false);
    }
  }, [sn, t, toast]);

  const handleSemanticMode = useCallback(async (mode: number) => {
    setBusy(true);
    try {
      await setSemanticMode(sn, mode);
      setTimeout(() => setBusy(prev => prev ? false : prev), 8000);
    } catch {
      toast(`${t('ai.semanticMode')}: ${t('common.failed')}`, 'error');
      setBusy(false);
    }
  }, [sn, t, toast]);

  const disabled = busy || !online;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Brain className="w-4 h-4 text-purple-400" />
        <div className="flex-1">
          <span className="text-sm text-gray-300">{t('ai.title')}</span>
          <p className="text-[10px] text-gray-500 leading-tight">{t('ai.desc')}</p>
        </div>
        {perceptionRunning !== null && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${perceptionRunning ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'}`}>
            {perceptionRunning ? t('ai.running') : t('ai.stopped')}
          </span>
        )}
      </div>

      {/* Perception Mode */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Eye className="w-3.5 h-3.5 text-purple-400/70" />
          <span className="text-xs text-gray-400">{t('ai.perceptionMode')}</span>
        </div>
        <div className="grid grid-cols-4 gap-1">
          {PERCEPTION_MODES.map(({ value, labelKey, tipKey, color }) => (
            <button
              key={value}
              onClick={() => handlePerceptionMode(value)}
              disabled={disabled}
              title={t(tipKey)}
              className={`text-[11px] py-1.5 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                perceptionMode === value
                  ? `bg-gray-600 ${color} font-medium ring-1 ring-gray-500`
                  : 'bg-gray-800 text-gray-500 hover:text-gray-300 hover:bg-gray-700'
              }`}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* Semantic Navigation Mode */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Route className="w-3.5 h-3.5 text-purple-400/70" />
          <span className="text-xs text-gray-400">{t('ai.semanticMode')}</span>
        </div>
        <div className="grid grid-cols-3 gap-1">
          {SEMANTIC_MODES.map(({ value, labelKey, tipKey, color }) => (
            <button
              key={value}
              onClick={() => handleSemanticMode(value)}
              disabled={disabled}
              title={t(tipKey)}
              className={`text-[11px] py-1.5 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                semanticMode === value
                  ? `bg-gray-600 ${color} font-medium ring-1 ring-gray-500`
                  : 'bg-gray-800 text-gray-500 hover:text-gray-300 hover:bg-gray-700'
              }`}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </div>
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
  const activeIdx = levels.indexOf(value);

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
