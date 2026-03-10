import { useState, useRef, useCallback, useEffect } from 'react';
import { Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { sendCommand } from '../../api/client';

interface Props {
  sn: string;
  online: boolean;
}

const SEND_INTERVAL = 50; // ms between movement commands
const DEAD_ZONE = 0.05;   // ignore tiny movements
const MAX_LINEAR = 0.5;   // m/s max forward/backward speed
const MAX_ANGULAR = 0.8;  // rad/s max turn speed

export function JoystickControl({ sn, online }: Props) {
  const { t } = useTranslation();
  const [active, setActive] = useState(false);
  const [thumbPos, setThumbPos] = useState({ x: 0, y: 0 });
  const baseRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<number | null>(null);
  const thumbRef = useRef({ x: 0, y: 0 });
  const activeRef = useRef(false);
  const startedRef = useRef(false);

  // Keep refs in sync for interval callback
  useEffect(() => { thumbRef.current = thumbPos; }, [thumbPos]);
  useEffect(() => { activeRef.current = active; }, [active]);

  const sendMoveCommand = useCallback(() => {
    const { x, y } = thumbRef.current;
    const dist = Math.sqrt(x * x + y * y);
    if (dist < DEAD_ZONE || !activeRef.current) return;

    // x = left/right → angular velocity (y_v)
    // y = up/down → linear velocity (x_w), negative y = forward
    const linearSpeed = -y * MAX_LINEAR;
    const angularSpeed = -x * MAX_ANGULAR;

    // mst = joystick data command (firmware field names: x_w, y_v, z_g)
    sendCommand(sn, {
      mst: {
        x_w: Math.round(linearSpeed * 100) / 100,
        y_v: Math.round(angularSpeed * 100) / 100,
        z_g: 0,
      },
    }).catch(() => {});
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
  }, []);

  const handleStart = useCallback((clientX: number, clientY: number) => {
    if (!online) return;
    setActive(true);
    updatePosition(clientX, clientY);

    // Send start_move:1 to activate manual control mode, then start sending mst data
    if (!startedRef.current) {
      sendCommand(sn, { start_move: 1 }).catch(() => {});
      startedRef.current = true;
    }

    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = window.setInterval(sendMoveCommand, SEND_INTERVAL);
  }, [sn, online, updatePosition, sendMoveCommand]);

  const handleMove = useCallback((clientX: number, clientY: number) => {
    if (!activeRef.current) return;
    updatePosition(clientX, clientY);
  }, [updatePosition]);

  const handleEnd = useCallback(() => {
    setActive(false);
    setThumbPos({ x: 0, y: 0 });
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    // Send stop_move to exit manual control mode
    sendCommand(sn, { stop_move: {} }).catch(() => {});
    startedRef.current = false;
  }, [sn]);

  // Clean up interval on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (startedRef.current) {
        sendCommand(sn, { stop_move: {} }).catch(() => {});
      }
    };
  }, [sn]);

  const dist = Math.sqrt(thumbPos.x * thumbPos.x + thumbPos.y * thumbPos.y);
  const speedPct = Math.round(dist * 100);

  return (
    <div className="flex flex-col items-center gap-2">
      {/* Speed indicator */}
      <div className="text-[10px] text-gray-500 font-mono h-4 tabular-nums">
        {active ? `${speedPct}%` : t('controls.joystickHelp')}
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
        onTouchStart={(e) => { e.preventDefault(); handleStart(e.touches[0].clientX, e.touches[0].clientY); }}
        onTouchMove={(e) => { e.preventDefault(); handleMove(e.touches[0].clientX, e.touches[0].clientY); }}
        onTouchEnd={handleEnd}
        onTouchCancel={handleEnd}
        onMouseDown={(e) => { e.preventDefault(); handleStart(e.clientX, e.clientY); }}
        onMouseMove={(e) => handleMove(e.clientX, e.clientY)}
        onMouseUp={handleEnd}
        onMouseLeave={() => { if (activeRef.current) handleEnd(); }}
      >
        {/* Crosshair lines */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="absolute w-px h-full bg-gray-700/40" />
          <div className="absolute h-px w-full bg-gray-700/40" />
        </div>

        {/* Direction labels */}
        <span className="absolute top-1 left-1/2 -translate-x-1/2 text-[8px] text-gray-600 pointer-events-none">N</span>
        <span className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[8px] text-gray-600 pointer-events-none">S</span>
        <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[8px] text-gray-600 pointer-events-none">W</span>
        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[8px] text-gray-600 pointer-events-none">E</span>

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

      {/* Emergency stop button below joystick */}
      <button
        onClick={handleEnd}
        disabled={!active}
        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-gray-700/60 text-gray-400 hover:text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-30"
      >
        <Square className="w-3.5 h-3.5" />
        {t('controls.stop')}
      </button>
    </div>
  );
}
