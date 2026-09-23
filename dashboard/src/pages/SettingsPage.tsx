import { useState, useEffect, useRef } from 'react';
import {
  Tag, Bell, Check, Loader2, Smartphone, Radio, Home as HomeIcon, Mail,
  Scissors, Compass, Minus, Plus, Monitor, Shield, Gamepad2, Gauge, Battery, Power,
  CloudRain, Lightbulb, Volume2, Clock, Wrench, RotateCw, FlaskConical, Bug, ExternalLink, Box,
  Image as ImageIcon, Upload, Trash2, Copy,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DeviceState } from '../types';
import {
  updateMowerNickname, sendCommand, setSensorOverride, softRestartMower,
  recalibrateChargingPose, fetchRainSettings, updateRainSettings, type RainSettings,
  setMaxSpeed, setChargeThreshold, rebootMower,
} from '../api/client';
import { readWeekStart, writeWeekStart, type WeekStart } from '../utils/weekStart';
import { readTimeFormat, writeTimeFormat, type TimeFormat } from '../utils/timeFormat';
import { readAutoMapEnabled, writeAutoMapEnabled } from '../utils/autoMapEnabled';
import { configuredHeightMm } from '../utils/mowDefaults';
import { readExperimental, writeExperimental } from '../utils/experimental';
import { MowingDirectionPreview } from '../components/schedule/MowingDirectionPreview';
import { useToast } from '../components/common/Toast';
import { useDialog } from '../components/common/Dialog';
import { isOpenNovaFirmware } from '../utils/firmwareCapability';
import {
  isUnsupportedFirmwareError, getServerVersion, fetchRenderSettings, saveRenderSettings,
  fetchDroneOverlay, uploadDroneOverlay, deleteDroneOverlay, copyDroneOverlay, droneOverlayImageUrl, fetchDevices,
  type DroneOverlayMeta,
} from '../api/client';

interface Props {
  mower: DeviceState | null;
}

export function SettingsPage({ mower }: Props) {
  const { t } = useTranslation();
  if (!mower) {
    return <div className="p-8 text-zinc-500">{t('pages.selectMower')}</div>;
  }
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-2xl mx-auto p-4 space-y-4">
        {/* key on the SN so switching mower remounts these with fresh state +
            re-hydration (otherwise the previous mower's settings linger). */}
        <NicknameCard key={`nick-${mower.sn}`} mower={mower} />
        <MowerSettingsSection key={`mset-${mower.sn}`} mower={mower} />
        <DisplayCard />
        <AutoMapCard />
        <ExperimentalCard />
        <RainAutoPauseCard key={`rain-${mower.sn}`} sn={mower.sn} />
        <NotificationsCard />
        <DronePhotoCard key={`drone-${mower.sn}`} sn={mower.sn} />
        <GardenRenderCard />
        <HelpCard mower={mower} />
      </div>
    </div>
  );
}

// ── Shared card shell ────────────────────────────────────────────────────────

function SettingCard({
  icon: Icon,
  title,
  help,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-gray-700/60 bg-gray-900/50 p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon className="w-4 h-4 text-emerald-400" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400">{title}</span>
      </div>
      {help && <p className="text-xs text-zinc-500 mb-3 leading-relaxed">{help}</p>}
      {children}
    </div>
  );
}

function NicknameCard({ mower }: { mower: DeviceState }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string>(mower.nickname ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const handleSave = async () => {
    const trimmed = draft.trim();
    setSaving(true);
    setError(null);
    try {
      await updateMowerNickname(mower.sn, trimmed.length === 0 ? null : trimmed);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingCard icon={Tag} title={t('settings.nickname.title')} help={t('settings.nickname.help')}>
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={mower.sn}
          className="flex-1 bg-gray-900/60 border border-gray-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/40 transition-colors"
        />
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {saving ? t('settings.nickname.saving') : t('settings.nickname.save')}
        </button>
      </div>
      {error && <div className="mt-2 text-red-400 text-xs">{error}</div>}
      {savedAt && !error && (
        <div className="mt-2 inline-flex items-center gap-1.5 text-emerald-400 text-xs">
          <Check className="w-3.5 h-3.5" />{t('settings.nickname.saved')}
        </div>
      )}
    </SettingCard>
  );
}

// ── Mower settings (port of the app's MowerSettings screen, same endpoints) ───

const HEIGHT_CM = [2, 3, 4, 5, 6, 7, 8, 9]; // physical cm; wire mm = cm × 10
const SENSITIVITY = [
  { value: 1, key: 'low' },
  { value: 2, key: 'medium' },
  { value: 3, key: 'high' },
] as const;
const CONTROLLER = [
  { value: 100, key: 'low' },
  { value: 200, key: 'medium' },
  { value: 300, key: 'high' },
] as const;
const RAIN_MM = [0.1, 0.2, 0.5, 1.0, 2.0];
const RAIN_PROB = [30, 50, 70, 90];
const RAIN_HOURS = [
  { value: 0.5, label: '30m' },
  { value: 1, label: '1h' },
  { value: 2, label: '2h' },
  { value: 3, label: '3h' },
];
const COMMON_TIMEZONES = [
  'Europe/Amsterdam', 'Europe/Berlin', 'Europe/Brussels', 'Europe/Paris',
  'Europe/London', 'Europe/Madrid', 'Europe/Rome', 'Europe/Vienna',
  'Europe/Warsaw', 'Europe/Stockholm', 'Europe/Helsinki', 'Europe/Athens',
  'Europe/Lisbon', 'Europe/Zurich', 'Europe/Prague', 'Europe/Dublin',
  'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'America/Toronto', 'America/Vancouver',
  'America/Sao_Paulo', 'America/Mexico_City',
  'Australia/Sydney', 'Australia/Melbourne', 'Australia/Perth',
  'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Dubai',
];

function detectTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) return tz;
  } catch { /* ignore */ }
  return 'Europe/Amsterdam';
}

const HL_KEY = 'novabot.headlightBrightness';
function readBrightness(): number {
  try {
    const v = parseInt(localStorage.getItem(HL_KEY) ?? '', 10);
    if (v >= 1 && v <= 255) return v;
  } catch { /* ignore */ }
  return 255;
}
function writeBrightness(v: number): void {
  try { localStorage.setItem(HL_KEY, String(v)); } catch { /* ignore */ }
}

