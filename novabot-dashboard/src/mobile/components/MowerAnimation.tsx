import type { MowerActivity } from '../MobilePage';

interface Props {
  activity: MowerActivity;
  battery: number;
  mowingProgress: number;
}

const GRASS_BLADES = Array.from({ length: 28 }, (_, i) => ({
  left: `${(i * 3.6) + 0.5}%`,
  height: 14 + (i % 5) * 4,
  delay: `${(i * 0.12) % 1.5}s`,
}));

const CLIPPINGS = Array.from({ length: 8 }, (_, i) => ({
  delay: `${i * 0.3}s`,
  dx: -8 + (i % 4) * 6,
  size: 2 + (i % 3),
}));

// Bushes and flowers that scroll past during mowing
const SCENERY = [
  // Bushes — rounded green clumps
  { type: 'bush' as const, left: 8, w: 18, h: 14, color: '#059669' },
  { type: 'bush' as const, left: 28, w: 14, h: 11, color: '#047857' },
  { type: 'bush' as const, left: 62, w: 20, h: 16, color: '#065f46' },
  { type: 'bush' as const, left: 85, w: 16, h: 12, color: '#059669' },
  // Flowers — small stems with colored petals
  { type: 'flower' as const, left: 15, h: 18, petal: '#f472b6', stem: '#34d399' },
  { type: 'flower' as const, left: 22, h: 14, petal: '#fbbf24', stem: '#6ee7b7' },
  { type: 'flower' as const, left: 38, h: 20, petal: '#c084fc', stem: '#34d399' },
  { type: 'flower' as const, left: 48, h: 16, petal: '#fb923c', stem: '#6ee7b7' },
  { type: 'flower' as const, left: 55, h: 15, petal: '#f472b6', stem: '#34d399' },
  { type: 'flower' as const, left: 72, h: 19, petal: '#60a5fa', stem: '#6ee7b7' },
  { type: 'flower' as const, left: 78, h: 13, petal: '#fbbf24', stem: '#34d399' },
  { type: 'flower' as const, left: 92, h: 17, petal: '#f472b6', stem: '#6ee7b7' },
];

// ── Novabot side-view image ───────────────────────────────────────
// Uses the user-created SVG illustration at /mower/novabot-side.svg

// ── Main component ────────────────────────────────────────────────

