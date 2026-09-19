/**
 * Workers rate limiting bindings, guarded.
 *
 * The bindings exist only in the staging and production environments (ids
 * 2101-2103 and 2001-2003); local dev and the test suite have none, and a
 * binding that throws must not take the gateway down. Absent or broken means
 * "allow": the limiter is a burst guard, not an accounting system, and the
 * Telegram-side costs of a missed limit are one extra message.
 */
import { errorSummary, logger } from './log.js';

const log = logger('ratelimit');

export async function allow(binding: RateLimit | undefined, key: string): Promise<boolean> {
  if (binding === undefined || typeof binding.limit !== 'function') return true;
  try {
    const { success } = await binding.limit({ key });
    return success;
  } catch (error) {
    log.warn('rate limit binding failed; allowing', { error: errorSummary(error) });
    return true;
  }
}
