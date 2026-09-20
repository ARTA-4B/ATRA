import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../context.js';
import { envelope } from '../respond.js';
import { limitParam } from '../query.js';
import { parse } from './auth.js';
import { AppError, ErrorCode } from '../../util/errors.js';
import { REAUTH_HEADER, localOnly, requireSession } from '../middleware.js';
import { CHAIN_IDS, CHAINS } from '../../chains/registry.js';
import type { ChainId } from '../../chains/registry.js';
import { WITHDRAW_ASSETS } from '../../wallet/withdrawal.js';

/**
 * Wallet routes.
 *
 * Reads are available to any signed-in operator. The export route additionally
 * requires a single-use re-authentication token and a loopback caller, and it
 * is the only path in the entire runtime that returns key material.
 */

const exportSchema = z.object({
  format: z.enum(['evm-private-key', 'evm-keystore', 'solana-id-json', 'solana-base58']),
  /** Encrypts the keystore file. Separate from the dashboard password. */
  keystorePassword: z.string().min(12).max(512).optional(),
  /** The operator must type this exactly, so an export is never a stray click. */
  confirmation: z.literal('EXPORT'),
});

const withdrawQuoteSchema = z.object({
  chainId: z.enum(CHAIN_IDS),
  asset: z.enum(WITHDRAW_ASSETS),
  destination: z.string().min(1).max(64),
  amount: z.union([z.literal('all'), z.string().regex(/^\d+(\.\d+)?$/)]),
});

const withdrawSchema = z.object({
  quoteId: z.uuid(),
  ack: z.literal(true),
  confirmation: z.string().max(16).optional(),
});

