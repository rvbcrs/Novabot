import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { joystickStart, joystickMove, joystickStop } from '../../api/socket';
import { sendExtendedCommand } from '../../api/client';
import { deriveMowerActivity } from '../../utils/mowerActivity';
import { isOpenNovaFirmware } from '../../utils/firmwareCapability';

/** Saw-blade icon — the MaterialCommunityIcons "saw-blade" the OpenNova app uses. */
function SawBlade({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M20,15C20,15 18.6,16.3 21.1,17L18.3,19.8H15.5C15.5,19.8 13.6,19.7 15,22H11L9,20C9,20 7.7,18.6 7,21.1L4.2,18.3V15.5C4.2,15.5 4.3,13.6 2,15V11L4,9C4,9 5.4,7.7 2.8,7.1L5.6,4.2H8.5C8.5,4.2 10.4,4.3 9,2H13L15,4C15,4 16.3,5.4 17,2.8L19.8,5.6V8.5C19.8,8.5 19.7,10.4 22,9V13L20,15M14,12A2,2 0 0,0 12,10A2,2 0 0,0 10,12A2,2 0 0,0 12,14A2,2 0 0,0 14,12Z" />
    </svg>
  );
}

interface Props {
  sn: string;
  online: boolean;
  sensors?: Record<string, string>;
}

const DEAD_ZONE = 0.05;
const THROTTLE_MS = 80; // min ms between joystick:move updates to server

// Speed levels — values copied verbatim from the app (JoystickScreen.tsx
// SPEED_LEVELS) so the dashboard drives the mower at identical speeds.
//   slow → linear 0.5 m/s, normal → 1.0, fast → 2.0
const SPEED_LEVELS = [
  { labelKey: 'controls.speedSlow', label: 'Slow', linear: 0.5, angular: 0.4 },
  { labelKey: 'controls.speedNormal', label: 'Normal', linear: 1.0, angular: 0.8 },
  { labelKey: 'controls.speedFast', label: 'Fast', linear: 2.0, angular: 1.5 },
];

// JoystickHoldType: 1=left, 2=right, 3=forward, 4=backward.
function getHoldType(x: number, y: number): number {
  if (Math.abs(y) >= Math.abs(x)) {
    return y < 0 ? 3 : 4; // up = forward(3), down = backward(4)
  }
  return x < 0 ? 1 : 2; // left(1), right(2)
}

