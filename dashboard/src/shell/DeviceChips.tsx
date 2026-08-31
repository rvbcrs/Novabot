import React, { useState, useEffect } from 'react';
import {
  BatteryMedium, BatteryCharging, Satellite, Wifi, Thermometer,
  Activity, ChevronDown, Gauge, Zap, Radio,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Drawer } from './Drawer';
import type { DeviceState } from '../types';
import { fetchLoraStatus, type LoraStatus } from '../api/client';
import { workStatusLabel } from '../utils/workStatus';
import { deriveMowerActivity } from '../utils/mowerActivity';

interface Props {
  mower: DeviceState | null;
  charger?: DeviceState | null;
  knownMowers: DeviceState[];
  onSelectMower: (sn: string) => void;
  /** Which half to render. Lets the shell place the mower switcher and the live
   *  telemetry capsule on opposite ends of the tab row. Omit to render both. */
  part?: 'identity' | 'telemetry';
}

/**
 * A MAC is worth showing only when it's a well-formed 6-byte address that isn't
 * an obvious placeholder. Imported / anonymised devices can carry sentinels like
 * AA:AA:AA:AA:AA:AA, 00:00:00:00:00:00 or FF:..:FF (every byte identical) — we
 * hide those rather than show a fake address.
 */
function isDisplayableMac(mac?: string | null): boolean {
  if (!mac) return false;
  const parts = mac.split(':');
  if (parts.length !== 6 || !parts.every(p => /^[0-9a-f]{2}$/i.test(p))) return false;
  const first = parts[0].toLowerCase();
  if (parts.every(p => p.toLowerCase() === first)) return false; // all bytes identical → placeholder
  return true;
}

// ── Mower identity row (status dot + name + firmware subtitle) ───────────────
// Mirrors the OpenNova app's device picker: an online/offline dot before the
// name, with the firmware version as a muted subtitle.

function MowerIdentityRow({ online, name, sub }: { online: boolean; name: string; sub: string }) {
  return (
    <>
      <span className="relative grid place-items-center shrink-0">
        <span
          className={`w-2 h-2 rounded-full ${online ? 'bg-emerald-400' : 'bg-zinc-500'}`}
          style={online ? { boxShadow: '0 0 0 3px rgba(52,211,153,.18)' } : undefined}
        />
      </span>
      <span className="flex flex-col items-start leading-tight min-w-0">
        <span className="text-sm font-semibold text-zinc-100 truncate max-w-[170px]">{name}</span>
        <span className="text-[10px] font-mono text-zinc-500 truncate max-w-[170px]">{sub}</span>
      </span>
    </>
  );
}

// ── Sensor grouping ──────────────────────────────────────────────────────────

const GROUPS: Array<{ label: string; test: (key: string) => boolean }> = [
  {
    label: 'Battery',
    test: k => k.startsWith('battery_'),
  },
  {
    label: 'Localization',
    test: k =>
      k.startsWith('gps_') ||
      k.startsWith('rtk') ||
      k.startsWith('loc_') ||
      k === 'map_position' ||
      k === 'latitude' ||
      k === 'longitude' ||
      k === 'altitude',
  },
  {
    label: 'Network',
    test: k => k.startsWith('wifi_') || k.startsWith('cpu_') || k.startsWith('mqtt_'),
  },
  {
    label: 'Work',
    test: k =>
      k.startsWith('work_') ||
      k.startsWith('mowing_') ||
      k.startsWith('cov_') ||
      k.startsWith('recharge_') ||
      k.startsWith('error_') ||
      k === 'light' ||
      k === 'target_height',
  },
];

// ── Telemetry capsule cell ───────────────────────────────────────────────────
// One readout inside the status capsule: a muted icon + a mono value, with a
// hairline divider on the right (the capsule strips the last divider).

