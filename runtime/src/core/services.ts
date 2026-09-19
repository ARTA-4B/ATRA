import type { Db } from '../db/database.js';
import { closeDatabase, openDatabase } from '../db/database.js';
import { AuditLog } from '../audit/audit.js';
import { AuthService } from './auth.js';
import { StateStore } from './state.js';
import { Vault } from '../wallet/vault.js';
import { WalletService } from '../wallet/service.js';
import { RiskPolicyStore } from '../risk/store.js';
import { EvmChainAdapter } from '../chains/evm/adapter.js';
import { SolanaChainAdapter } from '../chains/solana/adapter.js';
import { CHAIN_IDS, CHAINS } from '../chains/registry.js';
import type { ChainId } from '../chains/registry.js';
import type { ChainAdapter } from '../chains/types.js';
import type { RuntimeConfig } from '../config/env.js';
import { childLogger } from '../logging/logger.js';
import { join } from 'node:path';
import type { KdfParams } from '../wallet/crypto.js';

/**
 * The composition root.
 *
 * Everything the runtime needs is constructed here, once, and passed down
 * explicitly. No module reaches for a global: that is what lets a test spin up
 * a complete runtime against an in-memory database with mock adapters, and it
 * keeps the dependency direction visible in one file.
 */
export interface Services {
  config: RuntimeConfig;
  db: Db;
  audit: AuditLog;
  auth: AuthService;
  state: StateStore;
  vault: Vault;
  wallets: WalletService;
  riskPolicy: RiskPolicyStore;
  adapters: Map<ChainId, ChainAdapter>;
  startedAt: Date;
}

export interface BuildOptions {
  /** Override the database location; tests pass ':memory:'. */
  databaseFile?: string;
  /** Skip building network adapters. Set automatically in ATRA_MODE=ci. */
  withAdapters?: boolean;
  /** Inject adapters directly, for tests. */
  adapters?: Map<ChainId, ChainAdapter>;
  /**
   * Weaker key-derivation parameters, so a test suite is not dominated by
   * Argon2. Only ever set from test code; the production entry point leaves it
   * undefined and the audited defaults apply.
   */
  kdfParams?: KdfParams;
}

export function buildServices(config: RuntimeConfig, options: BuildOptions = {}): Services {
  const log = childLogger('services');
  const databaseFile = options.databaseFile ?? join(config.dataDir, 'atra.db');

  const db = openDatabase({ file: databaseFile });
  const audit = new AuditLog(db);
  const auth = new AuthService(db, audit, options.kdfParams);
  const state = new StateStore(db, audit);
  const vault = new Vault(db, { autolockMs: config.autolockMs, kdfParams: options.kdfParams });
  const riskPolicy = new RiskPolicyStore(db, audit);

  const adapters =
    options.adapters ??
    ((options.withAdapters ?? !config.isCi)
      ? buildAdapters(config)
      : new Map<ChainId, ChainAdapter>());

  const wallets = new WalletService(db, vault, audit, adapters);

  log.info(
    {
      databaseFile: databaseFile === ':memory:' ? ':memory:' : databaseFile,
      adapters: [...adapters.keys()],
      mode: config.mode,
    },
    'services constructed',
  );

  return {
    config,
    db,
    audit,
    auth,
    state,
    vault,
    wallets,
    riskPolicy,
    adapters,
    startedAt: new Date(),
  };
}

/**
 * Build one adapter per supported chain.
 *
 * Construction never performs I/O, so a chain whose endpoint is down still has
 * an adapter and reports its failure through `health()` rather than vanishing
 * from the dashboard.
 */
export function buildAdapters(config: RuntimeConfig): Map<ChainId, ChainAdapter> {
  const adapters = new Map<ChainId, ChainAdapter>();

  for (const chain of CHAIN_IDS) {
    const override = config.rpcOverrides[chain];
    if (CHAINS[chain].family === 'evm') {
      adapters.set(chain, new EvmChainAdapter(chain, { rpcUrl: override }));
    } else {
      adapters.set(chain, new SolanaChainAdapter({ rpcUrl: override }));
    }
  }

  return adapters;
}

/** Release everything. Safe to call more than once. */
export function shutdownServices(services: Services): void {
  services.vault.lock();
  closeDatabase(services.db);
}