function clampInt(raw: string | undefined, lo: number, hi: number): number | null {
  if (raw == null || raw === '') return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`w-10 h-5 rounded-full relative transition-colors ${on ? 'bg-emerald-600' : 'bg-gray-700'}`}
    >
      <span className={`w-4 h-4 rounded-full bg-white absolute top-0.5 transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  );
}

function chipClass(active: boolean): string {
  return `px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
    active ? 'bg-emerald-600 text-white' : 'bg-gray-800/60 text-gray-400 hover:text-gray-200 border border-gray-700'
  }`;
}

/** The 6 fields that go in one set_para_info block (full overwrite). */
function buildParams(s: Snapshot) {
  return {
    sound: s.sound ? 2 : 0,
    headlight: s.headlight ? s.brightness : 0,
    path_direction: s.pathDirection,
    obstacle_avoidance_sensitivity: s.sensitivity,
    manual_controller_v: s.joystickSpeed,
    manual_controller_w: s.joystickHandling,
  };
}

interface Snapshot {
  cuttingHeight: number; sensitivity: number; pathDirection: number;
  joystickSpeed: number; joystickHandling: number;
  headlight: boolean; brightness: number; sound: boolean; timezone: string;
}

function MowerSettingsSection({ mower }: { mower: DeviceState }) {
  const { t } = useTranslation();
  const dialog = useDialog();
  const { toast } = useToast();
  const sn = mower.sn;
  const online = mower.online;
  // Recovery-acties (recalibrate/restart/reboot) zijn extended → alleen OpenNova firmware.
  const firmwareSupported = isOpenNovaFirmware(mower.sensors?.sw_version ?? mower.sensors?.version);

  // Batched (set_para_info) state — all saved together by the Save button.
  const [cuttingHeight, setCuttingHeight] = useState(40); // mm
  const [sensitivity, setSensitivity] = useState(2);
  const [pathDirection, setPathDirection] = useState(0);
  const [joystickSpeed, setJoystickSpeed] = useState(300);
  const [joystickHandling, setJoystickHandling] = useState(300);
  const [headlight, setHeadlight] = useState(false);
  const [brightness, setBrightness] = useState(() => readBrightness());
  const [sound, setSound] = useState(false);
  const [timezone, setTimezone] = useState(() => detectTimezone());
  // Last values committed to the mower. Auto-save diffs against this so we only
  // send what changed — and never fire on the initial hydration.
  const committedRef = useRef<Snapshot>({
    cuttingHeight: 40, sensitivity: 2, pathDirection: 0,
    joystickSpeed: 300, joystickHandling: 300,
    headlight: false, brightness: readBrightness(), sound: false, timezone: detectTimezone(),
  });
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(0);

  // Navigation prefs (own endpoints, not part of set_para_info). No sensor to
  // hydrate from, so they show defaults and only push when the user changes them.
  const [maxSpeedVal, setMaxSpeedVal] = useState(0.5);
  const [chargeThresholdVal, setChargeThresholdVal] = useState(20);
  const navCommittedRef = useRef({ maxSpeed: 0.5, chargeThreshold: 20 });

  // Ask the mower for its current parameters on open.
  useEffect(() => { if (online) sendCommand(sn, { get_para_info: {} }).catch(() => {}); }, [sn, online]);

  // Hydrate once from the first sensor frame that carries para data, then let
  // the operator edit freely (Save commits). Avoids stale-echo clobbering.
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current) return;
    const sv = mower.sensors;
    let got = false;

    // Gedeeld met de Start-sheet zodat de twee niet uit elkaar kunnen lopen.
    const ch = configuredHeightMm(sv);
    const ob = clampInt(sv.obstacle_avoidance_sensitivity, 1, 3);
    const pd = clampInt(sv.path_direction, 0, 180);
    const jv = clampInt(sv.manual_controller_v, 100, 300);
    const jw = clampInt(sv.manual_controller_w, 100, 300);
    const hl = sv.headlight ? (parseInt(sv.headlight, 10) || 0) > 0 : null;
    const so = sv.sound ? (parseInt(sv.sound, 10) || 0) > 0 : null;

    if (ch != null) { setCuttingHeight(ch); got = true; }
    if (ob != null) { setSensitivity(ob); got = true; }
    if (pd != null) { setPathDirection(pd); got = true; }
    if (jv != null) { setJoystickSpeed(jv); got = true; }
    if (jw != null) { setJoystickHandling(jw); got = true; }
    if (hl != null) { setHeadlight(hl); got = true; }
    if (so != null) { setSound(so); got = true; }

    if (got) {
      hydrated.current = true;
      const c = committedRef.current;
      committedRef.current = {
        ...c,
        cuttingHeight: ch ?? c.cuttingHeight,
        sensitivity: ob ?? c.sensitivity,
        pathDirection: pd ?? c.pathDirection,
        joystickSpeed: jv ?? c.joystickSpeed,
        joystickHandling: jw ?? c.joystickHandling,
        headlight: hl ?? c.headlight,
        sound: so ?? c.sound,
      };
    }
  }, [mower.sensors]);

  // Auto-save: any change to the batched fields is committed to the mower
  // (debounced 500 ms). set_para_info overwrites para.value wholesale, so the
  // full block always goes together; cutting height and timezone take their own
  // paths. When offline the commit is skipped and re-runs once `online` flips
  // back (online is in the deps), so edits made offline still land on reconnect.
  useEffect(() => {
    if (!hydrated.current || !online) return;
    const prev = committedRef.current;
    const params = buildParams({ cuttingHeight, sensitivity, pathDirection, joystickSpeed, joystickHandling, headlight, brightness, sound, timezone });
    const prevParams = buildParams(prev);
    const paraChanged = JSON.stringify(params) !== JSON.stringify(prevParams);
    const heightChanged = cuttingHeight !== prev.cuttingHeight;
    const tzChanged = timezone !== prev.timezone;
    if (!paraChanged && !heightChanged && !tzChanged) return;
    const id = setTimeout(async () => {
      setSaving(true);
      try {
        if (paraChanged) {
          await sendCommand(sn, { set_para_info: params });
          await setSensorOverride(sn, Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])));
        }
        if (heightChanged) await setSensorOverride(sn, { defaultCuttingHeight: String(cuttingHeight) });
        if (tzChanged) await sendCommand(sn, { set_cfg_info: { cfg_value: 1, tz: timezone } });
        committedRef.current = {
          cuttingHeight, sensitivity, pathDirection, joystickSpeed, joystickHandling,
          headlight, brightness, sound, timezone,
        };
        writeBrightness(brightness);
        setSavedTick(x => x + 1);
      } catch {
        toast(`✗ ${t('settings.mower.saveFailed', 'Could not save settings')}`, 'error');
      } finally {
        setSaving(false);
      }
    }, 500);
    return () => clearTimeout(id);
  }, [cuttingHeight, sensitivity, pathDirection, joystickSpeed, joystickHandling, headlight, brightness, sound, timezone, online, sn, t, toast]);

  // Auto-save navigation prefs (max speed / charge threshold) on change.
  useEffect(() => {
    if (!online) return;
    const prev = navCommittedRef.current;
    const speedChanged = maxSpeedVal !== prev.maxSpeed;
    const threshChanged = chargeThresholdVal !== prev.chargeThreshold;
    if (!speedChanged && !threshChanged) return;
    const id = setTimeout(async () => {
      setSaving(true);
      try {
        if (speedChanged) await setMaxSpeed(sn, maxSpeedVal);
        if (threshChanged) await setChargeThreshold(sn, chargeThresholdVal);
        navCommittedRef.current = { maxSpeed: maxSpeedVal, chargeThreshold: chargeThresholdVal };
        setSavedTick(x => x + 1);
      } catch {
        toast(`✗ ${t('settings.mower.saveFailed', 'Could not save settings')}`, 'error');
      } finally {
        setSaving(false);
      }
    }, 500);
    return () => clearTimeout(id);
  }, [maxSpeedVal, chargeThresholdVal, online, sn, t, toast]);

  const handleRecalibrate = async () => {
    if (!(await dialog.confirm({
      title: t('settings.mower.recalibrateTitle', 'Recalibrate charging pose'),
      message: t('settings.mower.recalibrateConfirm',
        'Overwrite the charging pose with the mower\'s CURRENT pose? The mower must be physically on its dock and charging, or future coverage will drift.'),
    }))) return;
    try {
      let resp = await recalibrateChargingPose(sn);
      if (!resp.ok && (resp.batteryState ?? '').toUpperCase() !== 'CHARGING') {
        if (!(await dialog.confirm({
          title: t('settings.mower.recalibrateForceTitle', 'Not charging'),
          message: t('settings.mower.recalibrateForce', {
            defaultValue: 'Battery state is "{{state}}" — expected CHARGING. Override the safety check anyway?',
            state: resp.batteryState ?? 'unknown',
          }),
          variant: 'danger',
        }))) return;
        resp = await recalibrateChargingPose(sn, { force: true });
      }
      if (resp.ok && resp.pose) {
        toast(`✓ ${t('settings.mower.recalibrated', 'Charging pose recalibrated')}`, 'success');
      } else {
        toast(`✗ ${resp.error ?? t('settings.mower.recalibrateFailed', 'Recalibrate failed')}`, 'error');
      }
    } catch (e) {
      if (isUnsupportedFirmwareError(e)) { toast(t('firmware.requiresOpenNova'), 'error'); return; }
      toast(`✗ ${e instanceof Error ? e.message : t('settings.mower.recalibrateFailed', 'Recalibrate failed')}`, 'error');
    }
  };

  const handleRestart = async () => {
    if (!(await dialog.confirm({
      title: t('settings.mower.restartTitle', 'Restart mower software'),
      message: t('settings.mower.restartConfirm',
        'Restart the mower software (not a full reboot)? It clears stuck states and comes back online in about a minute. Only works when idle or charging.'),
    }))) return;
    try {
      const body = await softRestartMower(sn);
      if (body.ok) {
        toast(`✓ ${t('settings.mower.restarting', 'Mower restarting — back online in ~1 min')}`, 'success');
      } else {
        toast(`✗ ${body.error ?? t('settings.mower.restartFailed', 'Restart failed')}`, 'error');
      }
    } catch (e) {
      if (isUnsupportedFirmwareError(e)) { toast(t('firmware.requiresOpenNova'), 'error'); return; }
      toast(`✗ ${e instanceof Error ? e.message : t('settings.mower.restartFailed', 'Restart failed')}`, 'error');
    }
  };

  const handleReboot = async () => {
    if (!(await dialog.confirm({
      title: t('settings.mower.rebootTitle', 'Reboot mower'),
      message: t('settings.mower.rebootConfirm', 'Reboot the mower (full OS restart)? It goes offline for a few minutes. Use Restart first for stuck states.'),
      variant: 'danger',
    }))) return;
    try {
      await rebootMower(sn);
      toast(`✓ ${t('settings.mower.rebooting', 'Reboot sent — the mower is offline for a few minutes')}`, 'success');
    } catch (e) {
      if (isUnsupportedFirmwareError(e)) { toast(t('firmware.requiresOpenNova'), 'error'); return; }
      toast(`✗ ${e instanceof Error ? e.message : t('settings.mower.rebootFailed', 'Reboot failed')}`, 'error');
    }
  };

  // ── small style helpers ──
  const seg = (active: boolean) =>
    `flex-1 px-3 py-2 rounded-lg text-sm font-semibold transition-colors ${
      active ? 'bg-emerald-600 text-white' : 'bg-gray-800/60 text-gray-400 hover:text-gray-200 border border-gray-700'
    }`;
  const stepBtn = 'grid place-items-center w-9 h-9 rounded-lg bg-gray-800/70 border border-gray-700 text-gray-300 hover:text-white hover:border-gray-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const tzOptions = COMMON_TIMEZONES.includes(timezone) ? COMMON_TIMEZONES : [timezone, ...COMMON_TIMEZONES];

  return (
    <>
      {/* Cutting height */}
      <SettingCard icon={Scissors} title={t('settings.mower.cuttingHeight', 'Cutting height')}>
        <div className="text-center mb-3">
          <span className="font-mono text-3xl font-bold text-emerald-400 tabular-nums">
            {Math.round(cuttingHeight / 10)} <span className="text-xl text-emerald-400/70">cm</span>
          </span>
        </div>
        <div className="grid grid-cols-8 gap-1.5">
          {HEIGHT_CM.map(cm => {
            const active = Math.round(cuttingHeight / 10) === cm;
            return (
              <button
                key={cm}
                onClick={() => setCuttingHeight(cm * 10)}
                className={`py-2 rounded-lg text-sm font-mono font-semibold tabular-nums transition-colors ${
                  active ? 'bg-emerald-600 text-white' : 'bg-gray-800/60 text-gray-400 hover:text-gray-200 border border-gray-700'
                }`}
              >
                {cm}
              </button>
            );
          })}
        </div>
      </SettingCard>

      {/* Obstacle avoidance */}
      <SettingCard icon={Shield} title={t('settings.mower.obstacle', 'Obstacle avoidance')}>
        <div className="space-y-2">
          {SENSITIVITY.map(o => {
            const active = sensitivity === o.value;
            return (
              <button
                key={o.value}
                onClick={() => setSensitivity(o.value)}
                className={`w-full flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                  active ? 'border-emerald-500/60 bg-emerald-900/20' : 'border-gray-700 bg-gray-800/40 hover:bg-gray-800/70'
                }`}
              >
                <span className={`grid place-items-center w-5 h-5 rounded-full border-2 flex-shrink-0 ${active ? 'border-emerald-400' : 'border-gray-600'}`}>
                  {active && <span className="w-2 h-2 rounded-full bg-emerald-400" />}
                </span>
                <span className="flex-1">
                  <span className={`block text-sm font-semibold ${active ? 'text-emerald-300' : 'text-white'}`}>
                    {t(`settings.mower.sensitivity.${o.key}`, o.key === 'low' ? 'Off (terrain only)' : o.key === 'medium' ? 'Avoid objects' : 'Avoid objects (frequent)')}
                  </span>
                  <span className="block text-xs text-gray-500">
                    {t(`settings.mower.sensitivity.${o.key}Desc`,
                      o.key === 'low' ? 'Segmentation only, no object detection (max coverage)'
                      : o.key === 'medium' ? 'Periodic object detection while mowing'
                      : 'Frequent object detection (best avoidance)')}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </SettingCard>

      {/* Mowing direction */}
      <SettingCard icon={Compass} title={t('settings.mower.direction', 'Mowing direction')}>
        <div className="flex items-center gap-3 rounded-xl border border-gray-700 bg-gray-900/60 p-2.5">
          <div className="shrink-0 rounded-lg bg-gray-950/40 p-1">
            <MowingDirectionPreview direction={pathDirection} size={92} />
          </div>
          <div className="flex-1">
            <div className="flex items-center justify-between gap-2">
              <button
                onClick={() => setPathDirection(Math.max(0, pathDirection - 15))}
                disabled={pathDirection <= 0}
                className={stepBtn}
                aria-label={t('settings.mower.directionDown', 'Rotate direction down')}
              >
                <Minus className="w-4 h-4" />
              </button>
              <span className="font-mono text-2xl font-bold text-white tabular-nums">{pathDirection}&deg;</span>
              <button
                onClick={() => setPathDirection(Math.min(180, pathDirection + 15))}
                disabled={pathDirection >= 180}
                className={stepBtn}
                aria-label={t('settings.mower.directionUp', 'Rotate direction up')}
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
            <p className="mt-1.5 text-[10px] text-gray-500 text-center leading-snug">
              {t('settings.mower.directionHint', 'Stripes show how the mower drives')}
            </p>
          </div>
        </div>
      </SettingCard>

      {/* Joystick max speed */}
      <SettingCard icon={Gauge} title={t('settings.mower.joystickSpeed', 'Joystick max speed')}>
        <div className="flex gap-2">
          {CONTROLLER.map(o => (
            <button key={o.value} onClick={() => setJoystickSpeed(o.value)} className={seg(joystickSpeed === o.value)}>
              {t(`settings.mower.level.${o.key}`, o.key === 'low' ? 'Low' : o.key === 'medium' ? 'Medium' : 'High')}
            </button>
          ))}
        </div>
      </SettingCard>

      {/* Joystick handling */}
      <SettingCard icon={Gamepad2} title={t('settings.mower.joystickHandling', 'Joystick handling')}>
        <div className="flex gap-2">
          {CONTROLLER.map(o => (
            <button key={o.value} onClick={() => setJoystickHandling(o.value)} className={seg(joystickHandling === o.value)}>
              {t(`settings.mower.level.${o.key}`, o.key === 'low' ? 'Low' : o.key === 'medium' ? 'Medium' : 'High')}
            </button>
          ))}
        </div>
      </SettingCard>

      {/* Max speed */}
      <SettingCard icon={Gauge} title={t('settings.mower.maxSpeed', 'Max speed')}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-wide text-gray-500">{t('settings.mower.maxSpeedHint', 'Autonomous mowing speed')}</span>
          <span className="font-mono text-sm font-semibold text-white tabular-nums">{maxSpeedVal.toFixed(1)} m/s</span>
        </div>
        <input
          type="range" min={0.1} max={1.0} step={0.1}
          value={maxSpeedVal}
          onChange={e => setMaxSpeedVal(parseFloat(e.target.value))}
          className="w-full h-1.5 accent-emerald-500 bg-gray-700 rounded-full appearance-none cursor-pointer"
        />
        <div className="flex justify-between text-[9px] text-gray-600 mt-0.5"><span>0.1</span><span>1.0 m/s</span></div>
      </SettingCard>

      {/* Charge threshold */}
      <SettingCard icon={Battery} title={t('settings.mower.chargeThreshold', 'Return-to-dock battery level')}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-wide text-gray-500">{t('settings.mower.chargeThresholdHint', 'Go charge when battery drops below')}</span>
          <span className="font-mono text-sm font-semibold text-white tabular-nums">{chargeThresholdVal}%</span>
        </div>
        <input
          type="range" min={10} max={50} step={5}
          value={chargeThresholdVal}
          onChange={e => setChargeThresholdVal(parseInt(e.target.value, 10))}
          className="w-full h-1.5 accent-emerald-500 bg-gray-700 rounded-full appearance-none cursor-pointer"
        />
        <div className="flex justify-between text-[9px] text-gray-600 mt-0.5"><span>10%</span><span>50%</span></div>
      </SettingCard>

      {/* Other: headlight, speaker, timezone */}
      <SettingCard icon={Monitor} title={t('settings.mower.other', 'Other')}>
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-2 text-sm text-zinc-200">
                <Lightbulb className={`w-4 h-4 ${headlight ? 'text-amber-400' : 'text-gray-500'}`} />
                {t('settings.mower.headlight', 'Headlight')}
              </span>
              <Toggle on={headlight} onChange={setHeadlight} />
            </div>
            <div className="mt-2 flex items-center gap-2.5">
              <span className="text-[10px] uppercase tracking-wide text-gray-500 w-16">{t('settings.mower.brightness', 'Brightness')}</span>
              <input
                type="range" min={1} max={255} step={1}
                value={brightness}
                disabled={!headlight}
                onChange={e => setBrightness(parseInt(e.target.value, 10))}
                className="flex-1 h-1.5 accent-amber-500 bg-gray-700 rounded-full appearance-none cursor-pointer disabled:opacity-40"
              />
              <span className="text-xs font-mono text-gray-300 w-8 text-right">{brightness}</span>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-2 text-sm text-zinc-200">
              <Volume2 className={`w-4 h-4 ${sound ? 'text-emerald-400' : 'text-gray-500'}`} />
              {t('settings.mower.speaker', 'Speaker')}
            </span>
            <Toggle on={sound} onChange={setSound} />
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 text-sm text-zinc-200">
              <Clock className="w-4 h-4 text-gray-500" />
              {t('settings.mower.timezone', 'Timezone')}
            </span>
            <select
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              className="bg-gray-900/60 border border-gray-700 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500 max-w-[60%]"
            >
              {tzOptions.map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>
        </div>
      </SettingCard>

      {/* Auto-save status (changes save automatically, debounced) */}
      <div className="text-center text-[11px] min-h-[16px]">
        {saving ? (
          <span className="inline-flex items-center gap-1.5 text-gray-400"><Loader2 className="w-3 h-3 animate-spin" />{t('settings.mower.saving', 'Saving…')}</span>
        ) : !online ? (
          <span className="text-amber-400/80">{t('settings.mower.offlinePending', 'Mower offline — changes save once it reconnects.')}</span>
        ) : savedTick > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-emerald-400"><Check className="w-3 h-3" />{t('settings.mower.savedAuto', 'Changes saved automatically')}</span>
        ) : (
          <span className="text-gray-600">{t('settings.mower.autoSaveHint', 'Changes save automatically')}</span>
        )}
      </div>

      {/* Recovery */}
      <SettingCard icon={Wrench} title={t('settings.mower.recovery', 'Recovery')}>
        <div className="space-y-2">
          {!firmwareSupported && (
            <p className="text-xs text-amber-300/90 leading-snug">{t('firmware.requiresOpenNova')}</p>
          )}
          <button
            onClick={handleRecalibrate}
            disabled={!online || !firmwareSupported}
            title={!firmwareSupported ? t('firmware.requiresOpenNova') : undefined}
            className="w-full flex items-center gap-3 rounded-xl border border-gray-700 bg-gray-800/40 hover:bg-gray-800/70 px-3 py-2.5 text-left transition-colors disabled:opacity-40"
          >
            <Compass className="w-4 h-4 text-rose-400 flex-shrink-0" />
            <span className="flex-1">
              <span className="block text-sm font-semibold text-white">{t('settings.mower.recalibrate', 'Recalibrate charging pose')}</span>
              <span className="block text-xs text-gray-500">{t('settings.mower.recalibrateDesc', 'Overwrites map_info.json with the current pose. Put the mower on its dock first — it must be CHARGING.')}</span>
            </span>
          </button>
          <button
            onClick={handleRestart}
            disabled={!online || !firmwareSupported}
            title={!firmwareSupported ? t('firmware.requiresOpenNova') : undefined}
            className="w-full flex items-center gap-3 rounded-xl border border-gray-700 bg-gray-800/40 hover:bg-gray-800/70 px-3 py-2.5 text-left transition-colors disabled:opacity-40"
          >
            <RotateCw className="w-4 h-4 text-violet-400 flex-shrink-0" />
            <span className="flex-1">
              <span className="block text-sm font-semibold text-white">{t('settings.mower.restart', 'Restart mower')}</span>
              <span className="block text-xs text-gray-500">{t('settings.mower.restartDesc', 'Restarts the mower software (not a reboot). Clears stuck states; back online in ~1 min.')}</span>
            </span>
          </button>
          <button
            onClick={handleReboot}
            disabled={!online || !firmwareSupported}
            title={!firmwareSupported ? t('firmware.requiresOpenNova') : undefined}
            className="w-full flex items-center gap-3 rounded-xl border border-gray-700 bg-gray-800/40 hover:bg-gray-800/70 px-3 py-2.5 text-left transition-colors disabled:opacity-40"
          >
            <Power className="w-4 h-4 text-red-400 flex-shrink-0" />
            <span className="flex-1">
              <span className="block text-sm font-semibold text-white">{t('settings.mower.reboot', 'Reboot mower')}</span>
              <span className="block text-xs text-gray-500">{t('settings.mower.rebootDesc', 'Full OS restart. Offline for a few minutes — use Restart first for stuck states.')}</span>
            </span>
          </button>
        </div>
      </SettingCard>
    </>
  );
}

function RainAutoPauseCard({ sn }: { sn: string }) {
  const { t } = useTranslation();
  const [rain, setRain] = useState<RainSettings>({
    enabled: true, thresholdMm: 0.1, thresholdProbability: 50, lookaheadHours: 0.5,
    nightGuard: false, frostGuard: false, frostThresholdC: 3,
  });

  useEffect(() => { fetchRainSettings(sn).then(setRain).catch(() => {}); }, [sn]);

  // Instant-apply: each control PUTs its patch immediately.
  const patchRain = (patch: Partial<RainSettings>) => {
    setRain(prev => ({ ...prev, ...patch }));
    updateRainSettings(sn, patch).catch(() => {});
  };

  return (
    <SettingCard icon={CloudRain} title={t('settings.mower.rain', 'Weather & time')}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <span className="block text-sm font-semibold text-white">{t('settings.mower.rainPause', 'Pause when raining')}</span>
          <span className="block text-xs text-gray-500">
            {t('settings.mower.rainSummary', {
              defaultValue: '≥ {{mm}} mm or ≥ {{prob}}% within {{h}}',
              mm: rain.thresholdMm, prob: rain.thresholdProbability,
              h: (RAIN_HOURS.find(x => x.value === rain.lookaheadHours)?.label) ?? `${rain.lookaheadHours}h`,
            })}
          </span>
        </div>
        <Toggle on={rain.enabled} onChange={v => patchRain({ enabled: v })} />
      </div>
      {rain.enabled && (
        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] uppercase tracking-wide text-gray-500">{t('settings.mower.rainMm', 'Min rainfall')}</span>
              <span className="text-xs font-mono text-gray-300">{rain.thresholdMm.toFixed(1)} mm</span>
            </div>
            <div className="flex gap-1.5">
              {RAIN_MM.map(v => (
                <button key={v} onClick={() => patchRain({ thresholdMm: v })} className={chipClass(rain.thresholdMm === v)}>{v.toFixed(1)}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] uppercase tracking-wide text-gray-500">{t('settings.mower.rainProb', 'Min probability')}</span>
              <span className="text-xs font-mono text-gray-300">{rain.thresholdProbability}%</span>
            </div>
            <div className="flex gap-1.5">
              {RAIN_PROB.map(v => (
                <button key={v} onClick={() => patchRain({ thresholdProbability: v })} className={chipClass(rain.thresholdProbability === v)}>{v}%</button>
              ))}
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] uppercase tracking-wide text-gray-500">{t('settings.mower.rainHours', 'Look ahead')}</span>
            </div>
            <div className="flex gap-1.5">
              {RAIN_HOURS.map(o => (
                <button key={o.value} onClick={() => patchRain({ lookaheadHours: o.value })} className={chipClass(rain.lookaheadHours === o.value)}>{o.label}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Nacht-/vorstbewaking: alleen geplande beurten, handmatig start altijd. */}
      <div className="flex items-center justify-between mt-4 pt-3 border-t border-gray-800">
        <div>
          <span className="block text-sm font-semibold text-white">{t('settings.mower.nightGuard', 'No mowing after dark')}</span>
          <span className="block text-xs text-gray-500">
            {rain.nightGuard
              ? t('settings.mower.nightGuardOn', 'Scheduled runs between sunset and sunrise are skipped (protects hedgehogs)')
              : t('settings.mower.nightGuardOff', 'Scheduled runs may mow at night')}
          </span>
        </div>
        <Toggle on={rain.nightGuard} onChange={v => patchRain({ nightGuard: v })} />
      </div>
      <div className="flex items-center justify-between mt-3">
        <div>
          <span className="block text-sm font-semibold text-white">{t('settings.mower.frostGuard', 'No mowing in frost')}</span>
          <span className="block text-xs text-gray-500">
            {rain.frostGuard
              ? t('settings.mower.frostGuardOn', { defaultValue: 'Scheduled runs are skipped below {{c}} °C', c: rain.frostThresholdC })
              : t('settings.mower.frostGuardOff', 'Scheduled runs ignore the temperature')}
          </span>
        </div>
        <Toggle on={rain.frostGuard} onChange={v => patchRain({ frostGuard: v })} />
      </div>
      {rain.frostGuard && (
        <div className="mt-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase tracking-wide text-gray-500">{t('settings.mower.frostThreshold', 'Skip below')}</span>
            <span className="text-xs font-mono text-gray-300">{rain.frostThresholdC} °C</span>
          </div>
          <div className="flex gap-1.5">
            {[0, 1, 3, 5].map(v => (
              <button key={v} onClick={() => patchRain({ frostThresholdC: v })} className={chipClass(rain.frostThresholdC === v)}>{v} °C</button>
            ))}
          </div>
        </div>
      )}
    </SettingCard>
  );
}

function DisplayCard() {
  const { t } = useTranslation();
  const [ws, setWs] = useState<WeekStart>(() => readWeekStart());
  const [tf, setTf] = useState<TimeFormat>(() => readTimeFormat());

  const chooseWs = (v: WeekStart) => { setWs(v); writeWeekStart(v); };
  const chooseTf = (v: TimeFormat) => { setTf(v); writeTimeFormat(v); };

  const seg = (current: string, v: string, label: string, onClick: () => void) => (
    <button
      key={v}
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
        current === v
          ? 'bg-emerald-600 text-white'
          : 'bg-gray-800/60 text-gray-400 hover:text-gray-200 border border-gray-700'
      }`}
    >
      {label}
    </button>
  );

  return (
    <SettingCard
      icon={Monitor}
      title={t('settings.display.title', 'Display')}
      help={t('settings.display.help', 'How days and times are shown in the scheduler and timeline.')}
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-zinc-300">{t('settings.weekStart.title', 'Week start')}</span>
          <div className="inline-flex gap-1.5">
            {seg(ws, 'mon', t('settings.weekStart.mon', 'Monday'), () => chooseWs('mon'))}
            {seg(ws, 'sun', t('settings.weekStart.sun', 'Sunday'), () => chooseWs('sun'))}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-zinc-300">{t('settings.timeFormat.title', 'Time format')}</span>
          <div className="inline-flex gap-1.5">
            {seg(tf, '24h', t('settings.timeFormat.h24', '24h'), () => chooseTf('24h'))}
            {seg(tf, '12h', t('settings.timeFormat.h12', '12h'), () => chooseTf('12h'))}
          </div>
        </div>
      </div>
    </SettingCard>
  );
}

