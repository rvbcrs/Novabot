import { createServer } from './server.js';
import { exec } from 'child_process';
import os from 'os';

const PORT = 7789;

const httpServer = createServer();

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[Bootstrap] Poort ${PORT} is al in gebruik. Is er al een instantie actief?`);
    console.error(`[Bootstrap] Sluit andere instanties af en probeer opnieuw.\n`);
    process.exit(1);
  }
  console.error('[Bootstrap] HTTP server fout:', err.message);
  process.exit(1);
});

httpServer.listen(PORT, '0.0.0.0', () => {
  const url = `http://localhost:${PORT}`;

  console.log('');
  console.log('╔════════════════════════════════════════════╗');
  console.log('║     OpenNova Bootstrap — OTA Wizard        ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log(`║  Wizard: ${url.padEnd(35)}║`);
  console.log('║  MQTT:   poort 1883 (wacht op maaier)     ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log('');
  console.log('Druk Ctrl+C om af te sluiten.');

  openBrowser(url);
});

function openBrowser(url: string): void {
  const platform = os.platform();
  let cmd: string;

  if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else if (platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }

  exec(cmd, (err) => {
    if (err) {
      console.log(`\nOpen je browser en ga naar: ${url}`);
    }
  });
}