export function walletRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', requireSession());

  app.get('/', (c) => {
    const services = c.get('services');
    const wallets = services.wallets.list();

    return c.json(
      envelope(c, {
        wallets: wallets.map((wallet) => ({
          family: wallet.family,
          address: wallet.address,
          chains: wallet.chains,
          createdAt: wallet.createdAt,
        })),
        vaultUnlocked: services.vault.isUnlocked,
      }),
    );
  });

  /** Deposit addresses, one per enabled chain. */
  app.get('/deposit-address', (c) => {
    const services = c.get('services');
    const installation = services.state.getInstallation();
    const chains = installation?.enabledChains ?? [];

    const addresses = chains.map((chain) => ({
      chain,
      address: services.wallets.depositAddress(chain),
      nativeSymbol: CHAINS[chain].nativeSymbol,
      explorerUrl: `${CHAINS[chain].explorerUrl}/address/${services.wallets.depositAddress(chain)}`,
      /**
       * Deliberately explicit: the same EVM address exists on all three EVM
       * chains, and sending an asset on the wrong one is the most common way
       * an operator loses funds during onboarding.
       */
      warning: `Only send ${CHAINS[chain].displayName} assets to this address.`,
    }));

    return c.json(envelope(c, addresses));
  });

  /**
   * Balances for one chain or all enabled ones.
   *
   * A chain whose RPC is unreachable comes back with `error` set and `native`
   * null. It is never reported as a zero balance.
   */
  app.get('/balances', async (c) => {
    const services = c.get('services');
    const requested = c.req.query('chain');
    const installation = services.state.getInstallation();

    const chains: ChainId[] = requested
      ? [assertChain(requested)]
      : (installation?.enabledChains ?? []);

    const readings = await Promise.all(
      chains.map((chain) =>
        services.wallets.readBalances(chain).catch((error: unknown) => ({
          chain,
          address: '',
          native: null,
          tokens: [],
          observedAt: null,
          source: null,
          error: error instanceof Error ? error.message : 'balance read failed',
          gasLow: null,
        })),
      ),
    );

    const anyError = readings.some((reading) => reading.error !== null);
    const newest = readings
      .map((reading) => reading.observedAt)
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1);

    return c.json(
      envelope(c, readings, {
        source: readings.length > 0 && !anyError ? 'rpc' : 'none',
        asOf: newest ?? null,
        stale: anyError,
        ...(anyError ? { reason: 'one or more chains could not be read' } : {}),
      }),
    );
  });

  /** Operator-initiated transfers. Agent trades are under /trading. */
  app.get('/transactions', (c) => {
    const services = c.get('services');
    const limit = limitParam(c.req.query('limit'), 50, 200);
    return c.json(envelope(c, services.withdrawals.list(limit), { source: 'local' }));
  });

  /** Re-read one transfer's status from the chain. */
  app.get('/transactions/:txId', async (c) => {
    const services = c.get('services');
    const result = await services.withdrawals.refresh(c.req.param('txId'));
    if (!result) throw new AppError(ErrorCode.NOT_FOUND, 'No such transaction');
    return c.json(envelope(c, result, { source: 'rpc' }));
  });

  /**
   * Quote a withdrawal: validates the destination, reads the balance and the
   * fee, and says whether typed confirmation will be needed. Valid 90 s. A
   * quote whose fee could not be read is returned with `submittable: false`.
   */
  app.post('/withdraw/quote', async (c) => {
    const services = c.get('services');
    const body = await parse(c, withdrawQuoteSchema);
    const quote = await services.withdrawals.quote(body);
    return c.json(
      envelope(c, quote, {
        source: quote.fee.source === 'none' ? 'none' : 'rpc',
        ...(quote.fee.source === 'none' ? { reason: 'fee could not be estimated' } : {}),
      }),
    );
  });

  /**
   * Submit a quoted withdrawal. Requires a re-auth token bound to
   * `wallet.withdraw` and an unlocked vault; honours `Idempotency-Key`.
   * Allowed in PAPER mode: these are the operator's own funds.
   */
  app.post('/withdraw', async (c) => {
    const services = c.get('services');
    const session = c.get('session')!;
    const body = await parse(c, withdrawSchema);

    services.auth.consumeReauthToken(c.req.header(REAUTH_HEADER), 'wallet.withdraw', session.id);
    if (!services.vault.isUnlocked) {
      throw new AppError(ErrorCode.VAULT_LOCKED, 'Re-authenticate to unlock the vault');
    }

    const idempotencyKey = c.req.header('idempotency-key');
    const result = await services.withdrawals.execute(
      { quoteId: body.quoteId, ack: body.ack, confirmation: body.confirmation },
      idempotencyKey && idempotencyKey.length <= 128 ? idempotencyKey : undefined,
    );
    return c.json(envelope(c, result, { source: 'rpc' }), 202);
  });

  /**
   * Export secret material.
   *
   * Three gates: a valid session, a single-use re-authentication token bound to
   * this purpose, and a caller on the machine itself. The response carries an
   * explicit warning, and the audit row records that an export happened without
   * recording what was exported.
   */
  app.post('/export', localOnly(), async (c) => {
    const services = c.get('services');
    const session = c.get('session')!;
    const body = await parse(c, exportSchema);

    services.auth.consumeReauthToken(c.req.header(REAUTH_HEADER), 'wallet.export', session.id);

    if (!services.vault.isUnlocked) {
      throw new AppError(ErrorCode.VAULT_LOCKED, 'Re-authenticate to unlock the vault');
    }

    const result = services.wallets.exportWallet(body.format, body.keystorePassword);

    // Never cached, never logged, and the response is the only copy.
    c.header('cache-control', 'no-store, max-age=0');
    return c.json(
      envelope(c, {
        format: result.format,
        address: result.address,
        material: result.material,
        warning: result.warning,
      }),
    );
  });

  return app;
}

function assertChain(value: string): ChainId {
  if (!(CHAIN_IDS as readonly string[]).includes(value)) {
    throw new AppError(ErrorCode.CHAIN_UNSUPPORTED, `ATRA does not support the chain ${value}`, {
      details: { supported: CHAIN_IDS },
    });
  }
  return value as ChainId;
}
