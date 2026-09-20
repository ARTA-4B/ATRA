/**
 * The runtime's cycle lock.
 *
 * The auto-trade pipeline and the liquidity pipeline run on independent
 * schedules, and each one reads balances and deployed capital at its own
 * decide() time. Without a lock between them two cycles can read the same
 * free capital and both spend it: 230 USD deployed against a 250 USD cap, a
 * trade and an LP add that each see 230 + 20 <= 250, and 270 USD deployed
 * when they are both done. In LIVE the second transaction may then revert for
 * insufficient balance after the gas and the cooldown have already gone.
 * Holding this lock for a whole cycle is what makes read-decide-dispatch one
 * indivisible step across both pipelines.
 *
 * A promise chain rather than a counter and a wait list: a caller waits on the
 * tail and becomes the new tail, so the queue is FIFO and there is nothing to
 * clean up. The release is in a `finally`, so a body that throws hands the
 * lock on instead of stranding everything queued behind it.
 *
 * Not reentrant: a holder that takes the lock again waits for itself forever.
 * The holders are the two pipeline entry points, which never nest.
 */
export class AsyncMutex {
  #tail: Promise<void> = Promise.resolve();

  /** Run `body` with the lock held. Its result — or its rejection — is the caller's. */
  async run<T>(body: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await body();
    } finally {
      release();
    }
  }
}
