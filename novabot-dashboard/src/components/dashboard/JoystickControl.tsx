import { useState, useRef, useCallback, useEffect } from 'react';
import { Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { sendCommand } from '../../api/client';

interface Props {
  sn: string;
  online: boolean;
}

const SEND_INTERVAL = 200; // ms between movement commands
const DEAD_ZONE = 0.05;    // ignore tiny movements
const MAX_LINEAR = 0.5;    // m/s max forward/backward speed
const MAX_ANGULAR = 0.8;   // rad/s max turn speed

// Map joystick position to JoystickHoldType direction
// 0=none, 1=left, 2=right, 3=top(forward), 4=bottom(backward)
function getHoldType(x: number, y: number): number {
  if (Math.abs(y) >= Math.abs(x)) {
    return y < 0 ? 3 : 4; // up = forward(3), down = backward(4)
  }
  return x < 0 ? 1 : 2; // left(1), right(2)
}

export function JoystickControl({ sn, online }: Props) {
  const { t } = useTranslation();
  const [active, setActive] = useState(false);
  const [thumbPos, setThumbPos] = useState({ x: 0, y: 0 });
  const [cmdCount, setCmdCount] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const baseRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<number | null>(null);
  const thumbRef = useRef({ x: 0, y: 0 });
  const activeRef = useRef(false);
  const modeActiveRef = useRef(false);
  const lastHoldTypeRef = useRef(0);

  // Keep refs in sync for interval callback
  useEffect(() => { thumbRef.current = thumbPos; }, [thumbPos]);
  useEffect(() => { activeRef.current = active; }, [active]);

  const sendMoveCommand = useCallback(() => {
    const { x, y } = thumbRef.current;
    const dist = Math.sqrt(x * x + y * y);
    if (dist < DEAD_ZONE || !activeRef.current) return;

    // Firmware uses start_move direction + mst magnitude for motor control
    // Resend start_move when dominant direction changes
    const holdType = getHoldType(x, y);
    if (holdType !== lastHoldTypeRef.current) {
      lastHoldTypeRef.current = holdType;
      sendCommand(sn, { start_move: holdType })
        .catch((e) => setLastError(e instanceof Error ? e.message : String(e)));
    }

    // mst provides speed magnitude; direction comes from start_move
    const speed = Math.round(dist * MAX_LINEAR * 100) / 100;
    sendCommand(sn, {
      mst: {
        x_w: speed,
        y_v: Math.round(Math.abs(x) * MAX_ANGULAR * 100) / 100,
        z_g: 0,
      },
    }).then(() => {
      setCmdCount(c => c + 1);
      setLastError(null);
    }).catch((e) => {
      setLastError(e instanceof Error ? e.message : String(e));
    });
  }, [sn]);

  const updatePosition = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    if (!baseRef.current) return { x: 0, y: 0 };
    const rect = baseRef.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const radius = rect.width / 2;
    let dx = (clientX - cx) / radius;
    let dy = (clientY - cy) / radius;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 1) { dx /= dist; dy /= dist; }
    const pos = { x: dx, y: dy };
    thumbRef.current = pos;   // Update ref immediately for interval callback
    setThumbPos(pos);
    return pos;
  }, []);

  const handleStart = useCallback((clientX: number, clientY: number) => {
    if (!online) return;
    setActive(true);
    activeRef.current = true;  // Update ref immediately (don't wait for useEffect)
    setCmdCount(0);
    setLastError(null);
    const pos = updatePosition(clientX, clientY);

    // Activate manual control mode: firmware requires {"start_move": <int>}, NOT empty object
    // JoystickHoldType: 0=none, 1=left, 2=right, 3=top(fwd), 4=bottom(back)
    // Direction from start_move determines motor direction, mst provides speed magnitude
    if (!modeActiveRef.current) {
      modeActiveRef.current = true;
      const holdType = getHoldType(pos.x, pos.y) || 3;
      lastHoldTypeRef.current = holdType;
      sendCommand(sn, { start_move: holdType })
        .then(() => setLastError(null))
        .catch((e) => setLastError(e instanceof Error ? e.message : String(e)));
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
    activeRef.current = false;  // Update ref immediately
    setThumbPos({ x: 0, y: 0 });
    thumbRef.current = { x: 0, y: 0 };
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    // Send stop_move to exit manual control mode
    if (modeActiveRef.current) {
      sendCommand(sn, { stop_move: {} }).catch(() => {});
      modeActiveRef.current = false;
    }
  }, [sn]);

  // Clean up interval on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        sendCommand(sn, { stop_move: {} }).catch(() => {});
      }
    };
  }, [sn]);

  const dist = Math.sqrt(thumbPos.x * thumbPos.x + thumbPos.y * thumbPos.y);
  const speedPct = Math.round(dist * 100);

  return (
    <div className="flex flex-col items-center gap-2">
      {/* Status indicator */}
      <div className="text-[10px] font-mono h-4 tabular-nums">
        {!online ? (
          <span className="text-red-400">{t('controls.offline')}</span>
        ) : lastError ? (
          <span className="text-red-400">{lastError}</span>
        ) : active ? (
          <span className="text-emerald-400">{speedPct}% &middot; {cmdCount} cmd</span>
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
