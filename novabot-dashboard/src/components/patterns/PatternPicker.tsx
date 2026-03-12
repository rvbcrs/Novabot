import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { preloadPatterns, contourToSvgPath, type NormContour } from '../../utils/patternUtils.js';

interface Props {
  selected: number | null;
  onSelect: (id: number) => void;
}

const THUMB = 52;     // thumbnail viewBox size
const PAD = 3;        // SVG padding
const TOTAL = 24;

export function PatternPicker({ selected, onSelect }: Props) {
  const { t } = useTranslation();
  const [patterns, setPatterns] = useState<Map<number, NormContour[]>>(new Map());

  useEffect(() => {
    preloadPatterns().then(setPatterns);
  }, []);

  const thumbPaths = useMemo(() => {
    const map = new Map<number, string[]>();
    for (const [id, contours] of patterns) {
      map.set(id, contours.map(c => contourToSvgPath(c, THUMB, PAD)));
    }
    return map;
  }, [patterns]);

  if (patterns.size === 0) {
    return <div className="text-xs text-gray-500 py-2">{t('pattern.loading', 'Loading...')}</div>;
  }

  return (
    <div>
      <div className="text-xs font-medium text-gray-400 mb-1.5">{t('pattern.select')}</div>
      <div className="grid grid-cols-6 gap-1.5">
        {Array.from({ length: TOTAL }, (_, i) => i + 1).map(id => {
          const paths = thumbPaths.get(id);
          const isSelected = selected === id;
          return (
            <button
              key={id}
              onClick={() => onSelect(id)}
              className={`
                aspect-square rounded-md border-2 transition-all p-0.5
                hover:border-purple-400 hover:bg-purple-500/10
                ${isSelected
                  ? 'border-purple-500 bg-purple-500/20 ring-1 ring-purple-400'
                  : 'border-gray-700 bg-gray-800/50'}
              `}
              title={`Pattern ${id}`}
            >
              <svg viewBox={`0 0 ${THUMB} ${THUMB}`} className="w-full h-full">
                {paths?.map((d, j) => (
                  <path
                    key={j}
                    d={d}
                    fill={isSelected ? 'rgba(168,85,247,0.35)' : 'rgba(168,85,247,0.15)'}
                    stroke={isSelected ? '#a855f7' : '#6b7280'}
                    strokeWidth={1.2}
                  />
                ))}
              </svg>
            </button>
          );
        })}
      </div>
    </div>
  );
}
