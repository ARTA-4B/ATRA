import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../context.js';
import { envelope } from '../respond.js';
import { parse } from './auth.js';
import { localOnly, requireSession } from '../middleware.js';
import { AppError, ErrorCode } from '../../util/errors.js';
import { CHAIN_IDS } from '../../chains/registry.js';
import type { TreasuryService } from '../../treasury/service.js';
import { TREASURY_ADMIN_ACTOR } from '../../treasury/service.js';
import { MAX_ADMIN_SECRET_LENGTH } from '../../treasury/admin.js';
import {
  BILLING_MODES,
  EXPENSE_KINDS,
  EXPENSE_SOURCES,
  EXPENSE_STATUSES,
  PROPOSAL_STATUSES,
  PROVIDER_CATEGORIES,
  periodString,
  treasuryTokenSchema,
  usdString,
} from '../../treasury/types.js';

/**
 * Treasury routes (Phase 5): the project-admin dashboard.
 *
 * This is not an operator surface. Every route below the two admin
 * endpoints requires a dashboard session *and* the project-admin token that
 * `POST /admin/login` issues against a separate credential, checked by
 * {@link requireTreasuryAdmin}. The token is bound to the session and
 * expires on its own; a session cookie alone reaches nothing here.
 *
 * What these routes can do: read the watch-only treasury balances, keep the
 * provider list and expense ledger, create and approve payment *proposals*,
 * export an approved proposal as a transfer instruction, freeze the
 * treasury, and run one Treasury Agent review.
 *
 * What they cannot do: sign, broadcast, or touch a user wallet. The service
 * they call was built without a wallet, a vault or a ledger in its
 * dependencies, so there is no route that could be added here to change
 * that without changing the composition root.
 *
 * Every route writes an audit row, reads included, with category `system`
 * and actor `treasury-admin`.
 */

export const TREASURY_ADMIN_HEADER = 'x-atra-treasury-admin';

const adminSecretSchema = z.object({
  adminSecret: z.string().min(1).max(MAX_ADMIN_SECRET_LENGTH),
});

const capsSchema = z
  .object({
    lowBalanceThresholdUsd: usdString.optional(),
    perPaymentCapUsd: usdString.optional(),
    monthlyCapUsd: usdString.optional(),
    approvalThresholdUsd: usdString.optional(),
  })
  .strict();

const addressSchema = z
  .object({
    chain: z.enum(CHAIN_IDS),
    address: z.string().min(1).max(64),
    label: z.string().min(1).max(64),
    tokens: z.array(treasuryTokenSchema).max(16).default([]),
    enabled: z.boolean().default(true),
  })
  .strict();

const configSchema = z
  .object({
    caps: capsSchema.optional(),
    addresses: z.array(addressSchema).max(4).optional(),
  })
  .strict();

const recipientSchema = z
  .object({ chain: z.enum(CHAIN_IDS), address: z.string().min(1).max(64) })
  .strict();

const providerSchema = z
  .object({
    name: z.string().min(1).max(64),
    category: z.enum(PROVIDER_CATEGORIES),
    billingMode: z.enum(BILLING_MODES),
    monthlyBudgetUsd: usdString.default('0'),
    recipient: recipientSchema.nullable().default(null),
    note: z.string().max(500).default(''),
  })
  .strict();

const providerUpdateSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    category: z.enum(PROVIDER_CATEGORIES).optional(),
    billingMode: z.enum(BILLING_MODES).optional(),
    monthlyBudgetUsd: usdString.optional(),
    recipient: recipientSchema.nullable().optional(),
    note: z.string().max(500).optional(),
    active: z.boolean().optional(),
  })
  .strict();

const expenseSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    period: periodString,
    amountUsd: usdString,
    kind: z.enum(EXPENSE_KINDS).default('recurring'),
    status: z.enum(EXPENSE_STATUSES).default('paid'),
    source: z.enum(EXPENSE_SOURCES).default('manual'),
    note: z.string().max(500).default(''),
  })
  .strict();

const proposalSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    amountUsd: usdString,
    asset: z.string().min(1).max(16),
    period: periodString.optional(),
    memo: z.string().max(500).optional(),
  })
  .strict();

