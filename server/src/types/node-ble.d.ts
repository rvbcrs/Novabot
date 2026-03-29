declare module 'node-ble' {
  export function createBluetooth(): { bluetooth: unknown; destroy: () => void };
}