function ExperimentalCard() {
  const { t } = useTranslation();
  const [on, setOn] = useState(() => readExperimental());
  const choose = (v: boolean) => { setOn(v); writeExperimental(v); };

  return (
    <SettingCard
      icon={FlaskConical}
      title={t('settings.experimental.title', 'Experimental features')}
      help={t('settings.experimental.help', 'Unfinished features that may change or break. Off by default.')}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="block text-sm font-semibold text-white">
            {t('settings.experimental.enable', 'Enable experimental features')}
          </span>
          <span className="block text-xs text-gray-500">
            {t('settings.experimental.note', 'Currently unlocks the Terrain tab.')}
          </span>
        </div>
        <Toggle on={on} onChange={choose} />
      </div>
    </SettingCard>
  );
}

function AutoMapCard() {
  const { t } = useTranslation();
  const [on, setOn] = useState(() => readAutoMapEnabled());
  const choose = (v: boolean) => { setOn(v); writeAutoMapEnabled(v); };

  return (
    <SettingCard
      icon={Compass}
      title={t('settings.autoMap.title', 'Autonomous mapping')}
      help={t('settings.autoMap.help', 'Experimental feature for letting the mower map its own boundary.')}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="block text-sm font-semibold text-white">
            {t('settings.autoMap.show', 'Show panel below the map')}
          </span>
          <span className="block text-xs text-gray-500">
            {t('settings.autoMap.note', 'A running session stays visible even with this off.')}
          </span>
        </div>
        <Toggle on={on} onChange={choose} />
      </div>
    </SettingCard>
  );
}