function TeleCell({
  icon: Icon,
  value,
  color = 'text-zinc-200',
  iconColor = 'text-zinc-500',
  label,
  blink = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  value: string | number;
  color?: string;
  iconColor?: string;
  label?: string;
  /** Pulse the whole cell (e.g. a dangerous temperature) to draw attention. */
  blink?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 border-r border-zinc-700/40 last:border-r-0${blink ? ' animate-pulse' : ''}`}
      title={label}
    >
      <Icon className={`w-3.5 h-3.5 ${iconColor}`} />
      <span className={`tabular-nums text-xs font-semibold ${color}`}>{value}</span>
    </span>
  );
}

// ── Sensor detail panel (rendered inside Drawer) ─────────────────────────────

function SensorDetailPanel({ mower, openedAt }: { mower: DeviceState; openedAt: number }) {
  const s = mower.sensors;
  const allKeys = Object.keys(s).sort();

  // Build grouped sections
  const sections: Array<{ label: string; entries: Array<[string, string]> }> = [];
  const used = new Set<string>();

  for (const group of GROUPS) {
    const entries = allKeys
      .filter(k => group.test(k))
      .map(k => [k, s[k]] as [string, string]);
    if (entries.length > 0) {
      sections.push({ label: group.label, entries });
      entries.forEach(([k]) => used.add(k));
    }
  }

  const otherEntries = allKeys
    .filter(k => !used.has(k))
    .map(k => [k, s[k]] as [string, string]);
  if (otherEntries.length > 0) {
    sections.push({ label: 'Other', entries: otherEntries });
  }

  return (
    <div className="space-y-3">
      {/* Identity row */}
      <div className="pb-2 border-b border-zinc-800 space-y-0.5">
        <p className="text-[10px] font-mono text-zinc-400">{mower.sn}</p>
        {isDisplayableMac(mower.macAddress) && (
          <p className="text-[10px] font-mono text-zinc-600">{mower.macAddress}</p>
        )}
        <p className="text-[10px] text-zinc-600">
          Updated: {new Date(openedAt).toISOString()}
        </p>
      </div>

      {/* Grouped sensor table */}
      {sections.map(({ label, entries }) => (
        <div key={label}>
          <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide mb-1">
            {label}
          </p>
          <table className="w-full text-[11px] font-mono">
            <tbody>
              {entries.map(([k, v]) => (
                <tr key={k} className="odd:bg-zinc-900/40">
                  <td className="pr-3 py-0.5 text-zinc-500 whitespace-nowrap align-top">{k}</td>
                  <td className="py-0.5 text-zinc-300 break-all">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {allKeys.length === 0 && (
        <p className="text-xs text-zinc-600 italic">No sensor data yet.</p>
      )}
    </div>
  );
}

// ── Summary panel (rendered inside Drawer — default view) ────────────────────

// ── Nice tone-coloured chip for the drawer (icon + label + value) ────────────
type ChipTone = 'emerald' | 'amber' | 'sky' | 'red' | 'zinc';
const CHIP_TONE: Record<ChipTone, { box: string; icon: string }> = {
  emerald: { box: 'border-emerald-700/40 bg-emerald-900/15 text-emerald-200', icon: 'text-emerald-400' },
  amber:   { box: 'border-amber-700/40 bg-amber-900/15 text-amber-200',       icon: 'text-amber-400' },
  sky:     { box: 'border-sky-700/40 bg-sky-900/15 text-sky-200',             icon: 'text-sky-400' },
  red:     { box: 'border-red-700/40 bg-red-900/15 text-red-200',             icon: 'text-red-400' },
  zinc:    { box: 'border-zinc-700/60 bg-zinc-900/60 text-zinc-200',          icon: 'text-zinc-400' },
};

type ChipDef = { icon: React.ComponentType<{ className?: string }>; label: string; value: string | number; tone: ChipTone };

function DrawerChip({ icon: Icon, label, value, tone }: ChipDef) {
  const c = CHIP_TONE[tone];
  return (
    <div className={`flex items-center gap-2 px-2.5 py-1.5 rounded-xl border ${c.box}`}>
      <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${c.icon}`} />
      <div className="min-w-0 leading-tight">
        <p className="text-[9px] uppercase tracking-wide text-zinc-500">{label}</p>
        <p className="text-xs font-semibold font-mono tabular-nums truncate">{value}</p>
      </div>
    </div>
  );
}

