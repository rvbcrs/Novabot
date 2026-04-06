/**
 * MowerScene — renders the dashboard's MowerAnimation via WebView.
 * This gives us the exact same CSS keyframe animations (grass, wheels, scenery)
 * without porting 500+ lines of CSS/SVG to react-native-reanimated.
 */
import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import type { MowerActivity } from '../types';

interface Props {
  activity: MowerActivity;
  battery: number;
  mowingProgress?: number;
  height?: number;
}

export function MowerScene({ activity, battery, mowingProgress = 0, height = 160 }: Props) {
  // Build the HTML once, update via postMessage when activity changes
  const html = useMemo(() => buildMowerHtml(activity, battery, mowingProgress), [activity, battery, mowingProgress]);

  return (
    <View style={[styles.container, { height }]}>
      <WebView
        source={{ html }}
        style={styles.webview}
        scrollEnabled={false}
        bounces={false}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        originWhitelist={['*']}
        javaScriptEnabled={true}
        allowsInlineMediaPlayback
      />
    </View>
  );
}

function buildMowerHtml(activity: MowerActivity, battery: number, mowingProgress: number): string {
  // Inline the full CSS animation from the dashboard
  const isMowing = activity === 'mowing';
  const isCharging = activity === 'charging';
  const isReturning = activity === 'returning';
  const isPaused = activity === 'paused';
  const isMapping = activity === 'mapping';
  const isError = activity === 'error';
  const isOffline = activity === 'idle' && battery === 0;
  const isMoving = isMowing || isReturning || isMapping;

  const bgGrad = isOffline
    ? 'linear-gradient(180deg, #374151 0%, #1f2937 50%, #374151 100%)'
    : isError
      ? 'linear-gradient(180deg, #1c1917 0%, #292524 40%, #422006 100%)'
      : isCharging
        ? 'linear-gradient(180deg, #0c1929 0%, #0f172a 40%, #1e3a5f 100%)'
        : 'linear-gradient(180deg, #065f46 0%, #047857 40%, #059669 100%)';

  const grassColor = isOffline ? '#4b5563' : isCharging ? '#1e3a5f' : '#34d399';
  const groundColor = isOffline ? '#374151' : isCharging ? '#0f172a' : '#065f46';

  // Generate grass blades
  const blades = Array.from({ length: 28 }, (_, i) => {
    const left = (i * 3.6) + 0.5;
    const h = 14 + (i % 5) * 4;
    const delay = ((i * 0.12) % 1.5).toFixed(2);
    const anim = isMowing
      ? `grass-cut 0.6s ease-in-out ${delay}s infinite`
      : isMoving
        ? `grass-sway 1.5s ease-in-out ${delay}s infinite`
        : `grass-sway 3s ease-in-out ${delay}s infinite`;
    return `<div style="position:absolute;bottom:0;left:${left}%;width:3px;height:${h}px;background:${grassColor};opacity:0.6;border-radius:3px 3px 0 0;transform-origin:bottom center;animation:${anim}"></div>`;
  }).join('');

  const mowerAnim = isMowing
    ? 'mower-drive 0.6s ease-in-out infinite'
    : isMapping
      ? 'mower-map-drive 5s linear infinite'
      : isReturning
        ? 'mower-return 4s ease-out forwards'
        : isPaused || isError
          ? 'none'
          : 'mower-idle-bob 3s ease-in-out infinite';

  const mowerLeft = isReturning || isCharging ? '35%' : '50%';
  const mowerOpacity = isOffline ? 0.3 : isPaused ? 0.7 : 1;

  // Charger station SVG
  const chargerSvg = (isReturning || isCharging) ? `
    <div style="position:absolute;bottom:-2px;right:6%">
      <svg viewBox="0 0 50 60" width="56" height="68">
        <rect x="2" y="50" width="46" height="5" rx="2" fill="${isCharging ? '#1e3a5f' : '#374151'}" />
        <rect x="8" y="16" width="34" height="36" rx="3" fill="${isCharging ? '#1e3a5f' : '#4b5563'}" />
        <path d="M4 18 L25 4 L46 18 Z" fill="${isCharging ? '#2d4a6f' : '#6b7280'}" />
        <rect x="12" y="38" width="7" height="12" rx="1" fill="#f59e0b" opacity="${isCharging ? 1 : 0.8}" />
        <rect x="31" y="38" width="7" height="12" rx="1" fill="#f59e0b" opacity="${isCharging ? 1 : 0.8}" />
        <circle cx="25" cy="27" r="3.5" fill="${isCharging ? '#fbbf24' : '#34d399'}" opacity="0.9">
          <animate attributeName="opacity" values="0.4;1;0.4" dur="${isCharging ? '1s' : '1.5s'}" repeatCount="indefinite" />
        </circle>
        ${isCharging ? '<path d="M27 20 L23 26 L25.5 26 L23 33 L29 25 L26.5 25 Z" fill="#fbbf24" opacity="0.9"><animate attributeName="opacity" values="0.6;1;0.6" dur="1.2s" repeatCount="indefinite" /></path>' : ''}
      </svg>
    </div>
  ` : '';

  // Stars for charging (night scene)
  const stars = isCharging ? [
    { x: '15%', y: '12%' }, { x: '72%', y: '8%' }, { x: '45%', y: '18%' },
    { x: '88%', y: '15%' }, { x: '30%', y: '6%' }, { x: '60%', y: '22%' },
  ].map((s, i) => `<div style="position:absolute;left:${s.x};top:${s.y};width:4px;height:4px;border-radius:50%;background:#fff;opacity:${0.3 + (i % 3) * 0.2}"></div>`).join('') : '';

  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{overflow:hidden;background:transparent}
.scene{position:relative;width:100%;height:160px;border-radius:20px;overflow:hidden;background:${bgGrad};${isError ? 'animation:error-glow 2s ease-in-out infinite' : ''}}
@keyframes mower-drive{0%{transform:translateY(0)}25%{transform:translateY(-1.5px)}50%{transform:translateY(0)}75%{transform:translateY(-1px)}100%{transform:translateY(0)}}
@keyframes ground-scroll{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}
@keyframes mower-return{0%{transform:translateX(-160px)}60%{transform:translateX(10px)}80%{transform:translateX(12px)}100%{transform:translateX(12px)}}
@keyframes mower-idle-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
@keyframes grass-sway{0%,100%{transform:rotate(-5deg) scaleY(1)}50%{transform:rotate(5deg) scaleY(0.92)}}
@keyframes grass-cut{0%,100%{transform:rotate(-8deg) scaleY(1)}30%{transform:rotate(12deg) scaleY(0.7)}60%{transform:rotate(-4deg) scaleY(0.85)}}
@keyframes error-glow{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}50%{box-shadow:0 0 20px 4px rgba(239,68,68,0.3)}}
@keyframes mower-map-drive{0%{transform:translateX(-350px)}100%{transform:translateX(350px)}}
@keyframes charge-pulse{0%,100%{opacity:0.4;transform:scale(0.95)}50%{opacity:1;transform:scale(1.05)}}
</style></head><body>
<div class="scene">
  ${stars}
  <div style="position:absolute;bottom:0;left:0;height:32px;width:${isMowing ? '200%' : '100%'};${isMowing ? 'animation:ground-scroll 3s linear infinite' : ''}">
    ${blades}
  </div>
  <div style="position:absolute;bottom:0;left:0;right:0;height:12px;background:${groundColor}"></div>
  <div style="position:absolute;bottom:-28px;left:${mowerLeft};transform:translateX(-50%);animation:${mowerAnim};opacity:${mowerOpacity}">
    <div style="width:144px;height:144px;position:relative">
      <div style="width:100%;height:100%;background:url('data:image/svg+xml,${encodeURIComponent(MOWER_SVG)}') center/contain no-repeat"></div>
    </div>
  </div>
  ${chargerSvg}
</div>
</body></html>`;
}

// Simplified mower SVG inline (side view silhouette)
const MOWER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80">
  <rect x="15" y="20" width="90" height="40" rx="12" fill="#374151" stroke="#4b5563" stroke-width="1.5"/>
  <rect x="20" y="15" width="75" height="25" rx="8" fill="#1f2937"/>
  <rect x="55" y="12" width="35" height="20" rx="6" fill="#111827" opacity="0.7"/>
  <circle cx="30" cy="62" r="12" fill="#1f2937" stroke="#6b7280" stroke-width="2"/>
  <circle cx="30" cy="62" r="4" fill="#374151"/>
  <circle cx="90" cy="62" r="10" fill="#1f2937" stroke="#6b7280" stroke-width="2"/>
  <circle cx="90" cy="62" r="3" fill="#374151"/>
  <rect x="10" y="55" width="25" height="4" rx="2" fill="#059669" opacity="0.8"/>
</svg>`;

const styles = StyleSheet.create({
  container: {
    borderRadius: 20,
    overflow: 'hidden',
    marginBottom: 16,
  },
  webview: {
    flex: 1,
    backgroundColor: 'transparent',
  },
});
