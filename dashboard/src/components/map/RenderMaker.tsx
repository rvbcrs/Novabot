/**
 * "New 3D render" as one window with two plain choices, instead of four menu
 * rows under small headers. Making a render costs a credit or API usage, so
 * this is also where replacing an existing one is said out loud.
 */
import { useEffect, useState } from 'react';
import { Box, Navigation, Layers, Image as ImageIcon, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GardenRenderFraming } from '../../api/client';

interface Props {
  open: boolean;
  hasDronePhoto: boolean;
  /** Which framings already exist, to warn about replacing. */
  existing: Record<GardenRenderFraming, boolean>;
  initialFraming: GardenRenderFraming;
  onClose: () => void;
  onMake: (source: 'aerial' | 'drone', framing: GardenRenderFraming) => void;
}

function Choice({ active, onClick, icon: Icon, title, desc }: {
  active: boolean; onClick: () => void; icon: React.ComponentType<{ className?: string }>; title: string; desc: string;
}) {
  return (
    <button type="button" onClick={onClick}
      className={`flex-1 text-left rounded-xl border px-3 py-2.5 transition-colors ${active
        ? 'border-emerald-500 bg-emerald-500/10' : 'border-gray-700 bg-gray-800/40 hover:bg-gray-800/70'}`}>
      <span className="flex items-center gap-2 text-sm font-semibold text-white">
        <Icon className={`w-4 h-4 ${active ? 'text-emerald-400' : 'text-gray-400'}`} />{title}
      </span>
      <span className="block text-xs text-gray-400 mt-1 leading-snug">{desc}</span>
    </button>
  );
}

export function RenderMaker({ open, hasDronePhoto, existing, initialFraming, onClose, onMake }: Props) {
  const { t } = useTranslation();
  const [framing, setFraming] = useState<GardenRenderFraming>(initialFraming);
  const [source, setSource] = useState<'aerial' | 'drone'>('aerial');

  useEffect(() => { if (open) { setFraming(initialFraming); setSource('aerial'); } }, [open, initialFraming]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const label = 'text-[10px] font-bold uppercase tracking-[0.12em] text-gray-500 mb-2';

  return (
    <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-gray-900 border border-gray-700/50 rounded-2xl shadow-2xl max-w-md w-full p-6">
        <div className="flex items-center gap-2 mb-5">
          <Sparkles className="w-5 h-5 text-emerald-400" />
          <h2 className="text-lg font-semibold text-white">{t('map.render.newTitle', 'Nieuwe 3D-render')}</h2>
        </div>

        <div className={label}>{t('map.render.framing', 'Aanzicht')}</div>
        <div className="flex gap-2 mb-5">
          <Choice active={framing === 'flat'} onClick={() => setFraming('flat')} icon={Navigation}
            title={t('map.render.flat', 'Bovenaf')}
            desc={t('map.render.flatDesc', 'Ligt op de kaart. Zones, maaier en banen erbovenop.')} />
          <Choice active={framing === 'iso'} onClick={() => setFraming('iso')} icon={Box}
            title={t('map.render.iso', 'Schuin')}
            desc={t('map.render.isoDesc', '3D-plaatje van opzij, met maaier en banen erop.')} />
        </div>

        <div className={label}>{t('map.render.source', 'Gemaakt van')}</div>
        <div className="flex gap-2 mb-5">
          <Choice active={source === 'aerial'} onClick={() => setSource('aerial')} icon={Layers}
            title={t('map.render.aerial', 'Luchtfoto')}
            desc={t('map.render.aerialDesc', 'Werkt overal, beeld is 1 tot 3 jaar oud.')} />
          {hasDronePhoto && (
            <Choice active={source === 'drone'} onClick={() => setSource('drone')} icon={ImageIcon}
              title={t('map.render.drone', 'Dronefoto')}
              desc={t('map.render.droneDesc', 'Je eigen foto: scherper en actueel.')} />
          )}
        </div>

        <p className="text-xs text-gray-400 leading-relaxed">
          {t('map.render.costNote', 'Duurt 1 tot 3 minuten en kost een credit of API-tegoed. Er worden een dag- en een avondversie gemaakt.')}
          {existing[framing] && (
            <span className="block text-amber-400 mt-1">
              {t('map.render.replaceNote', 'Vervangt de bestaande render in dit aanzicht.')}
            </span>
          )}
        </p>

        <div className="flex gap-3 mt-6">
          <button type="button" onClick={onClose}
            className="flex-1 py-2.5 bg-white/10 hover:bg-white/15 text-gray-300 text-sm font-medium rounded-xl transition-colors">
            {t('common.cancel', 'Annuleren')}
          </button>
          <button type="button" onClick={() => onMake(source, framing)}
            className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-xl transition-colors">
            {t('map.render.make', 'Render maken')}
          </button>
        </div>
      </div>
    </div>
  );
}