function ChipRow({ chips }: { chips: ChipDef[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c, i) => <DrawerChip key={`${c.label}-${i}`} {...c} />)}
    </div>
  );
}

function mowerChips(m: DeviceState): ChipDef[] {
  const s = m.sensors;
  const out: ChipDef[] = [
    { icon: Activity, label: 'Status', value: m.online ? 'Online' : 'Offline', tone: m.online ? 'emerald' : 'zinc' },
  ];
  if (s.rtk_fix_quality) {
    const f = s.rtk_fix_quality;
    out.push({ icon: Satellite, label: 'RTK', value: f, tone: f === 'RTK Fixed' ? 'emerald' : f === 'RTK Float' ? 'amber' : 'zinc' });
  }
  const sats = parseInt(s.rtk_sat ?? '', 10);
  if (isFinite(sats) && sats > 0) out.push({ icon: Satellite, label: 'Sats', value: sats, tone: sats >= 15 ? 'sky' : sats >= 8 ? 'amber' : 'red' });
  const bat = parseInt(s.battery_power ?? s.battery_capacity ?? '', 10);
  if (isFinite(bat) && bat > 0) out.push({ icon: BatteryMedium, label: 'Battery', value: `${bat}%`, tone: bat >= 20 ? 'emerald' : 'red' });
  const temp = parseInt(s.cpu_temperature ?? '', 10);
  if (isFinite(temp) && temp > 0) out.push({ icon: Thermometer, label: 'Temp', value: `${temp}°`, tone: temp >= 85 ? 'red' : 'zinc' });
  return out;
}

function chargerChips(c: DeviceState): ChipDef[] {
  const s = c.sensors;
  const out: ChipDef[] = [];
  if (s.charger_status) {
    const st = s.charger_status;
    out.push({ icon: Zap, label: 'Charger', value: st, tone: st === 'Operational' ? 'emerald' : st === 'Idle' ? 'amber' : 'zinc' });
  }
  if (s.rtk_ok != null && s.rtk_ok !== '') {
    out.push({ icon: Satellite, label: 'RTK', value: s.rtk_ok === '1' ? 'OK' : 'Not OK', tone: s.rtk_ok === '1' ? 'emerald' : 'red' });
  }
  const sats = parseInt(s.gps_satellites ?? '', 10);
  if (isFinite(sats)) out.push({ icon: Satellite, label: 'GPS Sat', value: sats, tone: sats >= 15 ? 'sky' : sats >= 8 ? 'amber' : 'red' });
  if (s.mower_status) out.push({ icon: Radio, label: 'Mower (LoRa)', value: s.mower_status, tone: 'zinc' });
  return out;
}

function DeviceIdentity({ device, online, version }: { device: DeviceState; online: boolean; version?: string }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-mono text-zinc-300">{device.sn}</p>
      {isDisplayableMac(device.macAddress) && (
        <p className="text-[10px] font-mono text-zinc-600">{device.macAddress}</p>
      )}
      <div className="flex items-center gap-3 text-xs">
        <span className={online ? 'text-emerald-400' : 'text-zinc-500'}>
          {online ? `● ${t('drawer.summary.online')}` : `● ${t('drawer.summary.offline')}`}
        </span>
        {version && <span className="font-mono text-purple-400">{version}</span>}
      </div>
      {device.lastSeen && (
        <p className="text-[10px] text-zinc-500">
          {t('drawer.summary.lastSeen')}: {new Date(device.lastSeen).toLocaleString()}
        </p>
      )}
    </div>
  );
}

