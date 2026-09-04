/**
 * Serial write queue for the BLE joystick with "latest move wins".
 *
 * Why this exists: MappingScreen fires an `mst` (velocity) frame every 200 ms
 * without waiting for the previous BLE write. The old queue was a bare promise
 * chain, so when a write took longer than 200 ms (2.4 GHz interference is
 * enough) every tick appended another STALE velocity and `stop_move` landed
 * behind all of them. Result: the mower kept driving the backlog for seconds
 * after the user let go (GH #114, "keeps moving 2-3 s after I change
 * direction").
 *
 * Rules:
 *  - `enqueue(frame)`     strict FIFO — used for start_move / stop_move, whose
 *                          order relative to moves must hold.
 *  - `setLatestMove(frame)` coalescing — at most ONE move is ever waiting; a
 *                          newer move replaces it. When the link is fast every
 *                          tick still goes out (identical traffic to before).
 *  - `dropPendingMove()`  forget the waiting move — called right before
 *                          enqueueing stop_move so the stop follows the
 *                          in-flight write immediately.
 *
 * Pure: the actual transport is injected, so this is unit-testable without
 * react-native-ble-plx.
 */
export class JoystickWriteQueue {
  private chain: Promise<void> = Promise.resolve();
  private pendingMove: string | null = null;
  private moveDrainQueued = false;

  constructor(private readonly write: (frame: string) => Promise<void>) {}

  /** Strict FIFO write (start_move / stop_move). */
  enqueue(frame: string): Promise<void> {
    this.chain = this.chain.then(() => this.safeWrite(frame));
    return this.chain;
  }

  /** Coalescing write for velocity frames: only the newest waits. */
  setLatestMove(frame: string): Promise<void> {
    this.pendingMove = frame;
    if (this.moveDrainQueued) return this.chain;
    this.moveDrainQueued = true;
    this.chain = this.chain.then(async () => {
      // Clear the flag BEFORE writing: a tick that arrives during this write
      // schedules exactly one more drain, which will carry the newest value.
      this.moveDrainQueued = false;
      const frame = this.pendingMove;
      this.pendingMove = null;
      if (frame != null) await this.safeWrite(frame);
    });
    return this.chain;
  }

  /** Drop the waiting velocity frame (before stop_move). */
  dropPendingMove(): void {
    this.pendingMove = null;
  }

  private async safeWrite(frame: string): Promise<void> {
    try {
      await this.write(frame);
    } catch {
      // Transport errors are handled by the injected writer (it marks the
      // device disconnected); never let one rejected write poison the chain.
    }
  }
}
