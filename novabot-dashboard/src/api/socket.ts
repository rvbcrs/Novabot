/**
 * Singleton Socket.io client — shared across useSocket hook and joystick commands.
 */
import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io({ transports: ['websocket', 'polling'] });
  }
  return socket;
}

/** Tell server to start joystick mode */
export function joystickStart(sn: string, holdType: number): void {
  getSocket().emit('joystick:start', { sn, holdType });
}

/** Update joystick velocity — server maintains the high-frequency MQTT loop */
export function joystickMove(sn: string, holdType: number, mst: { x_w: number; y_v: number; z_g: number }): void {
  getSocket().emit('joystick:move', { sn, holdType, mst });
}

/** Tell server to stop joystick */
export function joystickStop(sn: string): void {
  getSocket().emit('joystick:stop', { sn });
}
