import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../context.js';
import { envelope } from '../respond.js';
import { parse } from './auth.js';
import { requireSession } from '../middleware.js';
import { AppError, ErrorCode } from '../../util/errors.js';
import type { TelegramService } from '../../telegram/service.js';
import type { NotificationToggles } from '../../telegram/types.js';
import { normalizePairCode } from '../../telegram/protocol.js';

/**
 * Telegram routes: the dashboard side of pairing and notification settings.
 *
 * The service instance is passed in rather than read off the context because
 * the composition root wires it after the rest of `Services` exists; the
 * route factory therefore has no opinion about where it lives.
 *
 * Nothing here sends a message or runs a command. Telegram talks to the
 * runtime through the transport, never through this HTTP surface.
 */

const notificationsSchema = z
  .object({
    riskRejections: z.boolean().optional(),
    tradeDecisions: z.boolean().optional(),
    liquidityUpdates: z.boolean().optional(),
    runtimeAlerts: z.boolean().optional(),
  })
  .strict();

export function telegramRoutes(telegram: TelegramService): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', requireSession());

  app.get('/', (c) => c.json(envelope(c, telegram.view(), { source: 'local' })));

  /** Issue a pairing code. 409 TELEGRAM_NOT_CONFIGURED without a transport. */
  app.post('/pair', (c) => c.json(envelope(c, telegram.issuePairCode(), { source: 'local' }), 201));

  /** Poll one code. Unknown codes read as expired; there is nothing to learn from them. */
  app.get('/pair/:code', (c) => {
    const raw = c.req.param('code');
    if (normalizePairCode(raw) === null) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Pairing codes look like ABCD-2345', {
        errors: [{ path: 'code', message: 'must match ^[A-Z2-9]{4}-[A-Z2-9]{4}$' }],
      });
    }
    return c.json(envelope(c, { status: telegram.pairStatus(raw) }, { source: 'local' }));
  });

  app.post('/unpair', (c) => c.json(envelope(c, telegram.unpair('operator'), { source: 'local' })));

  // PUT per the runtime task, PATCH per the dashboard contract: both take a
  // partial object and return the full view.
  const update = async (c: Context<AppEnv>) => {
    const body = await parse(c, notificationsSchema);
    const toggles: Partial<NotificationToggles> = {};
    if (body.riskRejections !== undefined) toggles.riskRejections = body.riskRejections;
    if (body.tradeDecisions !== undefined) toggles.tradeDecisions = body.tradeDecisions;
    if (body.liquidityUpdates !== undefined) toggles.liquidityUpdates = body.liquidityUpdates;
    if (body.runtimeAlerts !== undefined) toggles.runtimeAlerts = body.runtimeAlerts;
    return c.json(envelope(c, telegram.setNotifications(toggles, 'operator'), { source: 'local' }));
  };
  app.put('/notifications', update);
  app.patch('/notifications', update);

  return app;
}
