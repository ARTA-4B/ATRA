import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';
import type { AuditLog } from '../audit/audit.js';
import type { Vault } from './vault.js';
import { AppError, ErrorCode, errorMessage } from '../util/errors.js';
import { childLogger } from '../logging/logger.js';
import { CHAINS, chainFamily } from '../chains/registry.js';
import type { ChainId } from '../chains/registry.js';
import type { ChainAdapter } from '../chains/types.js';
import {
  evmAddressFromPrivateKey,
  exportEvmKeystoreV3,
  exportEvmPrivateKeyHex,
  generateEvmPrivateKey,
} from './evm.js';
import type { KeystoreV3 } from './evm.js';
import {
  exportSolanaBase58,
  exportSolanaIdJson,
  generateSolanaKeypair,
  isConsistentSecretKey,
  solanaAddressFromSecretKey,
} from './solana.js';
import { wipe } from './crypto.js';

/**
 * Wallet operations the dashboard and the agents use.
 *
 * ATRA creates its own agent wallets and never asks for an existing seed
 * phrase: the point of an agent wallet is that it holds only what the operator
 * deliberately moved into it, so a bug or a compromise cannot reach their main
 * funds.
 *
 * One EVM key covers Base, BNB Smart Chain and Robinhood Chain. Solana needs a
 * separate ed25519 keypair. Both live in the vault; this service never holds
 * plaintext beyond the scope of a single call.
 */

export type WalletFamily = 'evm' | 'solana';

interface WalletRow {
  id: string;
  family: WalletFamily;
  address: string;
  secret_id: string;
  created_at: string;
}

export interface WalletSummary {
  family: WalletFamily;
  address: string;
  createdAt: string;
  /** Chains this one key serves. */
  chains: ChainId[];
}

export interface BalanceReading {
  chain: ChainId;
  address: string;
  native: {
    symbol: string;
    decimals: number;
    amount: string;
  } | null;
  tokens: Array<{ address: string; symbol: string | null; decimals: number; amount: string }>;
  observedAt: string | null;
  source: string | null;
  /** Populated when the reading failed, so the UI shows "unavailable". */
  error: string | null;
  /** True when the native balance cannot cover a simple transfer fee. */
  gasLow: boolean | null;
}

export type ExportFormat = 'evm-private-key' | 'evm-keystore' | 'solana-id-json' | 'solana-base58';

export interface ExportResult {
  format: ExportFormat;
  address: string;
  /** The secret material. Returned once, never logged or persisted. */
  material: string | KeystoreV3;
  warning: string;
}

const EXPORT_WARNING =
  'Anyone holding this value controls the wallet and everything in it. ATRA cannot revoke it, ' +
  'reverse a transfer or recover funds sent by someone who copied it. Store it offline.';

export class WalletService {
  readonly #db: Db;
  readonly #vault: Vault;
  readonly #audit: AuditLog;
  readonly #adapters: Map<ChainId, ChainAdapter>;
  readonly #log = childLogger('wallet');

  constructor(
    db: Db,
    vault: Vault,
    audit: AuditLog,
    adapters: Map<ChainId, ChainAdapter> = new Map(),
  ) {
    this.#db = db;
    this.#vault = vault;
    this.#audit = audit;
    this.#adapters = adapters;
  }

  list(): WalletSummary[] {
    return this.#db
      .prepare<[], WalletRow>('SELECT * FROM wallets ORDER BY family')
      .all()
      .map((row) => ({
        family: row.family,
        address: row.address,
        createdAt: row.created_at,
        chains: chainsFor(row.family),
      }));
  }

  get(family: WalletFamily): WalletSummary | undefined {
    return this.list().find((wallet) => wallet.family === family);
  }

  /**
   * Create both agent wallets.
   *
   * Idempotent by design: calling it twice returns the existing wallets rather
   * than generating new keys, so a retried setup request cannot orphan funds
   * at an address ATRA has forgotten.
   */
  createAgentWallets(): WalletSummary[] {
    const existing = this.list();
    if (existing.length === 2) {
      this.#log.info('agent wallets already exist; returning them');
      return existing;
    }

    const created: WalletSummary[] = [];

    if (!this.get('evm')) {
      const privateKey = generateEvmPrivateKey();
      try {
        const address = evmAddressFromPrivateKey(privateKey);
        const secretId = this.#vault.putSecret('evm_private_key', 'agent-evm', privateKey);
        created.push(this.#insert('evm', address, secretId));
      } finally {
        wipe(privateKey);
      }
    }

    if (!this.get('solana')) {
      const keypair = generateSolanaKeypair();
      try {
        const secretId = this.#vault.putSecret('solana_keypair', 'agent-solana', keypair.secretKey);
        created.push(this.#insert('solana', keypair.address, secretId));
      } finally {
        wipe(keypair.secretKey);
      }
    }

    for (const wallet of created) {
      this.#audit.append({
        category: 'wallet',
        action: 'wallet.created',
        status: 'ok',
        summary: `Created ${wallet.family.toUpperCase()} agent wallet ${wallet.address}`,
        detail: { family: wallet.family, address: wallet.address, chains: wallet.chains },
      });
    }

    return this.list();
  }

  /** The address to fund for a chain. */
  depositAddress(chain: ChainId): string {
    const wallet = this.get(chainFamily(chain));
    if (!wallet) {
      throw new AppError(ErrorCode.NOT_FOUND, `No wallet exists for ${chain} yet`);
    }
    return wallet.address;
  }

