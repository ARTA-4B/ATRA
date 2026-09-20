import { describe, expect, it } from 'vitest';
import { JupiterAdapter } from '../src/execution/solana/jupiter.js';
import type { QuoteRequest } from '../src/execution/types.js';
import { isAppError } from '../src/util/errors.js';

/**
 * Jupiter is a third party reached over the public internet without a key, and
 * its quote decides what the transaction moves: the mints, the input amount
 * and the on-chain minimum. The ExecutionQuote that comes back is labelled
 * with the tokens the runtime asked for, while its numbers come from Jupiter
 * and its `quoteResponse` is echoed verbatim to /swap — so a reply that
 * quietly names another mint or another amount would have been sized, decided
 * and executed as if it were the trade that was asked for.
 */

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

const request: QuoteRequest = {
  chain: 'solana',
  tokenIn: { address: USDC, decimals: 6 },
  tokenOut: { address: SOL, decimals: 9 },
  amountIn: '10000000',
  slippageBps: 50,
  from: WALLET,
};

/** A faithful answer to `request`, which individual tests then corrupt. */
function honestQuote(overrides: Record<string, unknown> = {}) {
  return {
    inputMint: USDC,
    outputMint: SOL,
    inAmount: '10000000',
    outAmount: '100000000',
    otherAmountThreshold: '99500000', // exactly 50 bps below outAmount
    slippageBps: 50,
    priceImpactPct: '0.0012',
    routePlan: [{ swapInfo: { ammKey: 'pool', label: 'Orca' } }],
    ...overrides,
  };
}

const instructions = {
  computeBudgetInstructions: [
    { programId: 'ComputeBudget111111111111111111111111111111', accounts: [], data: '' },
  ],
  setupInstructions: [],
  swapInstruction: { programId: JUPITER, accounts: [], data: '' },
  cleanupInstruction: null,
  computeUnitLimit: 200_000,
  prioritizationFeeLamports: 10_000,
};

/** A fetch that answers /quote and /swap-instructions from the given quote. */
function fetchWith(quote: Record<string, unknown>) {
  const calls: string[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push(url);
    const body = url.includes('/quote') ? quote : instructions;
    void init;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { impl, calls };
}

function adapterFor(quote: Record<string, unknown>) {
  const { impl, calls } = fetchWith(quote);
  return {
    adapter: new JupiterAdapter({ apiBase: 'https://jupiter.test', fetchImpl: impl }),
    calls,
  };
}

async function refusal(quote: Record<string, unknown>): Promise<string> {
  const { adapter } = adapterFor(quote);
  try {
    await adapter.quote(request);
  } catch (error) {
    expect(isAppError(error)).toBe(true);
    return (error as Error).message;
  }
  throw new Error('the adapter accepted a quote it should have refused');
}

describe('JupiterAdapter.quote checks the answer against the question', () => {
  it('accepts a quote that answers the request', async () => {
    const { adapter, calls } = adapterFor(honestQuote());
    const quote = await adapter.quote(request);

    expect(quote.tokenIn.address).toBe(USDC);
    expect(quote.tokenOut.address).toBe(SOL);
    expect(quote.amountIn).toBe('10000000');
    expect(quote.minAmountOut).toBe('99500000');
    expect(quote.slippageBps).toBe(50);
    expect(quote.programIds).toContain(JUPITER);
    expect(calls.some((url) => url.includes('/quote'))).toBe(true);
  });

  it('refuses a quote for another input mint', async () => {
    const rogue = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    await expect(refusal(honestQuote({ inputMint: rogue }))).resolves.toMatch(
      /different input mint/,
    );
  });

  it('refuses a quote for another output mint', async () => {
    const rogue = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    await expect(refusal(honestQuote({ outputMint: rogue }))).resolves.toMatch(
      /different output mint/,
    );
  });

  it('refuses a quote for a different input amount', async () => {
    await expect(refusal(honestQuote({ inAmount: '99000000' }))).resolves.toMatch(
      /different input amount/,
    );
  });

  it('refuses a quote that applied a different slippage', async () => {
    await expect(refusal(honestQuote({ slippageBps: 900 }))).resolves.toMatch(/different slippage/);
  });

  it('refuses a threshold looser than the approved slippage', async () => {
    // The threshold is what the swap program enforces on chain. Below the
    // floor, the minimum the trade was decided on is not the minimum applied.
    await expect(refusal(honestQuote({ otherAmountThreshold: '90000000' }))).resolves.toMatch(
      /different minimum output/,
    );
  });

  it('accepts a threshold tighter than the approved slippage', async () => {
    const { adapter } = adapterFor(honestQuote({ otherAmountThreshold: '99900000' }));
    await expect(adapter.quote(request)).resolves.toMatchObject({ minAmountOut: '99900000' });
  });
});