const approveSchema = z
  .object({
    creatorApproval: z.boolean().default(false),
    note: z.string().max(500).default(''),
  })
  .strict();

const noteSchema = z.object({ note: z.string().min(1).max(500) }).strict();
const reasonSchema = z.object({ reason: z.string().min(1).max(500) }).strict();

/**
 * The project-admin gate.
 *
 * Runs after {@link requireSession}: the token is looked up against the
 * session it was issued to, so it must know which session is calling. The
 * service throttles repeated invalid tokens per session.
 */
export function requireTreasuryAdmin(treasury: TreasuryService): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = c.get('session');
    if (!session) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Sign in to continue');
    }
    treasury.admin.resolve(c.req.header(TREASURY_ADMIN_HEADER), session.id);
    await next();
  };
}

export function treasuryRoutes(treasury: TreasuryService): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const actor = TREASURY_ADMIN_ACTOR;

  // --- the gate itself ----------------------------------------------------

  /**
   * Whether the admin credential exists and whether this session currently
   * holds a valid token. Session only: the dashboard needs it to decide
   * between the setup form and the login form, and it reveals nothing else.
   */
  app.get('/admin/status', requireSession(), (c) => {
    const session = c.get('session')!;
    return c.json(
      envelope(c, {
        configured: treasury.admin.isConfigured,
        authenticated: treasury.admin.hasValidToken(
          c.req.header(TREASURY_ADMIN_HEADER),
          session.id,
        ),
        frozen: treasury.isFrozen(),
        header: TREASURY_ADMIN_HEADER,
      }),
    );
  });

  /**
   * Set the admin credential, once. Loopback only, session required, 409
   * afterwards. There is no route to change or reset it: that is done by
   * whoever holds the database, deliberately.
   */
  app.post('/admin/setup', localOnly(), requireSession(), async (c) => {
    const body = await parse(c, adminSecretSchema);
    await treasury.admin.setSecret(body.adminSecret, actor);
    return c.json(envelope(c, { configured: true, header: TREASURY_ADMIN_HEADER }), 201);
  });

  /** Exchange the admin secret for a short-lived token bound to this session. */
  app.post('/admin/login', requireSession(), async (c) => {
    const session = c.get('session')!;
    const body = await parse(c, adminSecretSchema);
    const issued = await treasury.admin.login(session.id, body.adminSecret, actor);
    return c.json(
      envelope(c, {
        token: issued.token,
        expiresAt: issued.expiresAt,
        header: TREASURY_ADMIN_HEADER,
      }),
    );
  });

  app.post('/admin/logout', requireSession(), (c) => {
    const session = c.get('session')!;
    const revoked = treasury.admin.revokeSession(session.id, actor);
    return c.json(envelope(c, { revoked }));
  });

  // --- everything else needs the token ---------------------------------------

  app.use('*', requireSession(), requireTreasuryAdmin(treasury));

  /** The dashboard: balances read live, burn, runway, providers, proposals, alerts. */
  app.get('/', async (c) => {
    const view = await treasury.view();
    treasury.noteRead('dashboard', actor);
    return c.json(
      envelope(c, view, {
        source: view.balances.assets.length > 0 ? 'rpc' : 'local',
        asOf: view.balances.takenAt,
        ...(view.balances.complete
          ? {}
          : { reason: 'one or more treasury balances could not be read or priced' }),
      }),
    );
  });

  app.get('/config', (c) => {
    treasury.noteRead('config', actor);
    return c.json(envelope(c, treasury.getConfig()));
  });

  app.put('/config', async (c) => {
    const body = await parse(c, configSchema);
    const config = treasury.updateConfig(body, actor);
    return c.json(envelope(c, config));
  });

  app.get('/providers', (c) => {
    treasury.noteRead('providers', actor);
    return c.json(envelope(c, treasury.listProviders()));
  });

  app.post('/providers', async (c) => {
    const body = await parse(c, providerSchema);
    return c.json(envelope(c, treasury.addProvider(body, actor)), 201);
  });

  app.put('/providers/:id', async (c) => {
    const body = await parse(c, providerUpdateSchema);
    return c.json(envelope(c, treasury.updateProvider(c.req.param('id'), body, actor)));
  });

  app.get('/expenses', (c) => {
    treasury.noteRead('expenses', actor);
    const period = c.req.query('period');
    const providerId = c.req.query('providerId');
    if (period !== undefined && !periodString.safeParse(period).success) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'period must be YYYY-MM', {
        errors: [{ path: 'period', message: 'must be YYYY-MM' }],
      });
    }
    return c.json(
      envelope(
        c,
        treasury.listExpenses({
          ...(period ? { period } : {}),
          ...(providerId ? { providerId } : {}),
          limit: limitParam(c, 200),
        }),
      ),
    );
  });

  /**
   * Record an expense. A `manual-payable` is what a card, invoice or manual
   * provider's bill becomes; there is no route that turns it into a payment.
   */
  app.post('/expenses', async (c) => {
    const body = await parse(c, expenseSchema);
    return c.json(envelope(c, treasury.recordExpense(body, actor)), 201);
  });

  app.get('/proposals', (c) => {
    treasury.noteRead('proposals', actor);
    const status = c.req.query('status');
    if (status !== undefined && !(PROPOSAL_STATUSES as readonly string[]).includes(status)) {
      throw new AppError(
        ErrorCode.SCHEMA_INVALID,
        `status must be one of ${PROPOSAL_STATUSES.join(', ')}`,
        {
          errors: [{ path: 'status', message: 'unknown status' }],
        },
      );
    }
    return c.json(
      envelope(
        c,
        treasury.listProposals({
          ...(status ? { status: status as (typeof PROPOSAL_STATUSES)[number] } : {}),
          limit: limitParam(c, 100),
        }),
      ),
    );
  });

  /** Create a proposal. 409 with the failing checks when it does not pass the caps. */
  app.post('/proposals', async (c) => {
    const body = await parse(c, proposalSchema);
    return c.json(envelope(c, treasury.propose(body, actor, 'admin')), 201);
  });

  app.post('/proposals/:id/approve', async (c) => {
    const body = await parse(c, approveSchema);
    return c.json(envelope(c, treasury.approve(c.req.param('id'), body, actor)));
  });

  app.post('/proposals/:id/reject', async (c) => {
    const body = await parse(c, noteSchema);
    return c.json(envelope(c, treasury.reject(c.req.param('id'), body.note, actor)));
  });

  app.post('/proposals/:id/cancel', async (c) => {
    const body = await parse(c, noteSchema);
    return c.json(envelope(c, treasury.cancel(c.req.param('id'), body.note, actor)));
  });

  /**
   * Export an approved proposal. The response is a transfer instruction for a
   * human to execute from the treasury wallet; it is never a signed
   * transaction, because the runtime has nothing to sign it with.
   */
  app.post('/proposals/:id/export', async (c) => {
    const instruction = await treasury.exportProposal(c.req.param('id'), actor);
    return c.json(envelope(c, instruction, { source: 'local' }));
  });

  /** Freeze: one row, effective immediately, no model, no network. */
  app.post('/freeze', async (c) => {
    const body = await parse(c, reasonSchema);
    return c.json(envelope(c, treasury.freeze(body.reason, actor)));
  });

  app.post('/freeze/clear', async (c) => {
    const body = await parse(c, noteSchema);
    return c.json(envelope(c, treasury.clearFreeze(body.note, actor)));
  });

  /** One Treasury Agent review cycle. 409 while one is running. */
  app.post('/run', async (c) => {
    const report = await treasury.run(actor);
    return c.json(envelope(c, report), 202);
  });

  app.get('/alerts', (c) => {
    treasury.noteRead('alerts', actor);
    return c.json(
      envelope(
        c,
        treasury.listAlerts({
          includeAcknowledged: c.req.query('all') === 'true',
          limit: limitParam(c, 100),
        }),
      ),
    );
  });

  app.post('/alerts/:id/ack', (c) =>
    c.json(envelope(c, treasury.acknowledgeAlert(c.req.param('id'), actor))),
  );

  return app;
}

function limitParam(c: Context<AppEnv>, fallback: number): number {
  const raw = Number(c.req.query('limit') ?? fallback);
  return Math.min(Math.max(Number.isFinite(raw) ? Math.trunc(raw) : fallback, 1), 1_000);
}
