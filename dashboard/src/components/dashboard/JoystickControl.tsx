import { useState, useRef, useCallback, useEffect } from 'react';
import { Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { joystickStart, joystickMove, joystickStop } from '../../api/socket';

interface Props {
  sn: string;
  online: boolean;
  speedLevel?: number; // 0=low, 1=medium, 2=high (from manual_controller_v setting)
}

const DEAD_ZONE = 0.05;
const THROTTLE_MS = 80; // min ms between joystick:move updates to server

// Speed limits per level — matches manual_controller_v setting (0=low, 1=med, 2=high)
const SPEED_LEVELS = [
  { linear: 0.15, angular: 0.3 },  // 0 = low
  { linear: 0.3,  angular: 0.5 },  // 1 = medium
  { linear: 0.5,  angular: 0.8 },  // 2 = high
];

// Map joystick position to JoystickHoldType direction
function getHoldType(x: number, y: number): number {
  if (Math.abs(y) >= Math.abs(x)) {
    return y < 0 ? 3 : 4; // up = forward(3), down = backward(4)
  }
  return x < 0 ? 1 : 2; // left(1), right(2)
}

export function JoystickControl({ sn, online, speedLevel = 0 }: Props) {
  const { t } = useTranslation();
  const [active, setActive] = useState(false);
  const [thumbPos, setThumbPos] = useState({ x: 0, y: 0 });
  const baseRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(false);
  const lastSendRef = useRef(0);

  const speedRef = useRef(speedLevel);
  useEffect(() => { speedRef.current = speedLevel; }, [speedLevel]);

  // Send updated velocity to server (throttled)
  const sendUpdate = useCallback((x: number, y: number) => {
    const dist = Math.sqrt(x * x + y * y);
    if (dist < DEAD_ZONE) return;

    const now = Date.now();
    if (now - lastSendRef.current < THROTTLE_MS) return;
    lastSendRef.current = now;

    const holdType = getHoldType(x, y);
    const lvl = SPEED_LEVELS[speedRef.current] ?? SPEED_LEVELS[0];
    joystickMove(sn, holdType, {
      x_w: Math.round(dist * lvl.linear * 100) / 100,
      y_v: Math.round(Math.abs(x) * lvl.angular * 100) / 100,
      z_g: 0,
    });
  }, [sn]);

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
    if (!online) return;
    activeRef.current = true;
    setActive(true);
    lastSendRef.current = 0; // reset throttle

    // Calculate initial position
    if (baseRef.current) {
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
      // Tell server to enter manual mode AND start the MQTT loop
      const lvl = SPEED_LEVELS[speedRef.current] ?? SPEED_LEVELS[0];
      const speed = Math.sqrt(dx * dx + dy * dy);
      joystickStart(sn, holdType);
      joystickMove(sn, holdType, {
        x_w: Math.round(speed * lvl.linear * 100) / 100,
        y_v: Math.round(Math.abs(dx) * lvl.angular * 100) / 100,
        z_g: 0,
      });
    }
  }, [sn, online]);

  // ── Mouse: capture at document level during drag ──
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

  // ── Touch ──
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

  // Clean up on unmount
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (activeRef.current) joystickStop(sn);
    };
  }, [sn, handleMouseMove, handleMouseUp]);

  const dist = Math.sqrt(thumbPos.x * thumbPos.x + thumbPos.y * thumbPos.y);
  const lvl = SPEED_LEVELS[speedLevel] ?? SPEED_LEVELS[0];
  const speedMs = (dist * lvl.linear).toFixed(2);
  const levelLabel = ['Low', 'Med', 'High'][speedLevel] ?? 'Low';

  return (
    <div className="flex flex-col items-center gap-2">
      {/* Status indicator */}
      <div className="text-[10px] font-mono h-4 tabular-nums">
        {!online ? (
          <span className="text-red-400">{t('controls.offline')}</span>
        ) : active ? (
          <span className="text-emerald-400">{speedMs} m/s ({levelLabel})</span>
        ) : (
          <span className="text-gray-500">{t('controls.joystickHelp')}</span>
        )}
      </div>

      {/* Joystick base */}
      <div
        ref={baseRef}
        className={`relative w-28 h-28 md:w-24 md:h-24 rounded-full ring-1 select-none ${
          online
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
        {/* Crosshair lines */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="absolute w-px h-full bg-gray-700/40" />
          <div className="absolute h-px w-full bg-gray-700/40" />
        </div>

        {/* Direction labels */}
        <span className="absolute top-1 left-1/2 -translate-x-1/2 text-[8px] text-gray-600 pointer-events-none">F</span>
        <span className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[8px] text-gray-600 pointer-events-none">B</span>
        <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[8px] text-gray-600 pointer-events-none">L</span>
        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[8px] text-gray-600 pointer-events-none">R</span>

        {/* Thumb */}
        <div
          className={`absolute w-10 h-10 rounded-full ${
            active
              ? 'bg-emerald-500 ring-2 ring-white shadow-lg shadow-emerald-500/30'
              : 'bg-gray-600 ring-1 ring-gray-500'
          }`}
          style={{
            left: `calc(50% + ${thumbPos.x * 50}% - 1.25rem)`,
            top: `calc(50% + ${thumbPos.y * 50}% - 1.25rem)`,
            transition: active ? 'none' : 'all 200ms ease-out',
            pointerEvents: 'none',
          }}
        />
      </div>

      {/* Emergency stop button */}
      <button
        onClick={stopAll}
        disabled={!active}
        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-gray-700/60 text-gray-400 hover:text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-30"
      >
        <Square className="w-3.5 h-3.5" />
        {t('controls.stop')}
      </button>
    </div>
  );
}
