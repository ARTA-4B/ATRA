import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../context.js';
import { envelope } from '../respond.js';
import { parse } from './auth.js';
import { AppError, ErrorCode } from '../../util/errors.js';
import { REAUTH_HEADER, requireSession } from '../middleware.js';

/**
 * Runtime control: pause, emergency stop, risk policy and LIVE activation.
 *
 * The emergency stop is the one control that must keep working when everything
 * else is broken. It writes a single row and takes effect on the next read, so
 * it does not depend on a model, a scheduler or a network call. Engaging it
 * also drops the runtime back to PAPER, so recovering means walking the LIVE
 * checklist again rather than clicking resume.
 */

const pauseSchema = z.object({ reason: z.string().max(200).optional() });
const emergencySchema = z.object({ reason: z.string().min(1).max(200) });
const stepSchema = z.object({
  step: z.enum([
    'acknowledged',
    'reauthenticated',
    'riskReviewed',
    'walletFunded',
    'gasChecked',
    'adapterChecked',
  ]),
});

export function controlRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', requireSession());

  app.post('/pause', async (c) => {
    const services = c.get('services');
    const body = await parse(c, pauseSchema);
    services.state.setGlobalPause(true, body.reason ?? 'paused by the operator', 'operator');
    return c.json(envelope(c, services.state.getSwitches()));
  });

  app.post('/resume', (c) => {
    const services = c.get('services');
    const switches = services.state.getSwitches();

    // Resume must not quietly clear an emergency stop: they are different
    // controls with different intent, and conflating them would let a routine
    // "resume" undo a deliberate halt.
    if (switches.emergencyStop) {
      throw new AppError(
        ErrorCode.CONFLICT,
        'The emergency stop is engaged; clear it explicitly before resuming',
      );
    }

    services.state.setGlobalPause(false, null, 'operator');
    return c.json(envelope(c, services.state.getSwitches()));
  });

  /** Engage the emergency stop. No re-authentication: stopping is always safe. */
  app.post('/emergency-stop', async (c) => {
    const services = c.get('services');
    const body = await parse(c, emergencySchema);

    services.state.setEmergencyStop(true, body.reason, 'operator');

    return c.json(
      envelope(c, {
        ...services.state.getSwitches(),
        mode: services.state.getMode(),
        note: 'LIVE mode has been revoked; re-run the activation checklist to resume live trading.',
      }),
    );
  });

  /** Clearing it does require re-authentication: that direction adds risk. */
  app.post('/emergency-stop/clear', (c) => {
    const services = c.get('services');
    const session = c.get('session')!;

    // Its own purpose, so the audit trail says what the token was spent on and
    // a token obtained to clear the stop cannot also switch the runtime live.
    services.auth.consumeReauthToken(c.req.header(REAUTH_HEADER), 'emergency.clear', session.id);
    services.state.setEmergencyStop(false, null, 'operator');

    return c.json(envelope(c, services.state.getSwitches()));
  });

  app.get('/activation', (c) => {
    const services = c.get('services');
    return c.json(
      envelope(c, { mode: services.state.getMode(), activation: services.state.getActivation() }),
    );
  });

  app.post('/activation/step', async (c) => {
    const services = c.get('services');
    const body = await parse(c, stepSchema);
    const progress = services.state.recordActivationStep(body.step, 'operator');
    return c.json(envelope(c, progress));
  });

  /**
   * Switch to LIVE.
   *
   * Requires a re-authentication token and a complete checklist. There is no
   * other code path that sets the mode to LIVE.
   */
  app.post('/mode/live', (c) => {
    const services = c.get('services');
    const session = c.get('session')!;

    services.auth.consumeReauthToken(c.req.header(REAUTH_HEADER), 'mode.live', session.id);
    const installation = services.state.activateLive('operator');

    return c.json(
      envelope(c, { mode: installation.mode, activation: services.state.getActivation() }),
    );
  });

  /** Returning to PAPER is always allowed and never gated. */
  app.post('/mode/paper', (c) => {
    const services = c.get('services');
    const installation = services.state.revertToPaper('operator', 'requested by the operator');
    return c.json(envelope(c, { mode: installation.mode }));
  });

  return app;
}

export function riskRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', requireSession());

  app.get('/', (c) => {
    const services = c.get('services');

    if (!services.riskPolicy.exists()) {
      return c.json(
        envelope(c, null, { source: 'none', reason: 'no risk policy has been configured yet' }),
      );
    }

    const { policy, hash } = services.riskPolicy.getWithHash();
    return c.json(
      envelope(c, { policy, hash, version: services.riskPolicy.version() }, { source: 'local' }),
    );
  });

  /**
   * Replace the policy.
   *
   * The whole document is validated before anything is written, so a rejected
   * update leaves the previous limits in force rather than a half-applied mix.
   */
  app.put('/', async (c) => {
    const services = c.get('services');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Request body must be JSON');
    }

    const policy = services.riskPolicy.update(body, 'operator');
    return c.json(
      envelope(c, { policy, version: services.riskPolicy.version() }, { source: 'local' }),
    );
  });

  return app;
}

export function activityRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', requireSession());

  app.get('/', (c) => {
    const services = c.get('services');
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 500);
    const before = c.req.query('before');

    const query: Parameters<typeof services.audit.list>[0] = { limit };
    const category = c.req.query('category');
    const chain = c.req.query('chain');
    const status = c.req.query('status');
    if (category) query.category = category as never;
    if (chain) query.chain = chain as never;
    if (status) query.status = status as never;
    if (before) query.before = Number(before);

    const events = services.audit.list(query);
    const nextCursor = events.length === limit ? (events.at(-1)?.id ?? null) : null;

    return c.json(envelope(c, events, { source: 'local', nextCursor }));
  });

  app.get('/:eventId', (c) => {
    const services = c.get('services');
    const event = services.audit.get(c.req.param('eventId'));

    if (!event) {
      throw new AppError(ErrorCode.NOT_FOUND, 'No such audit event');
    }

    return c.json(envelope(c, event, { source: 'local' }));
  });

  return app;
}
