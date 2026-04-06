import { createApp } from './server.js';
import { exec } from 'child_process';
import os from 'os';

const PORT = parseInt(process.env.PORT ?? '7790', 10);

const { httpServer } = createApp();

httpServer.listen(PORT, '0.0.0.0', () => {
  const url = `http://localhost:${PORT}`;

  console.log('');
  console.log('╔════════════════════════════════════════════╗');
  console.log('║   Novabot BLE Diagnostic Tool              ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log(`║  Open: ${url.padEnd(37)}║`);
  console.log('╚════════════════════════════════════════════╝');
  console.log('');

  if (!process.env.NO_BROWSER) {
    openBrowser(url);
  }
});

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. Is another instance running?`);
    process.exit(1);
  }
  console.error('Server error:', err.message);
  process.exit(1);
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
  exec(cmd, () => {});
}
