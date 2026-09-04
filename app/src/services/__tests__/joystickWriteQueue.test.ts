import { describe, it, expect } from 'vitest';
import { JoystickWriteQueue } from '../joystickWriteQueue';

/** Transport stub with a controllable per-write delay and a log of what went out. */
function makeTransport(delayMs: number) {
  const written: string[] = [];
  const write = async (frame: string) => {
    await new Promise((r) => setTimeout(r, delayMs));
    written.push(frame);
  };
  return { written, write };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('JoystickWriteQueue', () => {
  it('snelle link: elke move gaat er in volgorde uit (geen gedragsverandering)', async () => {
    const t = makeTransport(1);
    const q = new JoystickWriteQueue(t.write);
    await q.enqueue('start');
    for (let i = 0; i < 5; i++) {
      await q.setLatestMove(`mst${i}`);
    }
    q.dropPendingMove();
    await q.enqueue('stop');
    expect(t.written).toEqual(['start', 'mst0', 'mst1', 'mst2', 'mst3', 'mst4', 'stop']);
  });

  it('trage link: een burst van moves wordt samengevouwen tot de nieuwste', async () => {
    const t = makeTransport(50);
    const q = new JoystickWriteQueue(t.write);
    void q.enqueue('start');
    // 10 ticks in 20 ms terwijl één write 50 ms duurt — de oude queue zou
    // hier 10 verouderde mst-frames opstapelen.
    for (let i = 0; i < 10; i++) {
      void q.setLatestMove(`mst${i}`);
      await tick(2);
    }
    await tick(200);
    // start, dan hooguit één "oud" frame dat al onderweg was, dan de nieuwste.
    expect(t.written[0]).toBe('start');
    expect(t.written[t.written.length - 1]).toBe('mst9');
    expect(t.written.length).toBeLessThanOrEqual(3);
  });

  it('stop volgt direct op de lopende write, verouderde moves vervallen', async () => {
    const t = makeTransport(50);
    const q = new JoystickWriteQueue(t.write);
    void q.enqueue('start');
    for (let i = 0; i < 10; i++) {
      void q.setLatestMove(`mst${i}`);
      await tick(2);
    }
    // Loslaten: geen enkele wachtende move mag nog de stop vertragen.
    q.dropPendingMove();
    const stopDone = q.enqueue('stop');
    await stopDone;
    const idxStop = t.written.indexOf('stop');
    expect(idxStop).toBeGreaterThan(0);
    // Na de stop komt niets meer.
    await tick(120);
    expect(t.written[t.written.length - 1]).toBe('stop');
    // En vóór de stop maximaal: start + wat al in-flight was + één drain.
    expect(idxStop).toBeLessThanOrEqual(3);
  });

  it('een falende write vergiftigt de keten niet', async () => {
    const written: string[] = [];
    let fail = true;
    const q = new JoystickWriteQueue(async (f) => {
      if (fail) { fail = false; throw new Error('disconnected'); }
      written.push(f);
    });
    await q.enqueue('start');          // faalt
    await q.setLatestMove('mst0');     // moet gewoon doorgaan
    await q.enqueue('stop');
    expect(written).toEqual(['mst0', 'stop']);
  });
});
