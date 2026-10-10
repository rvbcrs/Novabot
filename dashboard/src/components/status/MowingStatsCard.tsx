import { Scissors, Ruler, Disc3, Timer, Hourglass, Gauge, Grid2x2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  sensors: Record<string, string>;
  /** Compact layout for the map overlay: progress + key chips only. */
  compact?: boolean;
  /** Totale zone-oppervlakte (m²) = polygon-area van de work-map(s), zoals de
   *  app toont. Coverage-planner-schatting (cov_area+remaining) wijkt hiervan af. */
  totalAreaM2?: number | null;
}

/**
 * MowingStatsCard — mirrors the OpenNova app's live mowing chips
 * (HomeScreen.tsx). All derivations replicate the app verbatim; see the
 * per-field comments. Each chip hides when its source sensor is absent/zero,
 * exactly like the app.
 */

/** Progress % — fallback chain from HomeScreen.tsx ~296-310 (authoritative). */
function deriveProgress(s: Record<string, string>): number {
  if (s.edge_active === '1') {
    const er = parseFloat(s.edge_covered_ratio ?? '0');
    if (er > 0 && er <= 1) return Math.round(er * 100);
    return 0;
  }
  const ratio = parseFloat(s.cov_ratio ?? '0');
  if (ratio > 0 && ratio <= 1) return Math.round(ratio * 100);
  return Math.round(parseFloat(s.mowing_progress ?? '0')) || 0;
}

/** Cutting height: wire = parseInt(target_height) (enum 0..7), display cm = wire + 2. */
function deriveHeightCm(s: Record<string, string>): number | null {
  const reported = s.target_height;
  if (reported == null || reported === '') return null;
  const wire = parseInt(reported, 10);
  if (!Number.isFinite(wire)) return null;
  return wire + 2;
}

/** cov_estimate_time (remaining) and cov_work_time (elapsed) are both MINUTES
 *  (server unit 'min'): robot_decision divides the planner's seconds by 60. */
function fmtMinutes(mins: number): string | null {
  if (!isFinite(mins) || mins <= 0) return null;
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins - h * 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

interface ChipProps {
  icon: React.ReactNode;
  label: string;
  value: string;
}

function Chip({ icon, label, value }: ChipProps) {
  return (
    <div className="flex items-center gap-2.5 bg-gray-800/50 rounded-xl px-3 py-2 border border-gray-700/60">
      <span className="grid place-items-center w-7 h-7 rounded-lg bg-emerald-950/40 border border-emerald-800/30 text-emerald-400 shrink-0">{icon}</span>
      <div className="flex flex-col leading-tight min-w-0">
        <span className="text-[9px] font-semibold uppercase tracking-[0.1em] text-gray-500 truncate">{label}</span>
        <span className="text-sm font-semibold text-white tabular-nums truncate">{value}</span>
      </div>
    </div>
  );
}

export function MowingStatsCard({ sensors, compact, totalAreaM2 }: Props) {
  const { t } = useTranslation();
  const s = sensors ?? {};

  const progress = deriveProgress(s);
  const heightCm = deriveHeightCm(s);
  const bladeRpm = parseInt(s.blade_speed ?? '0', 10) || 0;
  const elapsed = fmtMinutes(parseFloat(s.cov_work_time ?? ''));
  const eta = fmtMinutes(parseFloat(s.cov_estimate_time ?? ''));
  const mowSpeed = s.mow_speed != null && s.mow_speed !== '' ? s.mow_speed : null;
  // Area = echte zone-oppervlakte (polygon-area, zoals de app), met gemaaid =
  // progress% van het totaal. Valt terug op de coverage-schatting (cov_area +
  // cov_remaining_area) als de polygon-area niet beschikbaar is.
  let area: string | null = null;
  if (totalAreaM2 != null && totalAreaM2 > 0) {
    const done = Math.round((progress / 100) * totalAreaM2);
    area = `${done} / ${Math.round(totalAreaM2)} m²`;
  } else {
    const covered = parseFloat(s.cov_area ?? s.covering_area ?? '');
    const remaining = parseFloat(s.cov_remaining_area ?? '');
    if (Number.isFinite(covered) && covered >= 0) {
      const total = Number.isFinite(remaining) && remaining >= 0 ? covered + remaining : null;
      area = total != null && total > 0
        ? `${Math.round(covered)} / ${Math.round(total)} m²`
        : `${Math.round(covered)} m²`;
    }
  }

  const iconSize = 'w-4 h-4';

  const chips: ChipProps[] = [];
  if (heightCm != null) {
    chips.push({
      icon: <Ruler className={iconSize} />,
      label: t('status.cuttingHeight', 'Cutting height'),
      value: `${heightCm} cm`,
    });
  }
  if (bladeRpm > 0) {
    chips.push({
      icon: <Disc3 className={iconSize} />,
      label: t('status.bladeRpm', 'Blade speed'),
      value: `${bladeRpm} rpm`,
    });
  }
  if (eta) {
    chips.push({
      icon: <Hourglass className={iconSize} />,
      label: t('status.eta', 'Time left'),
      value: t('status.etaValue', { time: eta, defaultValue: '~{{time}} left' }),
    });
  }
  // Area (gemaaid / totaal m²) ook in de compacte overlay tonen.
  if (area) {
    chips.push({
      icon: <Grid2x2 className={iconSize} />,
      label: t('status.area', 'Area'),
      value: area,
    });
  }
  // Volledige layout voegt verstreken tijd + snelheid toe.
  if (!compact) {
    if (elapsed) {
      chips.push({
        icon: <Timer className={iconSize} />,
        label: t('status.elapsed', 'Elapsed'),
        value: elapsed,
      });
    }
    if (mowSpeed) {
      chips.push({
        icon: <Gauge className={iconSize} />,
        label: t('status.mowSpeed', 'Mow speed'),
        value: mowSpeed,
      });
    }
  }

  return (
    <div className="bg-gray-900/85 backdrop-blur border border-gray-700 rounded-2xl p-4 shadow-xl">
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <Scissors className="w-4 h-4 text-emerald-400" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400">{t('status.mowingProgress')}</span>
        </div>
        <span className="text-base font-bold text-white tabular-nums">
          {progress}<span className="text-xs font-semibold text-gray-400">%</span>
        </span>
      </div>
      <div className="h-2 bg-gray-700/60 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${progress}%`, background: 'linear-gradient(90deg,#34d399,#a3e635)' }}
        />
      </div>

      {chips.length > 0 && (
        <div
          className={
            compact
              ? 'mt-3 flex flex-wrap gap-2'
              : 'mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2'
          }
        >
          {chips.map((c) => (
            <Chip key={c.label} {...c} />
          ))}
        </div>
      )}
    </div>
  );
}
