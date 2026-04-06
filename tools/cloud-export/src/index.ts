import { createServer } from './server';
import { exec } from 'child_process';
import os from 'os';

const PORT = parseInt(process.env.PORT ?? '7780', 10);

const app = createServer();

const server = app.listen(PORT, '0.0.0.0', () => {
  const url = `http://localhost:${PORT}`;

  console.log('');
  console.log('╔════════════════════════════════════════════╗');
  console.log('║   Novabot Cloud Export Tool                ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log(`║  Open: ${url.padEnd(37)}║`);
  console.log('╚════════════════════════════════════════════╝');
  console.log('');

  // Don't open browser in Docker or when NO_BROWSER is set
  if (!process.env.DOCKER && !process.env.NO_BROWSER) {
    openBrowser(url);
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
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
