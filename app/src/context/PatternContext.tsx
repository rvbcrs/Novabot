/**
 * PatternContext — shared state for pattern placement between StartMowSheet and MapScreen.
 *
 * Flow:
 *   1. StartMowSheet: user selects pattern → sets patternId + enters placement mode
 *   2. MapScreen: detects placement mode → shows tap-to-place overlay
 *   3. User taps map → sets center GPS coordinate
 *   4. User adjusts size/rotation → updates placement
 *   5. User confirms → StartMowSheet reads placement → sends start_run
 */
import React, { createContext, useContext, useState, useCallback } from 'react';
import type { NormContour } from '../utils/patternUtils';
import { loadPattern } from '../utils/patternUtils';

export interface PatternPlacement {
  patternId: number;
  contours: NormContour[];
  center: { lat: number; lng: number } | null;
  sizeMeter: number;
  rotation: number;
}

interface PatternContextState {
  placement: PatternPlacement | null;
  isPlacing: boolean;

  /** Called from StartMowSheet to enter placement mode */
  startPlacement: (patternId: number, size: number, rotation: number) => void;

  /** Called from MapScreen when user taps to set center */
  setCenter: (lat: number, lng: number) => void;

  /** Update size/rotation */
  setSize: (size: number) => void;
  setRotation: (rotation: number) => void;

  /** Confirm placement and exit placement mode */
  confirmPlacement: () => void;

  /** Cancel placement */
  cancelPlacement: () => void;
}

const PatternContext = createContext<PatternContextState>({
  placement: null,
  isPlacing: false,
  startPlacement: () => {},
  setCenter: () => {},
  setSize: () => {},
  setRotation: () => {},
  confirmPlacement: () => {},
  cancelPlacement: () => {},
});

export function PatternProvider({ children }: { children: React.ReactNode }) {
  const [placement, setPlacement] = useState<PatternPlacement | null>(null);
  const [isPlacing, setIsPlacing] = useState(false);

  const startPlacement = useCallback((patternId: number, size: number, rotation: number) => {
    const contours = loadPattern(patternId);
    setPlacement({ patternId, contours, center: null, sizeMeter: size, rotation });
    setIsPlacing(true);
  }, []);

  const setCenter = useCallback((lat: number, lng: number) => {
    setPlacement(prev => prev ? { ...prev, center: { lat, lng } } : null);
  }, []);

  const setSize = useCallback((size: number) => {
    setPlacement(prev => prev ? { ...prev, sizeMeter: size } : null);
  }, []);

  const setRotation = useCallback((rotation: number) => {
    setPlacement(prev => prev ? { ...prev, rotation } : null);
  }, []);

  const confirmPlacement = useCallback(() => {
    setIsPlacing(false);
    // Keep placement data so StartMowSheet can read it
  }, []);

  const cancelPlacement = useCallback(() => {
    setIsPlacing(false);
    setPlacement(null);
  }, []);

  return (
    <PatternContext.Provider value={{
      placement, isPlacing,
      startPlacement, setCenter, setSize, setRotation,
      confirmPlacement, cancelPlacement,
    }}>
      {children}
    </PatternContext.Provider>
  );
}

export function usePattern(): PatternContextState {
  return useContext(PatternContext);
}
