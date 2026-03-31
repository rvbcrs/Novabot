/**
 * Proxy Logger — automatisch loggen naar bestand in elke modus.
 *
 * Patcht console.log en console.error zodat ALLE output (HTTP proxy, MQTT bridge,
 * broker events, request/response logs) ook naar een logbestand geschreven wordt.
 *
 * Gebruik: importeer dit bestand als eerste in index.ts.
 * Logbestanden komen in novabot-server/logs/<mode>_<timestamp>.log
 */
import fs from 'fs';
import path from 'path';

// Strip ANSI escape codes voor schone logbestanden
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

let logStream: fs.WriteStream | null = null;

export function initProxyLogger(): void {
  const mode = process.env.PROXY_MODE ?? 'local';

  // Maak logs directory aan relatief aan dit bronbestand (server/logs/)
  const logsDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  // Bestandsnaam met modus + datum+tijd
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const logFile = path.join(logsDir, `${mode}_${ts}.log`);

  logStream = fs.createWriteStream(logFile, { flags: 'a' });
  console.log(`[LOGGER] Proxy logging actief → ${logFile}`);

  // Patch console.log
  const origLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    origLog(...args);
    if (logStream) {
      const timestamp = new Date().toISOString();
      const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      logStream.write(`${timestamp} ${stripAnsi(line)}\n`);
    }
  };

  // Patch console.error
  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    origError(...args);
    if (logStream) {
      const timestamp = new Date().toISOString();
      const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      logStream.write(`${timestamp} [ERROR] ${stripAnsi(line)}\n`);
    }
  };

  // Patch console.warn
  const origWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    if (logStream) {
      const timestamp = new Date().toISOString();
      const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      logStream.write(`${timestamp} [WARN] ${stripAnsi(line)}\n`);
    }
  };

  // Sluit logstream bij afsluiten
  process.on('exit', () => logStream?.end());
  process.on('SIGINT', () => { logStream?.end(); process.exit(0); });
  process.on('SIGTERM', () => { logStream?.end(); process.exit(0); });
}
