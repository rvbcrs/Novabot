import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Mountain, Map as MapIcon, CalendarClock, ClipboardList, Settings as SettingsIcon } from 'lucide-react';
import { Header } from './Header';
import { Drawer } from './Drawer';
import { DeviceChips } from './DeviceChips';
import { useDevices } from '../hooks/useDevices';
import { useActiveMower } from '../hooks/useActiveMower';
import { deriveMowerActivity } from '../utils/mowerActivity';
import { ActiveMowerProvider } from '../contexts/ActiveMowerContext';
import { MapTab } from '../pages/MapTab';
import { SchedulePage } from '../pages/SchedulePage';
import { WorkRecordsPage } from '../pages/WorkRecordsPage';
import { SettingsPage } from '../pages/SettingsPage';
import { NetworkHealthCard } from '../components/drawer/NetworkHealthCard';
import { LiveStatusCard } from '../components/drawer/LiveStatusCard';
import { ServerLogTail, FloatingServerLog } from '../components/drawer/ServerLogTail';
import { MowerControls } from '../components/dashboard/MowerControls';
import type { PatternPlacement } from '../components/patterns/PatternOverlay';
import { LongPauseBanner } from './LongPauseBanner';
import { MdnsConflictBanner } from './MdnsConflictBanner';
import { UpdateBanner } from './UpdateBanner';
import { ErrorDisplay } from '../components/status/ErrorDisplay';
import { useExperimental } from '../utils/experimental';

// Lazy-loaded so three.js (the 3D terrain viewer) stays out of the main bundle.
const TerrainPage = lazy(() => import('../pages/TerrainPage'));

type Tab = 'map' | 'schedule' | 'records' | 'settings' | 'terrain';