function SummaryPanel({
  mower,
  charger,
  lora,
  setMode,
}: {
  mower: DeviceState;
  charger: DeviceState | null;
  lora: LoraStatus | null;
  setMode: (m: 'summary' | 'advanced') => void;
}) {
  const { t } = useTranslation();
  const chCh = charger ? chargerChips(charger) : [];
  return (
    <div className="space-y-4">
      {/* ── MOWER group ── */}
      <div className="space-y-2">
        <p className="text-[10px] font-semibold text-emerald-400/80 uppercase tracking-wider">Mower</p>
        <DeviceIdentity device={mower} online={mower.online} version={mower.sensors.sw_version} />
        <ChipRow chips={mowerChips(mower)} />

        {/* Configuration */}
        {lora && (
          <div className="space-y-2 pt-1">
            <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide">
              {t('drawer.summary.configuration')}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-zinc-900 rounded border border-zinc-800 p-2">
                <p className="text-[10px] text-zinc-500">{t('drawer.summary.loraAddress')}</p>
                <p className="text-sm font-mono text-zinc-100">{lora.pair.address ?? '–'}</p>
              </div>
              <div className="bg-zinc-900 rounded border border-zinc-800 p-2">
                <p className="text-[10px] text-zinc-500">{t('drawer.summary.loraChannel')}</p>
                <p className="text-sm font-mono text-zinc-100">{lora.pair.channel ?? '–'}</p>
              </div>
            </div>
            <span
              className={`inline-block text-[10px] px-2 py-0.5 rounded-full ${
                lora.drift
                  ? 'bg-amber-900/40 text-amber-300'
                  : 'bg-emerald-900/30 text-emerald-300'
              }`}
            >
              {lora.drift ? t('drawer.summary.pairDrift') : t('drawer.summary.pairSync')}
            </span>
          </div>
        )}
      </div>

      {/* ── CHARGER group ── */}
      {charger && (
        <div className="space-y-2 pt-3 border-t border-zinc-800">
          <p className="text-[10px] font-semibold text-amber-400/80 uppercase tracking-wider">Charger</p>
          <DeviceIdentity device={charger} online={charger.online} version={charger.sensors.version} />
          {chCh.length > 0
            ? <ChipRow chips={chCh} />
            : <p className="text-[10px] text-zinc-600 italic">No charger telemetry yet.</p>}
        </div>
      )}

      {/* Advanced button */}
      <button
        onClick={() => setMode('advanced')}
        className="w-full mt-2 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-sm text-zinc-200"
      >
        {t('drawer.summary.showAdvanced')}
      </button>
    </div>
  );
}

// ── Main DeviceChips component ───────────────────────────────────────────────

