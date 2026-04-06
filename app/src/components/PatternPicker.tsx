/**
 * PatternPicker — 6×4 grid of mowing pattern thumbnails (SVG).
 * Each pattern is a JSON with contour data, rendered as SVG paths.
 */
import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors } from '../theme/colors';
import { loadAllPatterns, contourToSvgPath } from '../utils/patternUtils';

interface Props {
  selected: number | null;
  onSelect: (id: number | null) => void;
}

const THUMB = 52;
const PAD = 3;

export function PatternPicker({ selected, onSelect }: Props) {
  const patterns = useMemo(() => loadAllPatterns(), []);

  const thumbPaths = useMemo(() => {
    const map = new Map<number, string[]>();
    for (const [id, contours] of patterns) {
      map.set(id, contours.map(c => contourToSvgPath(c, THUMB, PAD)));
    }
    return map;
  }, [patterns]);

  return (
    <View>
      <View style={styles.header}>
        <Text style={styles.label}>Mow Pattern</Text>
        {selected && (
          <TouchableOpacity onPress={() => onSelect(null)} activeOpacity={0.7}>
            <Text style={styles.clearBtn}>Clear</Text>
          </TouchableOpacity>
        )}
      </View>
      <View style={styles.grid}>
        {Array.from({ length: 24 }, (_, i) => i + 1).map(id => {
          const paths = thumbPaths.get(id);
          const isSelected = selected === id;
          return (
            <TouchableOpacity
              key={id}
              style={[styles.cell, isSelected && styles.cellSelected]}
              onPress={() => onSelect(isSelected ? null : id)}
              activeOpacity={0.7}
            >
              <Svg width="100%" height="100%" viewBox={`0 0 ${THUMB} ${THUMB}`}>
                {paths?.map((d, j) => (
                  <Path
                    key={j}
                    d={d}
                    fill={isSelected ? 'rgba(168,85,247,0.35)' : 'rgba(168,85,247,0.15)'}
                    stroke={isSelected ? '#a855f7' : '#6b7280'}
                    strokeWidth={1.2}
                  />
                ))}
              </Svg>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  clearBtn: {
    fontSize: 12,
    color: colors.purple,
    fontWeight: '600',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  cell: {
    width: '15%',
    aspectRatio: 1,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(255,255,255,0.03)',
    padding: 2,
  },
  cellSelected: {
    borderColor: '#a855f7',
    backgroundColor: 'rgba(168,85,247,0.2)',
  },
});
