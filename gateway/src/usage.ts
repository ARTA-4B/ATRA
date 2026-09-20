/**
 * Usage metering through Workers Analytics Engine.
 *
 * One data point per proxied request: which installation, which route,
 * which chain, how it ended and whether the cache answered it. Nothing else:
 * no request bodies, no addresses, no tokens, no IPs. The binding is optional
 * and the write is fire-and-forget; a missing or failing binding costs a log
 * line at most. Per-install counts that must be exact live in the Hub's
 * SQLite (quotas); this is for dashboards and cost questions.
 */
import type { Env } from './env.js';
import { errorSummary, logger } from './log.js';

const log = logger('usage');

export type UsageRoute = 'rpc' | 'market' | 'inference' | 'ws';

export type UsageOutcome =
  | 'ok'
  | 'invalid'
  | 'refused'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'upstream_error'
  | 'not_configured';

export interface UsagePoint {
  installId: string;
  route: UsageRoute;
  chain: string;
  outcome: UsageOutcome;
  cached: boolean;
}

export function recordUsage(env: Env, point: UsagePoint): void {
  const ae = env.AE;
  if (ae === undefined || typeof ae.writeDataPoint !== 'function') return;
  try {
    ae.writeDataPoint({
      indexes: [point.installId],
      blobs: [
        point.route,
        point.chain,
        point.outcome,
        point.cached ? 'hit' : 'miss',
        env.GATEWAY_ENV ?? 'dev',
      ],
      doubles: [1],
    });
  } catch (error) {
    log.warn('analytics write failed', { error: errorSummary(error) });
  }
}
