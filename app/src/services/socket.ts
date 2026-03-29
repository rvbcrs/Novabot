/**
 * Socket.io client singleton for real-time communication with the OpenNova server.
 */
import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

/**
 * Initialize the Socket.io connection to the server.
 */
export function initSocket(serverUrl: string): Socket {
  if (socket) {
    socket.disconnect();
  }
  socket = io(serverUrl, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });
  return socket;
}

/**
 * Get the current socket instance. Returns null if not initialized.
 */
export function getSocket(): Socket | null {
  return socket;
}

/**
 * Disconnect and clean up the socket.
 */
export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
