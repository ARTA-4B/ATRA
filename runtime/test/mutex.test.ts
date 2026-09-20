import { describe, expect, it } from 'vitest';
import { AsyncMutex } from '../src/util/mutex.js';

/**
 * The lock the two pipelines share. What matters is that a holder's whole
 * body runs before the next one starts, and that a body which throws hands
 * the lock on instead of stranding the queue behind it.
 */

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('AsyncMutex', () => {
  it('runs one body at a time, in the order they asked', async () => {
    const lock = new AsyncMutex();
    const events: string[] = [];

    const body = (name: string) => async () => {
      events.push(`${name} in`);
      await tick();
      await tick();
      events.push(`${name} out`);
    };

    await Promise.all([lock.run(body('a')), lock.run(body('b')), lock.run(body('c'))]);

    expect(events).toEqual(['a in', 'a out', 'b in', 'b out', 'c in', 'c out']);
  });

  it('sees what the previous holder did', async () => {
    const lock = new AsyncMutex();
    let deployed = 0;
    const seen: number[] = [];

    const first = lock.run(async () => {
      await tick();
      deployed += 20;
    });
    const second = lock.run(() => {
      seen.push(deployed);
      return Promise.resolve();
    });

    await Promise.all([first, second]);
    expect(seen).toEqual([20]);
  });

  it('releases the lock when the body throws, and the throw reaches the caller', async () => {
    const lock = new AsyncMutex();
    const events: string[] = [];

    const failing = lock.run(async () => {
      await tick();
      events.push('threw');
      throw new Error('boom');
    });
    const after = lock.run(() => {
      events.push('ran anyway');
      return Promise.resolve('done');
    });

    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBe('done');
    expect(events).toEqual(['threw', 'ran anyway']);
  });

  it('releases the lock when the body throws synchronously', async () => {
    const lock = new AsyncMutex();
    await expect(
      lock.run(() => {
        throw new Error('no await at all');
      }),
    ).rejects.toThrow('no await at all');
    await expect(lock.run(() => Promise.resolve('free'))).resolves.toBe('free');
  });
});
