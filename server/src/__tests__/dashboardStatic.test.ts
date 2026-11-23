import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mountDashboard, dashboardFallback } from '../dashboardStatic.js';

// GH #172: the Docker build sets every mtime to 0 (rewrite-timestamp), so the
// size+mtime ETag of index.html was the same in every release. After an update
// the browser revalidated, got 304, kept the old page, and the old page asked
// for bundles that no longer existed; the SPA fallback answered those with
// index.html (text/html) and the dashboard stayed white.
describe('dashboard static serving (GH #172)', () => {
  let dir: string;
  let app: express.Express;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><script type="module" src="/assets/index-AAAAAAAA.js"></script></html>');
    fs.writeFileSync(path.join(dir, 'assets', 'index-AAAAAAAA.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dir, 'sw.js'), 'self.x=1');
    // Same mtime as the Docker image: the epoch.
    for (const f of ['index.html', 'assets/index-AAAAAAAA.js', 'sw.js']) {
      fs.utimesSync(path.join(dir, f), 0, 0);
    }
    app = express();
    mountDashboard(app, dir);
    app.use(dashboardFallback(dir));
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('never lets the browser keep index.html', async () => {
    for (const url of ['/', '/index.html', '/some/spa/route']) {
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('does not answer a revalidation of index.html with 304', async () => {
    const first = await request(app).get('/');
    const again = await request(app).get('/')
      .set('If-None-Match', first.headers.etag ?? 'W/"x"')
      .set('If-Modified-Since', 'Thu, 01 Jan 1970 00:00:00 GMT');
    expect(again.status).toBe(200);
  });

  it('serves the service worker uncached', async () => {
    const res = await request(app).get('/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('caches hashed bundles for good', async () => {
    const res = await request(app).get('/assets/index-AAAAAAAA.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('answers a missing bundle with 404, not with the page', async () => {
    const res = await request(app).get('/assets/index-GONEGONE.js');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).not.toMatch(/text\/html/);
  });
});