/** Credentials for the 3D garden render. The key is write-only: the server
 *  reports which mode is active, never the value. */
// ── Drone photo (#124) ───────────────────────────────────────────────────────
// Upload, replace, remove, or take over another mower's photo. Placing it and
// showing it are map work and stay on the map (View › Drone photo).

const DRONE_BTN = 'inline-flex items-center gap-2 rounded-xl border border-gray-700 bg-gray-800/40 hover:bg-gray-800/70 px-3 py-2 text-sm text-gray-200 transition-colors disabled:opacity-50';

function DronePhotoCard({ sn }: { sn: string }) {
  const { t } = useTranslation();
  const dialog = useDialog();
  const [meta, setMeta] = useState<DroneOverlayMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const [sources, setSources] = useState<Array<{ sn: string; label: string }>>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let alive = true;
    fetchDroneOverlay(sn).then(m => { if (alive) setMeta(m); }).catch(() => { /* no photo is not an error */ });
    // Other mowers with a photo: same garden, same photo, so offer to take it
    // over (placement included) instead of uploading and placing again.
    fetchDevices().then(async devs => {
      const others = devs.filter(d => d.deviceType === 'mower' && d.sn !== sn);
      const withPhoto = await Promise.all(others.map(async d => ((await fetchDroneOverlay(d.sn).catch(() => null)) ? d : null)));
      if (alive) setSources(withPhoto.flatMap(d => (d ? [{ sn: d.sn, label: d.nickname || d.sn }] : [])));
    }).catch(() => { /* no list, no rows */ });
    return () => { alive = false; };
  }, [sn]);

  const run = async (work: () => Promise<DroneOverlayMeta | null>) => {
    setBusy(true);
    try { setMeta(await work()); }
    catch (e) { void dialog.alert({ title: t('settings.drone.failed', 'Dat lukte niet'), message: e instanceof Error ? e.message : String(e), variant: 'danger' }); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const onFile = (file?: File) => { if (file) void run(() => uploadDroneOverlay(sn, file, null)); };
  const remove = async () => {
    if (!(await dialog.confirm({ title: t('map.droneRemove', 'Dronefoto verwijderen'), message: t('map.droneRemoveConfirm', 'De dronefoto van deze maaier verwijderen?'), variant: 'danger' }))) return;
    void run(async () => { await deleteDroneOverlay(sn); return null; });
  };
  const copyFrom = async (from: string) => {
    if (meta && !(await dialog.confirm({ title: t('settings.drone.copyTitle', 'Dronefoto overnemen'), message: t('map.droneCopyConfirm', 'De huidige dronefoto van deze maaier wordt vervangen. Doorgaan?') }))) return;
    void run(() => copyDroneOverlay(sn, from));
  };

  return (
    <SettingCard
      icon={ImageIcon}
      title={t('settings.drone.title', 'Dronefoto')}
      help={t('settings.drone.help', 'Een eigen foto recht van boven, onder de kaart: scherper dan de luchtfoto, handig om zones op te tekenen en als bron voor de 3D-render. Plaatsen en tonen doe je op de kaart, via Weergave › Dronefoto.')}
    >
      {meta ? (
        <div className="flex items-center gap-3">
          <img src={droneOverlayImageUrl(sn, meta.updatedAt)} alt="" className="w-24 h-16 object-cover rounded-lg border border-gray-700 bg-gray-800" />
          <div className="flex-1 min-w-0 text-xs text-gray-400 space-y-0.5">
            <div className="text-sm text-white">{meta.width} × {meta.height}</div>
            <div>{new Date(meta.updatedAt).toLocaleString()}</div>
            <div className={meta.placement ? 'text-emerald-400' : 'text-amber-400'}>
              {meta.placement
                ? t('settings.drone.placed', 'Geplaatst op de kaart')
                : t('settings.drone.notPlaced', 'Nog niet geplaatst: Kaart › Weergave › Dronefoto › Plaatsen')}
            </div>
          </div>
        </div>
      ) : (
        <p className="text-sm text-gray-400">{t('settings.drone.none', 'Nog geen dronefoto voor deze maaier.')}</p>
      )}
      <div className="flex flex-wrap gap-2 mt-3">
        <button onClick={() => fileRef.current?.click()} disabled={busy} className={DRONE_BTN}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          {meta ? t('map.droneReplace', 'Dronefoto vervangen…') : t('map.droneUpload', 'Dronefoto uploaden…')}
        </button>
        {meta && (
          <button onClick={() => void remove()} disabled={busy} className={DRONE_BTN}>
            <Trash2 className="w-4 h-4" />{t('map.droneRemove', 'Dronefoto verwijderen')}
          </button>
        )}
        {sources.map(src => (
          <button key={src.sn} onClick={() => void copyFrom(src.sn)} disabled={busy} className={DRONE_BTN} title={src.sn}>
            <Copy className="w-4 h-4" />{t('settings.drone.copyFrom', 'Overnemen van {{name}}', { name: src.label })}
          </button>
        ))}
      </div>
      <input ref={fileRef} type="file" accept="image/jpeg,image/png" className="hidden" onChange={e => onFile(e.target.files?.[0])} />
    </SettingCard>
  );
}

function GardenRenderCard() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<string>('none');
  const [model, setModel] = useState('');
  const [credits, setCredits] = useState<number | null>(null);
  const [key, setKey] = useState('');
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { fetchRenderSettings().then(r => { setMode(r.mode); setModel(r.model); setCredits(r.credits?.credits ?? null); }).catch(() => {}); }, []);

  const save = async (body: { openaiKey?: string | null; relayToken?: string | null }) => {
    setSaving(true);
    try { setMode((await saveRenderSettings(body)).mode); setKey(''); setToken(''); }
    catch { /* ignore */ }
    setSaving(false);
  };

  const label = mode === 'own-key' ? t('settings.render.modeOwn', 'Eigen sleutel ingesteld')
    : mode === 'relay' ? t('settings.render.modeRelay', 'Tegoed-token ingesteld')
    : t('settings.render.modeNone', 'Nog niets ingesteld');

  return (
    <SettingCard icon={Box} title={t('settings.render.title', '3D-render')}
      help={t('settings.render.help', 'Maakt een 3D-plaatje van je eigen tuin uit de kaart van de maaier. Kost per render ongeveer 20 cent bij OpenAI.')}>
      <div className="text-xs text-gray-400 mb-3">
        {label}{model ? ` · ${model}` : ''}
        {credits != null && ` · ${t('settings.render.credits', '{{n}} renders over', { n: credits })}`}
      </div>
      <div className="space-y-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">{t('settings.render.ownKey', 'Eigen OpenAI-sleutel')}</div>
          <div className="flex gap-2">
            <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder="sk-…" autoComplete="off"
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600" />
            <button onClick={() => void save({ openaiKey: key })} disabled={!key || saving}
              className="px-3 py-2 rounded-lg text-sm font-semibold bg-emerald-600 text-white disabled:opacity-40">{t('settings.render.save', 'Opslaan')}</button>
          </div>
          <p className="text-[11px] text-gray-500 mt-1">{t('settings.render.ownKeyHint', 'Geen ChatGPT-abonnement nodig: een API-account met een klein prepaid tegoed volstaat.')}</p>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">{t('settings.render.token', 'Tegoed-token (via OpenNova)')}</div>
          <div className="flex gap-2">
            <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="opennova-…" autoComplete="off"
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600" />
            <button onClick={() => void save({ relayToken: token })} disabled={!token || saving}
              className="px-3 py-2 rounded-lg text-sm font-semibold bg-gray-700 text-white disabled:opacity-40">{t('settings.render.save', 'Opslaan')}</button>
          </div>
        </div>
        {mode !== 'none' && (
          <button onClick={() => void save({ openaiKey: null, relayToken: null })} disabled={saving}
            className="text-xs text-red-400 hover:text-red-300">{t('settings.render.clear', 'Verwijderen')}</button>
        )}
        <p className="text-[11px] text-amber-400/90">
          {t('settings.render.privacy', 'Let op: bij een render gaat een luchtfoto van je tuin naar OpenAI. Doe dit alleen als je dat goed vindt.')}
        </p>
      </div>
    </SettingCard>
  );
}

