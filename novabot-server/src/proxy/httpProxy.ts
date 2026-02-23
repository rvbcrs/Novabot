/**
 * HTTP Proxy middleware — forwards ALL requests to the real Novabot cloud
 * (app.lfibot.com) and logs both request and response in full.
 *
 * Activated when PROXY_MODE=cloud.
 */
import { Request, Response, NextFunction } from 'express';
import https from 'node:https';
import http from 'node:http';

// Gebruik direct het IP-adres om DNS-rewrite loops te voorkomen
// (app.lfibot.com wordt lokaal omgeleid naar onze server)
const UPSTREAM = process.env.UPSTREAM_HTTP ?? 'https://47.253.145.99';
const parsed = new URL(UPSTREAM);
const isHttps = parsed.protocol === 'https:';

export function cloudHttpProxy(req: Request, res: Response, _next: NextFunction): void {
  const bodyChunks: Buffer[] = [];

  // Collect the raw body (Express may have already parsed it)
  const rawBody = JSON.stringify(req.body);
  const bodyBuf = Buffer.from(rawBody === 'undefined' ? '' : rawBody, 'utf-8');

  const headers: Record<string, string> = {};
  // Forward relevant headers
  for (const key of Object.keys(req.headers)) {
    const val = req.headers[key];
    if (val && key !== 'host' && key !== 'connection' && key !== 'content-length') {
      headers[key] = Array.isArray(val) ? val.join(', ') : val;
    }
  }
  // Stuur altijd app.lfibot.com als Host header (upstream verwacht dit)
  headers['host'] = 'app.lfibot.com';
  if (bodyBuf.length > 0) {
    headers['content-length'] = String(bodyBuf.length);
  }

  const tag = `[PROXY-HTTP]`;
  console.log(`\n${tag} ──────────────────────────────────────`);
  console.log(`${tag} >>> ${req.method} ${req.originalUrl}`);
  if (bodyBuf.length > 0 && bodyBuf.length < 4096) {
    try {
      const pretty = JSON.stringify(JSON.parse(rawBody), null, 2);
      console.log(`${tag} >>> Body:\n${pretty}`);
    } catch {
      console.log(`${tag} >>> Body: ${rawBody}`);
    }
  }
  // Log auth header (masked)
  if (headers['authorization']) {
    const token = headers['authorization'];
    console.log(`${tag} >>> Authorization: ${token.substring(0, 30)}...`);
  }

  const options: https.RequestOptions = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: req.originalUrl,
    method: req.method,
    headers,
    // SNI servername zodat TLS certificaat werkt met IP-adres
    servername: 'app.lfibot.com',
    // Accepteer self-signed/mismatched certs voor het geval de cloud server
    // geen geldig cert heeft voor het IP-adres
    rejectUnauthorized: false,
  };

  const proxyReq = (isHttps ? https : http).request(options, (proxyRes) => {
    const chunks: Buffer[] = [];
    proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
    proxyRes.on('end', () => {
      const responseBody = Buffer.concat(chunks).toString('utf-8');

      console.log(`${tag} <<< ${proxyRes.statusCode} ${proxyRes.statusMessage}`);
      if (responseBody.length < 8192) {
        try {
          const pretty = JSON.stringify(JSON.parse(responseBody), null, 2);
          console.log(`${tag} <<< Body:\n${pretty}`);
        } catch {
          console.log(`${tag} <<< Body: ${responseBody.substring(0, 2000)}`);
        }
      } else {
        console.log(`${tag} <<< Body: (${responseBody.length} bytes, truncated)`);
      }
      console.log(`${tag} ──────────────────────────────────────\n`);

      // Forward status + headers + body to the original client
      res.status(proxyRes.statusCode ?? 502);
      for (const [key, val] of Object.entries(proxyRes.headers)) {
        if (val && key !== 'transfer-encoding' && key !== 'connection') {
          res.setHeader(key, val);
        }
      }
      res.end(responseBody);
    });
  });

  proxyReq.on('error', (err) => {
    console.error(`${tag} !!! Upstream error: ${err.message}`);
    res.status(502).json({ code: 502, msg: `Proxy error: ${err.message}`, data: null });
  });

  if (bodyBuf.length > 0) {
    proxyReq.write(bodyBuf);
  }
  proxyReq.end();
}
