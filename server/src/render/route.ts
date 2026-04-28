/**
 * HTTP route for the rendered mower map. Used by:
 *   - HA's MQTT image entity (url published with ?ts=… cache-buster)
 *   - browsers / scripts that just want the current SVG
 *
 * No auth — runs on the local network alongside the rest of the dashboard
 * API. The route is read-only and exposes only data already cached in
 * `deviceCache` + `maps` table.
 */
import { Router, Request, Response } from 'express';
import { Resvg } from '@resvg/resvg-js';
import { renderMowerMapSvg } from './svgMap.js';

export const renderRouter = Router();

renderRouter.get('/map/:sn.svg', (req: Request, res: Response) => {
  const { sn } = req.params;
  const svg = renderMowerMapSvg(sn);
  res.type('image/svg+xml; charset=utf-8');
  // Encourage browsers / HA to refresh on every request — the URL itself
  // already carries a ?ts cache-buster from the publisher, but explicit
  // no-store kills any intermediate proxy cache.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(svg);
});

// PNG variant — HA's MQTT image platform with `url_topic` returns 500 when
// fetching SVG, even though the discovery accepts the image entity. Resvg
// rasterizes to PNG which HA's image_proxy can serve cleanly.
renderRouter.get('/map/:sn.png', (req: Request, res: Response) => {
  const { sn } = req.params;
  const svg = renderMowerMapSvg(sn);
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 800 } })
    .render()
    .asPng();
  res.type('image/png');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(png);
});
