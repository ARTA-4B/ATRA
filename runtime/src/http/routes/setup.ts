import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppEnv } from '../context.js';
import { envelope } from '../respond.js';
import { parse } from './auth.js';
import { AppError, ErrorCode } from '../../util/errors.js';
import { localOnly, requireSession } from '../middleware.js';
import { CHAIN_IDS } from '../../chains/registry.js';

/**
 * First-run setup.
 *
 * The wizard is deliberately linear and its steps are recorded in the database
 * rather than held in the browser, so closing the tab halfway through does not
 * lose an already-generated wallet.
 *
 * Two things this endpoint will not do: start in LIVE mode, and display a
 * private key. The mode is hard-coded to PAPER at creation, and secret material
 * is only ever reachable through the separately re-authenticated export route.
 */

const completeSchema = z.object({
  name: z.string().min(1).max(64).default('ATRA'),
  chains: z.array(z.enum(CHAIN_IDS)).min(1),
  risk: z
    .object({
      maxAmountPerTradeUsd: z
        .string()
        .regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/)
        .optional(),
      maxDailyLossUsd: z
        .string()
        .regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/)
        .optional(),
      maxTotalDeployedUsd: z
        .string()
        .regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/)
        .optional(),
    })
    .optional(),
  /** The operator must explicitly acknowledge that they start in PAPER mode. */
  paperAcknowledged: z.literal(true),
});

export function setupRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * Setup progress.
   *
   * Requires a session once a password exists: wallet addresses and the
   * installation's state are not for anonymous callers. Before setup there is
   * nothing to protect and no session to require.
   */
  app.get('/', async (c, next) => {
    const services = c.get('services');
    if (services.auth.isConfigured) {
      await requireSession()(c, next);
      if (c.get('session') === undefined) return;
    }
    const installation = services.state.getInstallation();
    const wallets = services.auth.isConfigured ? services.wallets.list() : [];

    return c.json(
      envelope(c, {
        completed: installation?.setupCompleted ?? false,
        steps: {
          passwordSet: services.auth.isConfigured,
          vaultCreated: services.vault.isInitialized,
          walletsCreated: wallets.length === 2,
          chainsSelected: (installation?.enabledChains.length ?? 0) > 0,
          riskConfigured: services.riskPolicy.exists(),
        },
        installation: installation
          ? {
              id: installation.id,
              name: installation.name,
              mode: installation.mode,
              enabledChains: installation.enabledChains,
              createdAt: installation.createdAt,
            }
          : null,
        wallets: wallets.map((wallet) => ({
          family: wallet.family,
          address: wallet.address,
          chains: wallet.chains,
        })),
      }),
    );
  });

  /**
   * Generate the agent wallets.
   *
   * Returns public addresses only. Idempotent, so a double-clicked button
   * cannot create a second pair of keys and strand funds at a forgotten
   * address.
   */
  app.post('/wallets', localOnly(), requireSession(), (c) => {
    const services = c.get('services');

    if (!services.vault.isUnlocked) {
      throw new AppError(ErrorCode.VAULT_LOCKED, 'Sign in again to unlock the vault');
    }

    const wallets = services.wallets.createAgentWallets();
    return c.json(
      envelope(
        c,
        wallets.map((wallet) => ({
          family: wallet.family,
          address: wallet.address,
          chains: wallet.chains,
          createdAt: wallet.createdAt,
        })),
      ),
      201,
    );
  });

  /** Record chain selection and seed the risk policy. */
  app.post('/complete', requireSession(), async (c) => {
    const services = c.get('services');
    const body = await parse(c, completeSchema);

    if (services.wallets.list().length < 2) {
      throw new AppError(ErrorCode.CONFLICT, 'Create the agent wallets before completing setup');
    }

    const installation =
      services.state.getInstallation() ??
      services.state.createInstallation(randomUUID(), body.name, body.chains);

    services.state.setEnabledChains(body.chains);

    const policy = services.riskPolicy.exists()
      ? services.riskPolicy.get()
      : services.riskPolicy.initialize(body.chains);

    if (body.risk) {
      services.riskPolicy.update(
        {
          ...policy,
          enabledChains: body.chains,
          ...(body.risk.maxAmountPerTradeUsd
            ? { maxAmountPerTradeUsd: body.risk.maxAmountPerTradeUsd }
            : {}),
          ...(body.risk.maxDailyLossUsd ? { maxDailyLossUsd: body.risk.maxDailyLossUsd } : {}),
          ...(body.risk.maxTotalDeployedUsd
            ? { maxTotalDeployedUsd: body.risk.maxTotalDeployedUsd }
            : {}),
          tokenAllowlist: Object.fromEntries(
            Object.entries(policy.tokenAllowlist).filter(([chain]) =>
              body.chains.includes(chain as (typeof body.chains)[number]),
            ),
          ),
          protocolAllowlist: Object.fromEntries(
            Object.entries(policy.protocolAllowlist).filter(([chain]) =>
              body.chains.includes(chain as (typeof body.chains)[number]),
            ),
          ),
        },
        'operator',
      );
    }

    services.state.completeSetup();

    return c.json(
      envelope(c, {
        completed: true,
        mode: services.state.getMode(),
        installationId: installation.id,
        enabledChains: body.chains,
        riskPolicyVersion: services.riskPolicy.version(),
      }),
    );
  });

  return app;
}
