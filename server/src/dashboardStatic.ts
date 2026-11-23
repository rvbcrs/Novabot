import express from 'express';
import path from 'path';
import type { Express, RequestHandler } from 'express';

// The Docker build sets every file's mtime to 0 (rewrite-timestamp), so the
// size+mtime ETag that express.static sends is the same for every release of
// an equally sized file. index.html keeps its size across releases (only the
// hashes in the bundle names change): after an update the browser revalidated,
// got 304 and kept the old page, whose bundles were gone (GH #172). So the page
// and the service worker are never stored, and the hashed bundles, whose names
// change with their content, are cached for good. No ETag/Last-Modified at all:
// a browser still holding the old page sends If-None-Match W/"53f-0", and any
// validator the server can match would answer that with 304 again.
const NO_STORE = 'no-store';
const IMMUTABLE = 'public, max-age=31536000, immutable';

function noStore(file: string): boolean {
  return file.endsWith('.html') || path.basename(file) === 'sw.js';
}

export function mountDashboard(app: Express, dashboardPath: string): void {
  app.use(express.static(dashboardPath, {
    etag: false,
    lastModified: false,
    setHeaders(res, file) {
      if (noStore(file)) res.setHeader('Cache-Control', NO_STORE);
      else if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', IMMUTABLE);
    },
  }));
}

/** SPA fallback: every unknown route gets index.html, except a missing file
 *  under /assets/. Answering that one with the page made the browser load HTML
 *  as a JavaScript module and the dashboard stayed white (GH #172). */
export function dashboardFallback(dashboardPath: string): RequestHandler {
  return (req, res) => {
    if (req.path.startsWith('/assets/')) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    // etag is passed through to `send`; @types/express does not list it.
    const opts = { etag: false, lastModified: false, headers: { 'Cache-Control': NO_STORE } };
    res.sendFile(path.join(dashboardPath, 'index.html'), opts, (err) => {
      if (err) res.status(404).json({ code: 404, msg: 'Not found', data: null });
    });
  };
}
