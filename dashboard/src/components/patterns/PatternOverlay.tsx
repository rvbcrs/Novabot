import { useMemo } from 'react';
import { Polygon } from 'react-leaflet';
import { transformToGps, type NormContour } from '../../utils/patternUtils.js';

export interface PatternPlacement {
  contours: NormContour[];
  center: { lat: number; lng: number };
  sizeMeter: number;
  rotation: number;
}

interface Props {
  placement: PatternPlacement;
}

/** Renders the placed pattern as purple polygons on the Leaflet map */
export function PatternOverlay({ placement }: Props) {
  const { contours, center, sizeMeter, rotation } = placement;

  const gpsPolygons = useMemo(
    () => contours.map(c => transformToGps(c, center, sizeMeter, rotation)),
    [contours, center, sizeMeter, rotation],
  );

  return (
    <>
      {gpsPolygons.map((poly, i) => (
        <Polygon
          key={i}
          positions={poly.map(p => [p.lat, p.lng] as [number, number])}
          pathOptions={{
            color: '#a855f7',
            fillColor: '#a855f7',
            fillOpacity: 0.2,
            weight: 2,
            dashArray: '6 4',
          }}
        />
      ))}
    </>
  );
}