/** "Report a problem": GitHub bug-template met versies, SN en laatste fout
 *  voorgevuld. Query-keys = veld-ids van .github/ISSUE_TEMPLATE/bug_report.yml.
 *  Zelfde als Settings → Help in de app. */
function HelpCard({ mower }: { mower: DeviceState }) {
  const { t } = useTranslation();
  const report = async () => {
    const serverVersion = await getServerVersion();
    const err = mower.sensors?.error_status;
    const q = new URLSearchParams({
      template: 'bug_report.yml',
      app: 'Web dashboard only',
      server_version: serverVersion,
      mower_sn: mower.sn,
      mower_firmware: mower.sensors?.sw_version ?? '',
      what_happened: err && err !== '0' ? `Last error_status: ${err}\nLast msg: ${mower.sensors?.msg ?? ''}\n\n` : '',
    });
    window.open(`https://github.com/rvbcrs/Novabot/issues/new?${q.toString()}`, '_blank', 'noopener');
  };
  return (
    <SettingCard icon={Bug} title={t('settings.help.title', 'Help')}>
      <button
        onClick={() => void report()}
        className="w-full flex items-center gap-3 rounded-xl border border-gray-700 bg-gray-800/40 hover:bg-gray-800/70 px-3 py-2.5 text-left transition-colors"
      >
        <span className="flex-1">
          <span className="block text-sm font-semibold text-white">{t('settings.help.report', 'Report a problem')}</span>
          <span className="block text-xs text-gray-500">{t('settings.help.reportDesc', 'Opens a GitHub issue with your server and firmware versions filled in')}</span>
        </span>
        <ExternalLink className="w-4 h-4 text-gray-500 flex-shrink-0" />
      </button>
    </SettingCard>
  );
}

function NotificationsCard() {
  const { t } = useTranslation();
  const items: Array<{ icon: React.ComponentType<{ className?: string }>; label: string }> = [
    { icon: Smartphone, label: t('settings.notifications.push') },
    { icon: Radio, label: t('settings.notifications.ntfy') },
    { icon: HomeIcon, label: t('settings.notifications.ha') },
    { icon: Mail, label: t('settings.notifications.email') },
  ];
  return (
    <SettingCard icon={Bell} title={t('settings.notifications.title')} help={t('settings.notifications.help')}>
      <ul className="space-y-2">
        {items.map(({ icon: Icon, label }) => (
          <li key={label} className="flex items-center justify-between bg-gray-800/50 border border-gray-700/60 rounded-xl px-3 py-2.5">
            <span className="inline-flex items-center gap-2.5 text-sm text-zinc-200">
              <Icon className="w-4 h-4 text-gray-500" />
              {label}
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-gray-700/40 text-gray-500 border border-gray-600/40">
              {t('settings.notifications.comingSoon')}
            </span>
          </li>
        ))}
      </ul>
    </SettingCard>
  );
}