export function ManualControlPanel({ sn, online, sensors }: Props) {
  const { t } = useTranslation();
  const [active, setActive] = useState(false);
  const [thumbPos, setThumbPos] = useState({ x: 0, y: 0 });
  const [speedLevel, setSpeedLevel] = useState(1); // default = normal
  const baseRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(false);
  const lastSendRef = useRef(0);
  const speedRef = useRef(speedLevel);
  useEffect(() => { speedRef.current = speedLevel; }, [speedLevel]);

  // Derived mower state for guards (mirrors app busyWithTask / onDock).
  const activity = deriveMowerActivity(sensors ?? {}, { online });
  const onDock = activity === 'charging';
  const bladeSpeed = parseInt(sensors?.blade_speed ?? '0', 10) || 0;
  // blade_on/off zijn extended commands → alleen OpenNova firmware. De joystick
  // zelf blijft ongemoeid (stock-ondersteuning niet geverifieerd).
  const firmwareSupported = isOpenNovaFirmware(sensors?.sw_version ?? sensors?.version);

  // Blade state. When the operator turns the blade on manually we set a local
  // flag; movement is then allowed even though the firmware may briefly report
  // a task state (the app does the same via busyWithTask → false when bladeOn).
  const [bladeOn, setBladeOn] = useState(false);
  const bladeOnRef = useRef(false);
  const [showBladeSheet, setShowBladeSheet] = useState(false);
  const [bladeHeightCm, setBladeHeightCm] = useState(5); // 5cm default

  // Autonomous-busy: block joystick movement while the mower is mowing/
  // returning/edge-cutting UNLESS the user is driving the blade themselves.
  const autonomousBusy =
    !bladeOn &&
    (activity === 'mowing' || activity === 'returning' ||
     activity === 'edge_cutting' || activity === 'mapping');

  // ── Blade control (extended commands) ──────────────────────────────
  const sendBladeOff = useCallback(() => {
    bladeOnRef.current = false;
    setBladeOn(false);
    sendExtendedCommand(sn, { blade_off: {} }).catch(() => { /* best-effort */ });
  }, [sn]);

  const startBladeWithHeight = useCallback((userCm: number) => {
    setShowBladeSheet(false);
    setBladeHeightCm(userCm);
    // Wire-level enum 0..7; firmware mm = (level + 2) * 10 (extended_commands.py
    // _publish_blade_height). userCm 2 → level 0 (20mm), 9 → level 7 (90mm).
    const level = Math.max(0, Math.min(7, userCm - 2));
    bladeOnRef.current = true;
    setBladeOn(true);
    // Mislukt het commando (bv. stock firmware → 409), dan draait er ook geen mes:
    // lokale "mes draait"-state weer terugzetten.
    sendExtendedCommand(sn, { blade_on: { speed: 3000, height: level } }).catch(() => {
      bladeOnRef.current = false;
      setBladeOn(false);
    });
  }, [sn]);

  const toggleBlade = useCallback(() => {
    if (onDock) return; // never spin blades against the charging contacts
    if (!firmwareSupported) return;
    const motorRunning = bladeOnRef.current || bladeSpeed > 0;
    if (motorRunning) { sendBladeOff(); return; }
    setShowBladeSheet(true);
  }, [onDock, firmwareSupported, bladeSpeed, sendBladeOff]);

  // Safety auto-off: kill the blade if the mower goes offline or lands on the
  // dock while the motor is (or thinks it is) running.
  useEffect(() => {
    if (!bladeOnRef.current) return;
    if (!online || onDock) sendBladeOff();
  }, [online, onDock, sendBladeOff]);

  // ── Joystick velocity → server ─────────────────────────────────────
  const sendUpdate = useCallback((x: number, y: number) => {
    if (autonomousBusy) return;
    const dist = Math.sqrt(x * x + y * y);
    if (dist < DEAD_ZONE) return;
    const now = Date.now();
    if (now - lastSendRef.current < THROTTLE_MS) return;
    lastSendRef.current = now;

    const holdType = getHoldType(x, y);
    const lvl = SPEED_LEVELS[speedRef.current] ?? SPEED_LEVELS[1];
    // Signed mst — matches the app (and BLE) semantics exactly:
    //   x_w = angular (turn), signed; negative = left
    //   y_v = linear (drive), signed; negative (screen-down) = backward
    // y is screen coords (down positive) so forward = -y.
    joystickMove(sn, holdType, {
      x_w: Math.round(x * lvl.angular * 100) / 100,
      y_v: Math.round(-y * lvl.linear * 100) / 100,
      z_g: 0,
    });
  }, [sn, autonomousBusy]);

  const updatePosition = useCallback((clientX: number, clientY: number) => {
    if (!baseRef.current) return;
    const rect = baseRef.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const radius = rect.width / 2;
    let dx = (clientX - cx) / radius;
    let dy = (clientY - cy) / radius;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 1) { dx /= dist; dy /= dist; }
    setThumbPos({ x: dx, y: dy });
    if (activeRef.current) sendUpdate(dx, dy);
  }, [sendUpdate]);

  const stopAll = useCallback(() => {
    activeRef.current = false;
    setActive(false);
    setThumbPos({ x: 0, y: 0 });
    joystickStop(sn);
  }, [sn]);

  const startJoystick = useCallback((clientX: number, clientY: number) => {
    if (!online || autonomousBusy) return;
    activeRef.current = true;
    setActive(true);
    lastSendRef.current = 0;
    if (!baseRef.current) return;
    const rect = baseRef.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const radius = rect.width / 2;
    let dx = (clientX - cx) / radius;
    let dy = (clientY - cy) / radius;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 1) { dx /= dist; dy /= dist; }
    setThumbPos({ x: dx, y: dy });
    const holdType = getHoldType(dx, dy) || 3;
    const lvl = SPEED_LEVELS[speedRef.current] ?? SPEED_LEVELS[1];
    joystickStart(sn, holdType);
    joystickMove(sn, holdType, {
      x_w: Math.round(dx * lvl.angular * 100) / 100,
      y_v: Math.round(-dy * lvl.linear * 100) / 100,
      z_g: 0,
    });
  }, [sn, online, autonomousBusy]);

  // ── Pointer/touch wiring ───────────────────────────────────────────
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!activeRef.current) return;
    updatePosition(e.clientX, e.clientY);
  }, [updatePosition]);

  const handleMouseUp = useCallback(() => {
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
    if (activeRef.current) stopAll();
  }, [handleMouseMove, stopAll]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    startJoystick(e.clientX, e.clientY);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [startJoystick, handleMouseMove, handleMouseUp]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    startJoystick(e.touches[0].clientX, e.touches[0].clientY);
  }, [startJoystick]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    if (!activeRef.current) return;
    updatePosition(e.touches[0].clientX, e.touches[0].clientY);
  }, [updatePosition]);

  const handleTouchEnd = useCallback(() => {
    if (activeRef.current) stopAll();
  }, [stopAll]);

  // Cleanup on unmount: stop joystick AND guarantee blade off (safety).
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (activeRef.current) joystickStop(sn);
      if (bladeOnRef.current) sendExtendedCommand(sn, { blade_off: {} }).catch(() => {});
    };
  }, [sn, handleMouseMove, handleMouseUp]);

  const dist = Math.sqrt(thumbPos.x * thumbPos.x + thumbPos.y * thumbPos.y);
  const lvl = SPEED_LEVELS[speedLevel] ?? SPEED_LEVELS[1];
  const speedMs = (dist * lvl.linear).toFixed(2);
  const motorRunning = bladeOn || bladeSpeed > 0;

  return (
    <div className="flex flex-col items-center gap-4">
      {/* Speed selector */}
      <div className="flex gap-1.5 w-full">
        {SPEED_LEVELS.map((s, i) => (
          <button
            key={s.label}
            onClick={() => setSpeedLevel(i)}
            className={`flex-1 text-xs py-1.5 rounded transition-colors ${
              speedLevel === i
                ? 'bg-emerald-600 text-white'
                : 'bg-gray-700/60 text-gray-300 hover:bg-gray-700'
            }`}
          >
            {t(s.labelKey, s.label)}
          </button>
        ))}
      </div>

      {/* Status line */}
      <div className="text-[11px] font-mono h-4 tabular-nums">
        {!online ? (
          <span className="text-red-400">{t('controls.offline')}</span>
        ) : autonomousBusy ? (
          <span className="text-amber-400">{t('controls.busyDriving', 'Maaier is bezig — stop de taak eerst')}</span>
        ) : active ? (
          <span className="text-emerald-400">{speedMs} m/s</span>
        ) : (
          <span className="text-gray-500">{t('controls.joystickHelp', 'Sleep om te rijden')}</span>
        )}
      </div>

      {/* Joystick base */}
      <div
        ref={baseRef}
        className={`relative w-40 h-40 rounded-full ring-1 select-none ${
          online && !autonomousBusy
            ? 'bg-gray-800/80 ring-gray-600 cursor-grab'
            : 'bg-gray-800/40 ring-gray-700 cursor-not-allowed opacity-50'
        }`}
        style={{ touchAction: 'none' }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        onMouseDown={handleMouseDown}
      >
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="absolute w-px h-full bg-gray-700/40" />
          <div className="absolute h-px w-full bg-gray-700/40" />
        </div>
        <span className="absolute top-1.5 left-1/2 -translate-x-1/2 text-[9px] text-gray-600 pointer-events-none">F</span>
        <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 text-[9px] text-gray-600 pointer-events-none">B</span>
        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[9px] text-gray-600 pointer-events-none">L</span>
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-gray-600 pointer-events-none">R</span>
        <div
          className={`absolute w-12 h-12 rounded-full ${
            active
              ? 'bg-emerald-500 ring-2 ring-white shadow-lg shadow-emerald-500/30'
              : 'bg-gray-600 ring-1 ring-gray-500'
          }`}
          style={{
            left: `calc(50% + ${thumbPos.x * 50}% - 1.5rem)`,
            top: `calc(50% + ${thumbPos.y * 50}% - 1.5rem)`,
            transition: active ? 'none' : 'all 200ms ease-out',
            pointerEvents: 'none',
          }}
        />
      </div>

      {/* Blade banner — visible while the motor runs (or is requested) */}
      {motorRunning && (
        <button
          onClick={toggleBlade}
          className="flex items-center gap-2 w-full px-3 py-2 rounded-lg bg-red-900/30 ring-1 ring-red-500/40 hover:bg-red-900/50 transition-colors"
        >
          <SawBlade className="w-4 h-4 text-red-400 animate-spin" />
          <span className="text-xs font-semibold text-red-300 flex-1 text-left">
            {bladeSpeed > 0
              ? t('controls.bladeRunning', { rpm: bladeSpeed, defaultValue: 'Mes draait — {{rpm}} RPM (tik om te stoppen)' })
              : t('controls.bladeStarting', 'Mes wordt gestart (tik om te stoppen)')}
          </span>
        </button>
      )}

      {/* Blade toggle */}
      <div className="flex w-full">
        <button
          onClick={toggleBlade}
          disabled={!online || onDock || autonomousBusy || !firmwareSupported}
          className={`flex-1 flex items-center justify-center gap-1.5 text-xs py-2 rounded transition-colors disabled:opacity-30 ${
            motorRunning
              ? 'bg-amber-600/80 text-white hover:bg-amber-600'
              : 'bg-gray-700/60 text-gray-300 hover:bg-gray-700'
          }`}
          title={!firmwareSupported
            ? t('firmware.requiresOpenNova')
            : onDock ? t('controls.bladeDockedHint', 'Niet beschikbaar op het laadstation') : undefined}
        >
          <SawBlade className="w-4 h-4" />
          {motorRunning ? t('controls.bladeOff', 'Mes uit') : t('controls.bladeOn', 'Mes aan')}
        </button>
      </div>
      {!firmwareSupported && (
        <p className="w-full text-[10px] text-amber-300/90 text-center leading-snug">{t('firmware.requiresOpenNova')}</p>
      )}

      {/* Blade height picker sheet */}
      {showBladeSheet && (
        <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowBladeSheet(false)} />
          <div className="relative bg-gray-900 border border-gray-700/50 rounded-2xl shadow-2xl max-w-xs w-full p-6">
            <p className="text-center text-white font-medium text-base mb-1">
              {t('controls.bladeHeightTitle', 'Maaihoogte')}
            </p>
            <p className="text-center text-gray-400 text-xs mb-4">
              {t('controls.bladeHeightDesc', 'Kies de hoogte voordat het mes start.')}
            </p>
            <div className="flex items-center justify-center gap-4 mb-5">
              <button
                onClick={() => setBladeHeightCm(c => Math.max(2, c - 1))}
                className="w-9 h-9 rounded-full bg-gray-700 text-white text-lg hover:bg-gray-600"
              >−</button>
              <span className="text-2xl font-semibold text-white tabular-nums w-16 text-center">{bladeHeightCm} cm</span>
              <button
                onClick={() => setBladeHeightCm(c => Math.min(9, c + 1))}
                className="w-9 h-9 rounded-full bg-gray-700 text-white text-lg hover:bg-gray-600"
              >+</button>
            </div>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => startBladeWithHeight(bladeHeightCm)}
                className="py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-xl transition-colors"
              >
                {t('controls.bladeStart', 'Mes starten')}
              </button>
              <button
                onClick={() => setShowBladeSheet(false)}
                className="py-2.5 bg-white/10 hover:bg-white/15 text-gray-300 text-sm font-medium rounded-xl transition-colors"
              >
                {t('common.cancel', 'Annuleren')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