  /**
   * Read balances for a chain.
   *
   * An RPC failure returns a reading with `error` set rather than zeros: a
   * fabricated zero balance is indistinguishable from an empty wallet and
   * would flow straight into the risk engine's balance check.
   */
  async readBalances(chain: ChainId, tokens?: string[]): Promise<BalanceReading> {
    const info = CHAINS[chain];
    const wallet = this.get(info.family);
    const adapter = this.#adapters.get(chain);

    if (!wallet) {
      throw new AppError(ErrorCode.NOT_FOUND, `No wallet exists for ${chain} yet`);
    }

    const reading: BalanceReading = {
      chain,
      address: wallet.address,
      native: null,
      tokens: [],
      observedAt: null,
      source: null,
      error: null,
      gasLow: null,
    };

    if (!adapter) {
      reading.error = `No adapter is configured for ${chain}`;
      return reading;
    }

    try {
      const native = await adapter.getNativeBalance(wallet.address);
      reading.native = {
        symbol: native.value.symbol,
        decimals: native.value.decimals,
        amount: native.value.amount,
      };
      reading.observedAt = new Date(native.observedAt).toISOString();
      reading.source = native.source;

      const fee = await adapter.estimateTransferFee();
      // "Low" means the wallet could not pay for three plain transfers: enough
      // headroom to notice before the agent is stuck mid-position.
      reading.gasLow = BigInt(native.value.amount) < BigInt(fee.value.nativeAmount) * 3n;
    } catch (cause) {
      reading.error = errorMessage(cause);
      this.#log.warn({ chain, err: cause }, 'balance read failed');
      return reading;
    }

    const wanted = tokens ?? info.tokens.map((token) => token.address);
    for (const token of wanted) {
      if (token === info.nativeSentinel) continue;
      try {
        const balance = await adapter.getTokenBalance(wallet.address, token);
        reading.tokens.push({
          address: token,
          symbol: balance.value.symbol ?? symbolFromRegistry(chain, token),
          decimals: balance.value.decimals,
          amount: balance.value.amount,
        });
      } catch (cause) {
        // One unreadable token must not hide the rest of the portfolio.
        this.#log.warn({ chain, token, err: cause }, 'token balance read failed');
      }
    }

    return reading;
  }

  /**
   * Export secret material.
   *
   * The caller has already consumed a single-use re-authentication token; this
   * method assumes that check happened and concerns itself with producing the
   * right encoding and an audit row that records the export without recording
   * what was exported.
   */
  exportWallet(format: ExportFormat, keystorePassword?: string): ExportResult {
    const family: WalletFamily = format.startsWith('evm') ? 'evm' : 'solana';
    const wallet = this.get(family);
    if (!wallet) {
      throw new AppError(ErrorCode.NOT_FOUND, `No ${family} wallet exists`);
    }

    const row = this.#db
      .prepare<[WalletFamily], WalletRow>('SELECT * FROM wallets WHERE family = ?')
      .get(family)!;

    const material = this.#vault.exportSecret(row.secret_id, (plaintext) => {
      switch (format) {
        case 'evm-private-key':
          return exportEvmPrivateKeyHex(plaintext);
        case 'evm-keystore': {
          if (!keystorePassword || keystorePassword.length < 12) {
            throw new AppError(
              ErrorCode.SCHEMA_INVALID,
              'A keystore password of at least 12 characters is required',
              { errors: [{ path: 'keystorePassword', message: 'must be at least 12 characters' }] },
            );
          }
          return exportEvmKeystoreV3(plaintext, keystorePassword);
        }
        case 'solana-id-json':
          this.#assertSolanaConsistent(plaintext);
          return exportSolanaIdJson(plaintext);
        case 'solana-base58':
          this.#assertSolanaConsistent(plaintext);
          return exportSolanaBase58(plaintext);
        default:
          throw new AppError(ErrorCode.SCHEMA_INVALID, 'Unsupported export format');
      }
    });

    this.#audit.append({
      category: 'wallet',
      action: 'wallet.exported',
      status: 'ok',
      summary: `Exported ${family.toUpperCase()} wallet as ${format}`,
      detail: { format, address: wallet.address },
    });
    this.#log.warn({ format, family }, 'wallet secret exported');

    return { format, address: wallet.address, material, warning: EXPORT_WARNING };
  }

  #assertSolanaConsistent(secretKey: Uint8Array): void {
    if (!isConsistentSecretKey(secretKey)) {
      throw new AppError(
        ErrorCode.VAULT_CORRUPT,
        'The stored Solana key is inconsistent; refusing to export it',
      );
    }
    const derived = solanaAddressFromSecretKey(secretKey);
    const stored = this.get('solana')?.address;
    if (derived !== stored) {
      throw new AppError(
        ErrorCode.VAULT_CORRUPT,
        'The stored Solana key does not match the recorded address',
      );
    }
  }

  #insert(family: WalletFamily, address: string, secretId: string): WalletSummary {
    const createdAt = new Date().toISOString();
    this.#db
      .prepare(
        'INSERT INTO wallets (id, family, address, secret_id, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), family, address, secretId, createdAt);

    return { family, address, createdAt, chains: chainsFor(family) };
  }
}

function chainsFor(family: WalletFamily): ChainId[] {
  return (Object.keys(CHAINS) as ChainId[]).filter((chain) => CHAINS[chain].family === family);
}

function symbolFromRegistry(chain: ChainId, token: string): string | null {
  return CHAINS[chain].tokens.find((entry) => entry.address === token)?.symbol ?? null;
}