export function DeviceChips({ mower, charger, knownMowers, onSelectMower, part }: Props): React.JSX.Element | null {
  const { t } = useTranslation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState<number>(0);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [mode, setMode] = useState<'summary' | 'advanced'>('summary');
  const [lora, setLora] = useState<LoraStatus | null>(null);

  // Close switcher on outside click (deferred one tick so the opening click doesn't immediately close it)
  useEffect(() => {
    if (!switcherOpen) return;
    const handler = () => setSwitcherOpen(false);
    const id = setTimeout(() => document.addEventListener('click', handler), 0);
    return () => { clearTimeout(id); document.removeEventListener('click', handler); };
  }, [switcherOpen]);

  // Fetch LoRa status when drawer opens
  useEffect(() => {
    if (!drawerOpen || !mower) { setLora(null); return; }
    let cancelled = false;
    fetchLoraStatus(mower.sn)
      .then(s => { if (!cancelled) setLora(s); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [drawerOpen, mower?.sn]);

  // Reset to summary view each time drawer reopens
  useEffect(() => {
    if (drawerOpen) setMode('summary');
  }, [drawerOpen]);

  if (mower === null) return null;

  const s = mower.sensors;
  const subFor = (m: DeviceState) => m.sensors?.sw_version ?? m.sn;
  const fwLabel = subFor(mower);

  function openDrawer() {
    setOpenedAt(Date.now());
    setDrawerOpen(true);
  }

  // ── Offline chip ────────────────────────────────────────────────────────────
  if (!mower.online) {
    const offlineBadge = (
      <span className="text-[10px] bg-zinc-800 text-zinc-500 px-2 py-1 rounded-full">{t('chips.offline')}</span>
    );
    // Telemetry slot has nothing live when offline — just the offline badge.
    if (part === 'telemetry') return offlineBadge;
    return (
      <>
        <div className="inline-flex items-center gap-1.5">
          {/* Mower name / switcher */}
          {knownMowers.length > 1 ? (
            <div className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); setSwitcherOpen(v => !v); }}
                className="inline-flex items-center gap-2.5 h-10 pl-3 pr-2.5 rounded-xl bg-zinc-800/40 border border-zinc-700/60 hover:bg-zinc-800 transition-colors"
              >
                <MowerIdentityRow online={false} name={mower.nickname ?? mower.sn} sub={fwLabel} />
                <ChevronDown className={`w-3 h-3 text-zinc-500 transition-transform ${switcherOpen ? 'rotate-180' : ''}`} />
              </button>
              {switcherOpen && (
                <div className="absolute top-full left-0 mt-1.5 z-[2000] bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl min-w-[200px] p-1">
                  {knownMowers.map(m => (
                    <button
                      key={m.sn}
                      onClick={(e) => { e.stopPropagation(); setSwitcherOpen(false); onSelectMower(m.sn); }}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-zinc-800 transition-colors ${m.sn === mower.sn ? 'bg-zinc-800/60' : ''}`}
                    >
                      <MowerIdentityRow online={m.online} name={m.nickname ?? m.sn} sub={subFor(m)} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <span className="inline-flex items-center gap-2.5 h-10 pl-3 pr-3 rounded-xl bg-zinc-800/40 border border-zinc-700/50">
              <MowerIdentityRow online={false} name={mower.nickname ?? mower.sn} sub={fwLabel} />
            </span>
          )}
          {!part && offlineBadge}
        </div>
      </>
    );
  }

  // ── Sensor values ───────────────────────────────────────────────────────────
  const batteryRaw = s.battery_power ?? s.battery_capacity ?? '';
  const battery = parseInt(batteryRaw, 10);
  const hasBattery = isFinite(battery) && battery > 0;
  const isCharging = s.battery_state === 'CHARGING';

  const mowerSats = parseInt(s.rtk_sat ?? '', 10);
  const hasSats = isFinite(mowerSats) && mowerSats > 0;

  const mowerRtkKnown = s.rtk != null;
  const mowerRtk = s.rtk === 'true';

  const wifiRssi = parseInt(s.wifi_rssi ?? '', 10);
  const hasWifi = isFinite(wifiRssi) && wifiRssi !== 0;

  // Mower SoC danger threshold (user-confirmed). At/above this the temp chip
  // turns red and pulses to draw attention.
  const DANGER_TEMP_C = 85;
  const cpuTemp = parseInt(s.cpu_temperature ?? '', 10);
  const hasCpu = isFinite(cpuTemp) && cpuTemp > 0;

  const workStatus = s.work_status;
  const hasWork = workStatus != null && workStatus !== '0' && workStatus !== '';

  // Live driving speed (m/s), derived server-side from the pose stream.
  const driveSpeed = parseFloat(s.mow_speed ?? '');
  const hasSpeed = isFinite(driveSpeed) && driveSpeed > 0.05;

  const rtkFixQuality = s.rtk_fix_quality as string | undefined;
  const hasRtkFixQuality = rtkFixQuality != null && rtkFixQuality !== '';
  const RTK_FIX_QUALITY_COLORS: Record<string, string> = {
    'RTK Fixed':  '#22c55e',
    'RTK Float':  '#f59e0b',
    'DGPS':       '#eab308',
    'GPS':        '#9ca3af',
    'No fix':     '#ef4444',
  };
  const rtkFixQualityColor = rtkFixQuality != null
    ? (RTK_FIX_QUALITY_COLORS[rtkFixQuality] ?? '#6b7280')
    : '#6b7280';

  const hasSensorData = Object.keys(s).length > 0;

  // Pulse the online dot while the mower is actively cutting. Uses the shared
  // activity derivation (same one driving the control buttons / MowerStatus) so
  // "is mowing" is consistent everywhere — covers coverage mowing AND edge-cut.
  const activity = deriveMowerActivity(s, { online: mower.online });
  const isMowing = activity === 'mowing' || activity === 'edge_cutting';

  // ── Online chip ─────────────────────────────────────────────────────────────
  const rtkLabel = hasRtkFixQuality
    ? rtkFixQuality!
    : mowerRtkKnown ? (mowerRtk ? 'RTK' : 'No RTK') : null;
  const rtkColor = hasRtkFixQuality
    ? rtkFixQualityColor
    : (mowerRtk ? '#34d399' : '#6b7280');

  // Mower identity / switcher (click zone 1: switch active mower)
  const identityEl = knownMowers.length > 1 ? (
            <div className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); setSwitcherOpen(v => !v); }}
                className="inline-flex items-center gap-2.5 h-10 pl-3 pr-2.5 rounded-xl bg-zinc-800/50 border border-zinc-700/70 hover:bg-zinc-800 hover:border-zinc-600 transition-colors"
              >
                <MowerIdentityRow online={mower.online} name={mower.nickname ?? mower.sn} sub={fwLabel} />
                <ChevronDown className={`w-3 h-3 text-zinc-500 transition-transform ${switcherOpen ? 'rotate-180' : ''}`} />
              </button>
              {switcherOpen && (
                <div className="absolute top-full left-0 mt-1.5 z-[2000] bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl min-w-[200px] p-1">
                  {knownMowers.map(m => (
                    <button
                      key={m.sn}
                      onClick={(e) => { e.stopPropagation(); setSwitcherOpen(false); onSelectMower(m.sn); }}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-zinc-800 transition-colors ${m.sn === mower.sn ? 'bg-zinc-800/60' : ''}`}
                    >
                      <MowerIdentityRow online={m.online} name={m.nickname ?? m.sn} sub={subFor(m)} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <span className="inline-flex items-center gap-2.5 h-10 pl-3 pr-3 rounded-xl bg-zinc-800/40 border border-zinc-700/50">
              <MowerIdentityRow online={mower.online} name={mower.nickname ?? mower.sn} sub={fwLabel} />
            </span>
          );

  // Telemetry capsule (click zone 2: open sensor drawer)
  const telemetryEl = (
    <button
      onClick={openDrawer}
            className="group inline-flex flex-wrap items-stretch min-h-8 max-w-full rounded-xl bg-zinc-900/60 border border-zinc-700/70 hover:border-zinc-600 overflow-hidden transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            aria-label={`${mower.nickname ?? mower.sn} sensor details`}
          >
            {/* Online dot — pulses while actively mowing/edge-cutting */}
            <span className="inline-flex items-center px-2.5 border-r border-zinc-700/40">
              <span
                className={`w-2 h-2 rounded-full bg-emerald-400${isMowing ? ' animate-pulse' : ''}`}
                style={{ boxShadow: '0 0 0 3px rgba(52,211,153,.18)' }}
                title={isMowing ? (workStatusLabel(workStatus) || 'Mowing') : t('drawer.summary.online')}
              />
            </span>

            {hasSensorData ? (
              <>
                {hasBattery && (
                  <TeleCell
                    icon={isCharging ? BatteryCharging : BatteryMedium}
                    value={`${battery}%`}
                    color={battery >= 20 ? 'text-emerald-300' : 'text-red-400'}
                    iconColor={battery >= 20 ? 'text-emerald-400/80' : 'text-red-400'}
                    label={`Battery: ${battery}%${isCharging ? ' (charging)' : ''}`}
                  />
                )}

                {hasSats && (
                  <TeleCell
                    icon={Satellite}
                    value={mowerSats}
                    color={mowerSats >= 15 ? 'text-sky-300' : mowerSats >= 8 ? 'text-yellow-300' : 'text-red-400'}
                    iconColor={mowerSats >= 15 ? 'text-sky-400/80' : mowerSats >= 8 ? 'text-yellow-400/80' : 'text-red-400'}
                    label={`RTK satellites: ${mowerSats}`}
                  />
                )}

                {/* RTK fix — quality when known, else a bare yes/no */}
                {rtkLabel && (
                  <span
                    className="inline-flex items-center gap-1.5 px-2.5 border-r border-zinc-700/40"
                    title={`RTK fix quality: ${rtkLabel}`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: rtkColor }} />
                    <span className="text-xs font-semibold" style={{ color: rtkColor }}>{rtkLabel}</span>
                  </span>
                )}

                {hasWifi && (
                  <TeleCell
                    icon={Wifi}
                    value={`${wifiRssi}`}
                    color={Math.abs(wifiRssi) < 60 ? 'text-emerald-300' : Math.abs(wifiRssi) < 75 ? 'text-yellow-300' : 'text-red-400'}
                    iconColor={Math.abs(wifiRssi) < 60 ? 'text-emerald-400/80' : Math.abs(wifiRssi) < 75 ? 'text-yellow-400/80' : 'text-red-400'}
                    label={`WiFi RSSI: ${wifiRssi} dBm`}
                  />
                )}

                {hasCpu && (
                  <TeleCell
                    icon={Thermometer}
                    value={`${cpuTemp}°`}
                    color={cpuTemp >= DANGER_TEMP_C ? 'text-red-400' : cpuTemp < 50 ? 'text-zinc-200' : cpuTemp < 65 ? 'text-yellow-300' : 'text-red-400'}
                    iconColor={cpuTemp >= DANGER_TEMP_C ? 'text-red-400' : cpuTemp < 50 ? 'text-zinc-500' : cpuTemp < 65 ? 'text-yellow-400/80' : 'text-red-400'}
                    label={cpuTemp >= DANGER_TEMP_C ? `DANGER - CPU temp ${cpuTemp}°C (>= ${DANGER_TEMP_C}°C)` : `CPU temp: ${cpuTemp}°C`}
                    blink={cpuTemp >= DANGER_TEMP_C}
                  />
                )}

                {hasWork && (
                  <TeleCell
                    icon={Activity}
                    value={workStatusLabel(workStatus)}
                    color="text-emerald-300"
                    iconColor="text-emerald-400/80"
                    label={`Work status: ${workStatus}`}
                  />
                )}

                {hasSpeed && (
                  <TeleCell
                    icon={Gauge}
                    value={`${driveSpeed.toFixed(1)} m/s`}
                    color="text-sky-300"
                    iconColor="text-sky-400/80"
                    label={`Driving speed: ${driveSpeed.toFixed(2)} m/s`}
                  />
                )}
              </>
            ) : (
              <span className="inline-flex items-center px-2.5 text-zinc-600 text-[10px] italic">waiting…</span>
            )}

            <span className="inline-flex items-center px-1.5 text-zinc-500 group-hover:text-zinc-300">
              <ChevronDown className="w-3 h-3" />
            </span>
          </button>
  );

  // Sensor detail drawer — separate instance from the gear-icon drawer
  const drawerEl = (
    <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title={t('drawer.title.sensors')}>
        {mode === 'summary' ? (
          <SummaryPanel mower={mower} charger={charger ?? null} lora={lora} setMode={setMode} />
        ) : (
          <div className="space-y-3">
            <button
              onClick={() => setMode('summary')}
              className="text-xs text-zinc-400 hover:text-zinc-200"
            >
              {t('drawer.summary.backToSummary')}
            </button>
            <SensorDetailPanel mower={mower} openedAt={openedAt} />
          </div>
        )}
    </Drawer>
  );

  if (part === 'identity') return identityEl;
  if (part === 'telemetry') return (<>{telemetryEl}{drawerEl}</>);
  return (
    <>
      <div className="inline-flex items-center gap-2">{identityEl}{telemetryEl}</div>
      {drawerEl}
    </>
  );
}