export function MowerAnimation({ activity, battery, mowingProgress }: Props) {
  const isMowing = activity === 'mowing';
  const isCharging = activity === 'charging';
  const isReturning = activity === 'returning';
  const isPaused = activity === 'paused';
  const isMapping = activity === 'mapping';
  const isError = activity === 'error';
  const isOffline = activity === 'offline';
  const isMoving = isMowing || isReturning || isMapping;

  return (
    <>
      <style>{`
        @keyframes mower-drive {
          0%   { transform: translateY(0px); }
          25%  { transform: translateY(-1.5px); }
          50%  { transform: translateY(0px); }
          75%  { transform: translateY(-1px); }
          100% { transform: translateY(0px); }
        }
        @keyframes ground-scroll {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        @keyframes mower-return {
          0%   { transform: translateX(-160px); }
          60%  { transform: translateX(10px); }
          80%  { transform: translateX(12px); }
          100% { transform: translateX(12px); }
        }
        @keyframes wheel-decel {
          0%   { transform: rotate(0deg); }
          60%  { transform: rotate(1080deg); }
          80%  { transform: rotate(1150deg); }
          100% { transform: rotate(1150deg); }
        }
        @keyframes mower-idle-bob {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-2px); }
        }
        @keyframes grass-sway {
          0%, 100% { transform: rotate(-5deg) scaleY(1); }
          50%      { transform: rotate(5deg) scaleY(0.92); }
        }
        @keyframes grass-cut {
          0%, 100% { transform: rotate(-8deg) scaleY(1); }
          30%      { transform: rotate(12deg) scaleY(0.7); }
          60%      { transform: rotate(-4deg) scaleY(0.85); }
        }
        @keyframes clipping-fly {
          0%   { transform: translate(0, 0) scale(1); opacity: 0.8; }
          50%  { opacity: 0.6; }
          100% { transform: translate(var(--dx), -20px) scale(0.3); opacity: 0; }
        }
        @keyframes charge-pulse {
          0%, 100% { opacity: 0.4; transform: scale(0.95); }
          50%      { opacity: 1; transform: scale(1.05); }
        }
        @keyframes error-glow {
          0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
          50%      { box-shadow: 0 0 20px 4px rgba(239, 68, 68, 0.3); }
        }
        @keyframes scan-line {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(200%); }
        }
        @keyframes draw-polygon {
          0%   { stroke-dashoffset: 400; }
          80%  { stroke-dashoffset: 0; }
          100% { stroke-dashoffset: 0; }
        }
        @keyframes fill-polygon {
          0%, 75% { fill-opacity: 0; }
          100%    { fill-opacity: 0.12; }
        }
        @keyframes ping-dot {
          0%   { transform: scale(0); opacity: 0; }
          50%  { transform: scale(1.3); opacity: 1; }
          100% { transform: scale(1); opacity: 0.9; }
        }
        @keyframes map-cursor {
          0%   { offset-distance: 0%; }
          80%  { offset-distance: 100%; }
          100% { offset-distance: 100%; }
        }
        @keyframes mower-map-drive {
          0%   { transform: translateX(-350px); }
          100% { transform: translateX(350px); }
        }
        @keyframes wheel-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        .mower-scene {
          position: relative;
          width: 100%;
          height: 140px;
          border-radius: 20px;
          overflow: hidden;
        }
      `}</style>

      <div
        className="mower-scene"
        style={{
          background: isOffline
            ? 'linear-gradient(180deg, #374151 0%, #1f2937 50%, #374151 100%)'
            : isError
              ? 'linear-gradient(180deg, #1c1917 0%, #292524 40%, #422006 100%)'
              : isCharging
                ? 'linear-gradient(180deg, #0c1929 0%, #0f172a 40%, #1e3a5f 100%)'
                : 'linear-gradient(180deg, #065f46 0%, #047857 40%, #059669 100%)',
          animation: isError ? 'error-glow 2s ease-in-out infinite' : undefined,
        }}
      >
        {/* Sky gradient overlay */}
        {!isOffline && (
          <div
            className="absolute inset-x-0 top-0 h-1/2 pointer-events-none"
            style={{
              background: isCharging
                ? 'linear-gradient(180deg, rgba(15,23,42,0.8) 0%, transparent 100%)'
                : 'linear-gradient(180deg, rgba(16,185,129,0.15) 0%, transparent 100%)',
            }}
          />
        )}

        {/* Stars (charging = night scene) */}
        {isCharging && (
          <div className="absolute inset-0 pointer-events-none">
            {[
              { x: '15%', y: '12%' }, { x: '72%', y: '8%' }, { x: '45%', y: '18%' },
              { x: '88%', y: '15%' }, { x: '30%', y: '6%' }, { x: '60%', y: '22%' },
            ].map((s, i) => (
              <div
                key={i}
                className="absolute w-1 h-1 rounded-full bg-white"
                style={{ left: s.x, top: s.y, opacity: 0.3 + (i % 3) * 0.2 }}
              />
            ))}
          </div>
        )}

        {/* Grass blades — scrolls left when mowing for infinite-drive effect */}
        <div
          className="absolute bottom-0 left-0 h-8 pointer-events-none"
          style={{
            width: isMowing ? '200%' : '100%',
            animation: isMowing ? 'ground-scroll 3s linear infinite' : undefined,
          }}
        >
          {GRASS_BLADES.map((blade, i) => (
            <div
              key={i}
              className="absolute bottom-0 rounded-t-full"
              style={{
                left: blade.left,
                width: 3,
                height: blade.height,
                background: isOffline
                  ? '#4b5563'
                  : isCharging
                    ? '#1e3a5f'
                    : '#34d399',
                opacity: isOffline ? 0.4 : 0.6,
                transformOrigin: 'bottom center',
                animation: isMowing
                  ? `grass-cut 0.6s ease-in-out ${blade.delay} infinite`
                  : isMoving
                    ? `grass-sway 1.5s ease-in-out ${blade.delay} infinite`
                    : `grass-sway 3s ease-in-out ${blade.delay} infinite`,
              }}
            />
          ))}
          {/* Duplicate blades for seamless scroll loop */}
          {isMowing && GRASS_BLADES.map((blade, i) => (
            <div
              key={`dup-${i}`}
              className="absolute bottom-0 rounded-t-full"
              style={{
                left: `${parseFloat(blade.left) + 50}%`,
                width: 3,
                height: blade.height,
                background: '#34d399',
                opacity: 0.6,
                transformOrigin: 'bottom center',
                animation: `grass-cut 0.6s ease-in-out ${blade.delay} infinite`,
              }}
            />
          ))}
        </div>

        {/* Scenery — bushes & flowers, scroll with grass during mowing */}
        {!isOffline && !isCharging && (
        <div
          className="absolute bottom-2 left-0 pointer-events-none"
          style={{
            width: isMowing ? '200%' : '100%',
            height: 28,
            animation: isMowing ? 'ground-scroll 3s linear infinite' : undefined,
          }}
        >
          {SCENERY.map((item, i) => (
            item.type === 'bush' ? (
              <svg
                key={`bush-${i}`}
                className="absolute"
                style={{ left: `${item.left}%`, bottom: 0 }}
                width={item.w} height={item.h}
                viewBox={`0 0 ${item.w} ${item.h}`}
              >
                <ellipse cx={item.w / 2} cy={item.h} rx={item.w / 2} ry={item.h * 0.85} fill={item.color} opacity={0.7} />
                <ellipse cx={item.w * 0.35} cy={item.h * 0.7} rx={item.w * 0.3} ry={item.h * 0.55} fill={item.color} opacity={0.85} />
                <ellipse cx={item.w * 0.65} cy={item.h * 0.65} rx={item.w * 0.35} ry={item.h * 0.6} fill={item.color} opacity={0.8} />
              </svg>
            ) : (
              <svg
                key={`flower-${i}`}
                className="absolute"
                style={{ left: `${item.left}%`, bottom: 0 }}
                width={12} height={item.h}
                viewBox={`0 0 12 ${item.h}`}
              >
                {/* Stem */}
                <line x1={6} y1={item.h} x2={6} y2={5} stroke={item.stem} strokeWidth={1.5} />
                {/* Leaf */}
                <ellipse cx={8} cy={item.h * 0.6} rx={3} ry={1.5} fill={item.stem} opacity={0.7} transform={`rotate(-30 8 ${item.h * 0.6})`} />
                {/* Petals */}
                {[0, 72, 144, 216, 288].map((angle) => (
                  <circle
                    key={angle}
                    cx={6 + Math.cos(angle * Math.PI / 180) * 3}
                    cy={5 + Math.sin(angle * Math.PI / 180) * 3}
                    r={2}
                    fill={item.petal}
                    opacity={0.9}
                  />
                ))}
                {/* Center */}
                <circle cx={6} cy={5} r={1.5} fill="#fde047" />
              </svg>
            )
          ))}
          {/* Duplicate scenery for seamless mowing loop */}
          {isMowing && SCENERY.map((item, i) => (
            item.type === 'bush' ? (
              <svg
                key={`bush-dup-${i}`}
                className="absolute"
                style={{ left: `${item.left + 50}%`, bottom: 0 }}
                width={item.w} height={item.h}
                viewBox={`0 0 ${item.w} ${item.h}`}
              >
                <ellipse cx={item.w / 2} cy={item.h} rx={item.w / 2} ry={item.h * 0.85} fill={item.color} opacity={0.7} />
                <ellipse cx={item.w * 0.35} cy={item.h * 0.7} rx={item.w * 0.3} ry={item.h * 0.55} fill={item.color} opacity={0.85} />
                <ellipse cx={item.w * 0.65} cy={item.h * 0.65} rx={item.w * 0.35} ry={item.h * 0.6} fill={item.color} opacity={0.8} />
              </svg>
            ) : (
              <svg
                key={`flower-dup-${i}`}
                className="absolute"
                style={{ left: `${item.left + 50}%`, bottom: 0 }}
                width={12} height={item.h}
                viewBox={`0 0 12 ${item.h}`}
              >
                <line x1={6} y1={item.h} x2={6} y2={5} stroke={item.stem} strokeWidth={1.5} />
                <ellipse cx={8} cy={item.h * 0.6} rx={3} ry={1.5} fill={item.stem} opacity={0.7} transform={`rotate(-30 8 ${item.h * 0.6})`} />
                {[0, 72, 144, 216, 288].map((angle) => (
                  <circle
                    key={angle}
                    cx={6 + Math.cos(angle * Math.PI / 180) * 3}
                    cy={5 + Math.sin(angle * Math.PI / 180) * 3}
                    r={2}
                    fill={item.petal}
                    opacity={0.9}
                  />
                ))}
                <circle cx={6} cy={5} r={1.5} fill="#fde047" />
              </svg>
            )
          ))}
        </div>
        )}

        {/* Ground line */}
        <div
          className="absolute bottom-0 left-0 right-0 h-3"
          style={{
            background: isOffline
              ? '#374151'
              : isCharging
                ? '#0f172a'
                : '#065f46',
          }}
        />

        {/* Mower */}
        <div
          className="absolute -bottom-7"
          style={{
            left: isReturning || isCharging ? '35%' : '50%',
            transform: 'translateX(-50%)',
            animation: isMowing
              ? 'mower-drive 0.6s ease-in-out infinite'
              : isMapping
                ? 'mower-map-drive 5s linear infinite'
                : isReturning
                  ? 'mower-return 4s ease-out forwards'
                  : isPaused || isError
                    ? undefined
                    : 'mower-idle-bob 3s ease-in-out infinite',
            opacity: isOffline ? 0.3 : isPaused ? 0.7 : 1,
            filter: isOffline ? 'grayscale(1)' : isError ? 'hue-rotate(-30deg) saturate(1.5)' : undefined,
          }}
        >
          <div className="relative w-36 h-36">
            {/* Body (without wheel) */}
            <img
              src="/mower/novabot-body.svg"
              alt="Novabot"
              className="absolute inset-0 w-full h-full drop-shadow-lg"
              draggable={false}
            />
            {/* Rear wheel — separate SVG so it can rotate */}
            <img
              src="/mower/novabot-wheel.svg"
              alt=""
              className="absolute pointer-events-none"
              draggable={false}
              style={{
                left: '12.89%',
                top: '47.83%',
                width: '27.34%',
                height: '27.34%',
                animation: isMowing || isMapping
                  ? 'wheel-spin 0.4s linear infinite'
                  : isReturning
                    ? 'wheel-decel 4s ease-out forwards'
                    : undefined,
              }}
            />
          </div>

          {/* Grass clippings (only when mowing) — fly up from behind */}
          {isMowing && (
            <div className="absolute top-[45%] -left-3 pointer-events-none">
              {CLIPPINGS.map((c, i) => (
                <div
                  key={i}
                  className="absolute rounded-full"
                  style={{
                    width: c.size,
                    height: c.size,
                    background: '#6ee7b7',
                    '--dx': `${c.dx}px`,
                    animation: `clipping-fly 0.8s ease-out ${c.delay} infinite`,
                  } as React.CSSProperties}
                />
              ))}
            </div>
          )}
        </div>

        {/* Charging station — visible when returning or charging */}
        {(isReturning || isCharging) && (
          <div className="absolute -bottom-2 right-[6%] pointer-events-none">
            <svg viewBox="0 0 50 60" width="56" height="68" className="drop-shadow-lg">
              {/* Base platform */}
              <rect x={2} y={50} width={46} height={5} rx={2} fill={isCharging ? '#1e3a5f' : '#374151'} />
              {/* Station body */}
              <rect x={8} y={16} width={34} height={36} rx={3} fill={isCharging ? '#1e3a5f' : '#4b5563'} />
              {/* Station top / canopy */}
              <path d="M4 18 L25 4 L46 18 Z" fill={isCharging ? '#2d4a6f' : '#6b7280'} />
              {/* Contact plates */}
              <rect x={12} y={38} width={7} height={12} rx={1} fill="#f59e0b" opacity={isCharging ? 1 : 0.8} />
              <rect x={31} y={38} width={7} height={12} rx={1} fill="#f59e0b" opacity={isCharging ? 1 : 0.8} />
              {/* LED indicator */}
              <circle cx={25} cy={27} r={3.5} fill={isCharging ? '#fbbf24' : '#34d399'} opacity={0.9}>
                <animate attributeName="opacity" values="0.4;1;0.4" dur={isCharging ? '1s' : '1.5s'} repeatCount="indefinite" />
              </circle>
              {/* Charging bolt icon (only when charging) */}
              {isCharging && (
                <path d="M27 20 L23 26 L25.5 26 L23 33 L29 25 L26.5 25 Z" fill="#fbbf24" opacity={0.9}>
                  <animate attributeName="opacity" values="0.6;1;0.6" dur="1.2s" repeatCount="indefinite" />
                </path>
              )}
            </svg>
          </div>
        )}

        {/* Mapping — polygon being drawn */}
        {isMapping && (
          <div className="absolute inset-0 pointer-events-none">
            <svg viewBox="0 0 300 140" className="w-full h-full" preserveAspectRatio="none">
              {/* Grid lines (subtle surveying feel) */}
              {[35, 70, 105].map((y) => (
                <line key={`h${y}`} x1={0} y1={y} x2={300} y2={y} stroke="#a78bfa" strokeWidth={0.3} opacity={0.15} />
              ))}
              {[60, 120, 180, 240].map((x) => (
                <line key={`v${x}`} x1={x} y1={0} x2={x} y2={140} stroke="#a78bfa" strokeWidth={0.3} opacity={0.15} />
              ))}

              {/* Polygon outline — drawn progressively */}
              <polygon
                points="45,95 80,30 170,22 240,45 255,90 220,115 100,118"
                fill="#a78bfa"
                stroke="#c4b5fd"
                strokeWidth={2}
                strokeLinejoin="round"
                style={{
                  fillOpacity: 0,
                  strokeDasharray: 400,
                  strokeDashoffset: 400,
                  animation: 'draw-polygon 5s ease-in-out infinite, fill-polygon 5s ease-in-out infinite',
                }}
              />

              {/* Corner markers — appear sequentially */}
              {[
                { x: 45, y: 95, delay: '0s' },
                { x: 80, y: 30, delay: '0.7s' },
                { x: 170, y: 22, delay: '1.4s' },
                { x: 240, y: 45, delay: '2.1s' },
                { x: 255, y: 90, delay: '2.5s' },
                { x: 220, y: 115, delay: '2.9s' },
                { x: 100, y: 118, delay: '3.3s' },
              ].map((p, i) => (
                <circle
                  key={i}
                  cx={p.x}
                  cy={p.y}
                  r={3}
                  fill="#c4b5fd"
                  style={{
                    animation: `ping-dot 5s ease-out ${p.delay} infinite`,
                    opacity: 0,
                  }}
                />
              ))}

              {/* Moving cursor dot along the path */}
              <circle
                r={4}
                fill="#e9d5ff"
                style={{
                  offsetPath: 'path("M45,95 L80,30 L170,22 L240,45 L255,90 L220,115 L100,118 Z")',
                  animation: 'map-cursor 5s ease-in-out infinite',
                  filter: 'drop-shadow(0 0 4px #a78bfa)',
                }}
              />
            </svg>
          </div>
        )}

        {/* Progress bar (inside scene) */}
        {isMowing && mowingProgress > 0 && (
          <div className="absolute bottom-0 left-0 right-0">
            <div className="h-1 bg-black/20">
              <div
                className="h-full bg-emerald-400/80 transition-all duration-1000"
                style={{ width: `${mowingProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* Battery indicator — top right */}
        <div className="absolute top-3 right-3 flex items-center gap-1">
          <div className="relative w-7 h-3.5 rounded-sm border border-white/30">
            <div className="absolute right-[-3px] top-[3px] w-[3px] h-[5px] rounded-r-sm bg-white/30" />
            <div
              className="absolute left-[1px] top-[1px] bottom-[1px] rounded-[1px] transition-all"
              style={{
                width: `${Math.max(battery, 5)}%`,
                background: battery >= 30 ? '#34d399' : battery >= 15 ? '#fbbf24' : '#ef4444',
              }}
            />
          </div>
          <span className="text-[10px] font-bold text-white/70 tabular-nums">{battery}%</span>
        </div>
      </div>
    </>
  );
}