function ShellInner() {
  const { t } = useTranslation();
  const { devices, loading, connected, otaProgress, liveOutlines, coveredLanes } = useDevices();
  const { activeMower, activeMowerSn, setActiveMowerSn, knownMowers } = useActiveMower(devices);
  const charger = [...devices.values()].find(d => d.deviceType === 'charger') ?? null;
  // Terrain is experimental and only appears once the operator opts in under
  // Settings, mirroring the app's Experimental Features switch.
  const experimental = useExperimental();
  const TABS: Array<{ id: Tab; label: string; icon?: React.ComponentType<{ className?: string }> }> = [
    { id: 'map', label: 'Map', icon: MapIcon },
    { id: 'schedule', label: 'Schedule', icon: CalendarClock },
    { id: 'records', label: 'Records', icon: ClipboardList },
    { id: 'settings', label: 'Settings', icon: SettingsIcon },
    ...(experimental
      ? [{ id: 'terrain' as Tab, label: t('terrain.title'), icon: Mountain }]
      : []),
  ];
  const [tab, setTab] = useState<Tab>('map');
  // Turning the experimental switch off while standing on Terrain would strand
  // the operator on a tab that no longer has a button. Fall back to the map.
  useEffect(() => {
    if (!experimental && tab === 'terrain') setTab('map');
  }, [experimental, tab]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The enlarged server-log lives here (not in the drawer) so it stays open
  // when the drawer closes; only its own ✕ dismisses it.
  const [logFloating, setLogFloating] = useState(false);
  // Bridge: the Start-sheet Preview button (in the header MowerControls) signals
  // the MowerMap (in MapTab) to show a fresh coverage preview at the chosen
  // direction. Nonce makes repeated clicks re-fire even with the same direction.
  const [previewRequest, setPreviewRequest] = useState<{ nonce: number; covDirection: number; canonicals: string[]; polygonArea?: Array<{ latitude: number; longitude: number }> } | null>(null);
  // Pattern placement bridge: the Start-sheet Pattern tab (header MowerControls)
  // and the MowerMap (MapTab) are far apart in the tree. patternMode tells the
  // map to accept placement clicks (and stop polygons from swallowing them);
  // patternCenter flows map→controls, patternPlacement flows controls→map.
  const [patternMode, setPatternMode] = useState(false);
  const [patternCenter, setPatternCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [patternPlacement, setPatternPlacement] = useState<PatternPlacement | null>(null);
  // True while the map is actually fetching the mower coverage preview — drives
  // the Preview button's disabled/spinner state so it waits for the real result.
  const [previewLoading, setPreviewLoading] = useState(false);

  // Fresh-session coverage suppression — mirrors the app's HomeScreen
  // `freshSession` (the app "doet het altijd prima"). After a fresh start the
  // mower keeps echoing the PREVIOUS session's coverage (finished_area, planned
  // paths) until it reaches the start point. We hide that carried-over progress
  // on the map until new data arrives. CRITICAL: arm ONLY on an explicit
  // dashboard Start — never on mount or pause-resume — so monitoring a running
  // mow always shows live progress (this was the on/off flicker bug). Cleared
  // when the mower reports fresh data (finished_area/cover_map_id change), goes
  // idle/charging, or after a 3-minute safety timeout.
  const [freshSession, setFreshSession] = useState(false);
  const freshSessionFingerprint = useRef('');
  const freshSessionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeFingerprint = `${activeMower?.sensors.finished_area ?? ''}|${activeMower?.sensors.cover_map_id ?? ''}`;
  const activeActivity = activeMower
    ? deriveMowerActivity(activeMower.sensors, { online: activeMower.online })
    : null;
  useEffect(() => {
    if (!freshSession) return;
    if (
      activeFingerprint !== freshSessionFingerprint.current ||
      activeActivity === 'idle' ||
      activeActivity === 'charging'
    ) {
      setFreshSession(false);
      if (freshSessionTimer.current) { clearTimeout(freshSessionTimer.current); freshSessionTimer.current = null; }
    }
  }, [freshSession, activeFingerprint, activeActivity]);
  useEffect(() => () => { if (freshSessionTimer.current) clearTimeout(freshSessionTimer.current); }, []);
  const armFreshSession = () => {
    freshSessionFingerprint.current = activeFingerprint;
    setFreshSession(true);
    if (freshSessionTimer.current) clearTimeout(freshSessionTimer.current);
    freshSessionTimer.current = setTimeout(() => setFreshSession(false), 180000);
  };

  // Rain state derived from active mower's sensors. The mower reports
  // `rain_paused: '1'` when a scheduled run is currently paused by rain
  // and `rain_detected: '1'` when the rain sensor is wet but no run is
  // active. Both fields are absent on stock v5.x firmware — we fall
  // back to 'dry' (which RainBadge renders as no badge).
  const rainState: 'dry' | 'rain' | 'paused-by-rain' | null = activeMower
    ? activeMower.sensors.rain_paused === '1'
      ? 'paused-by-rain'
      : activeMower.sensors.rain_detected === '1'
      ? 'rain'
      : 'dry'
    : null;

  // Mower controls (start/pause/stop/…) are hosted inside the map's floating
  // tool-bar (passed down as a slot) instead of the status row, so they live
  // together with the map tools.
  const mowerControls = activeMower ? (
    <MowerControls
      sn={activeMower.sn}
      online={activeMower.online}
      sensors={activeMower.sensors}
      onPreview={(covDirection, canonicals, polygonArea) => { setTab('map'); setPreviewRequest({ nonce: Date.now(), covDirection, canonicals, polygonArea }); }}
      onStarted={() => { armFreshSession(); setTab('map'); }}
      patternCenter={patternCenter}
      onPatternModeChange={(active) => { setPatternMode(active); if (active) setTab('map'); if (!active) setPatternCenter(null); }}
      onPatternPlacementChange={setPatternPlacement}
      previewLoading={previewLoading}
    />
  ) : null;

  if (loading) {
    return <div className="p-8 text-zinc-500">Loading…</div>;
  }

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <Header
        connected={connected}
        rainState={rainState}
        onOpenDrawer={() => setDrawerOpen(true)}
      />

      {/* Single row: device identity + live telemetry (left) and the tab nav
          (right), so the status and the tabs share one line. */}
      <div className="px-4 py-1.5 bg-zinc-900 border-b border-zinc-800 flex-shrink-0 flex items-center gap-3 flex-wrap">
        {/* Mower selector (left) */}
        <DeviceChips
          part="identity"
          mower={activeMower}
          knownMowers={knownMowers}
          onSelectMower={setActiveMowerSn}
        />
        {/* Tabs (middle). max-w-full + overflow-x-auto: on phone widths the raw
            nav is wider than the viewport and the app root clips overflow, so
            without its own scroll the last tab(s) would be unreachable. */}
        <nav className="flex items-center gap-1 p-0.5 rounded-xl bg-zinc-800/40 border border-zinc-700/60 max-w-full overflow-x-auto">
          {TABS.map(tabDef => (
            <button
              key={tabDef.id}
              onClick={() => setTab(tabDef.id)}
              className={`shrink-0 whitespace-nowrap px-3.5 py-1.5 text-sm font-medium rounded-lg transition-colors flex items-center gap-1.5 ${
                tab === tabDef.id
                  ? 'bg-zinc-700 text-zinc-100 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/40'
              }`}
            >
              {tabDef.icon && <tabDef.icon className="w-3.5 h-3.5" />}
              {tabDef.label}
            </button>
          ))}
        </nav>
        {/* Live telemetry (far right). max-w-full lets the chip strip wrap on
            phone widths instead of being clipped off-screen. */}
        <div className="ml-auto max-w-full">
          <DeviceChips
            part="telemetry"
            mower={activeMower}
            charger={charger}
            knownMowers={knownMowers}
            onSelectMower={setActiveMowerSn}
          />
        </div>
      </div>

      <UpdateBanner />
      <MdnsConflictBanner />
      <LongPauseBanner mower={activeMower} />

      {/* Device error/warning popup. Lost in the DashboardPage→DashboardShell
          refactor (it used to live in <MowerStatus>); restored here so the
          desktop dashboard surfaces mower errors and non-blocking warnings
          (e.g. 139) again — same component the mobile view uses. */}
      {activeMower && (
        <ErrorDisplay
          errorCode={activeMower.sensors.error_code}
          errorMsg={activeMower.sensors.error_msg}
          errorStatus={activeMower.sensors.error_status}
          workStatus={activeMower.sensors.work_status}
        />
      )}

      <main className="flex-1 flex flex-col min-h-0 p-4">
        {tab === 'map' && (
          <MapTab
            mower={activeMower}
            connected={connected}
            liveOutlines={liveOutlines}
            coveredLanes={coveredLanes}
            otaProgress={otaProgress}
            previewRequest={previewRequest}
            patternPlacement={patternPlacement}
            onMapClickForPattern={patternMode ? setPatternCenter : undefined}
            controlsSlot={mowerControls}
            progressSuppressed={freshSession}
            onPreviewLoading={setPreviewLoading}
          />
        )}
        {tab === 'schedule' && <SchedulePage mower={activeMower} />}
        {tab === 'records' && <WorkRecordsPage mower={activeMower} />}
        {tab === 'settings' && <SettingsPage mower={activeMower} />}
        {tab === 'terrain' && (
          activeMower ? (
            <Suspense fallback={<div className="p-8 text-zinc-500">Loading…</div>}>
              <TerrainPage sn={activeMower.sn} />
            </Suspense>
          ) : (
            <div className="p-8 text-zinc-500">{t('pages.selectMower')}</div>
          )
        )}
      </main>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <NetworkHealthCard />
        <LiveStatusCard sn={activeMowerSn} />
        <ServerLogTail enlarged={logFloating} onEnlarge={() => setLogFloating(true)} />
      </Drawer>

      {/* Floating server-log window — top-level so it survives the drawer. */}
      <FloatingServerLog open={logFloating} onClose={() => setLogFloating(false)} />
    </div>
  );
}

export function DashboardShell() {
  return (
    <ActiveMowerProvider>
      <ShellInner />
    </ActiveMowerProvider>
  );
}
