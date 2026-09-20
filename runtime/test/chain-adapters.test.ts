import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvmChainAdapter } from '../src/chains/evm/adapter.js';
import { SolanaChainAdapter } from '../src/chains/solana/adapter.js';
import { AppError, ErrorCode } from '../src/util/errors.js';

/**
 * Adapter tests against hostile endpoints.
 *
 * An RPC node is an external party. The cases here are the ones where believing
 * it costs money: a reply whose shape changed, a node that is unreachable while
 * a transaction is in flight, and an error message that quotes the endpoint URL
 * back to an operator who is paying for that URL with a key.
 */

const OWNER = 'So11111111111111111111111111111111111111112';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SIGNATURE =
  '5wHu1qwD4kLwYqAdkGYVfzrVWXdcxu1v2f8VjZxJzMx3ZYc8e4xHkkzYJ9gWZ1D9Cke1HzvMLLGMWwcyfRDcaCiZ';
const BLOCKHASH = 'GH7ome3EiwEr7tu9JuTh2dpYWBJK3z69Xm1ZE3MEE6JC';
const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

/** An RPC that answers each method from a script, however wrong the shape. */
function rpcReturning(replies: Record<string, unknown>): typeof fetch {
  return ((_url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as { id: number; method: string };
    const reply = replies[body.method];
    return Promise.resolve(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: reply }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
}

function solana(replies: Record<string, unknown>): SolanaChainAdapter {
  return new SolanaChainAdapter({
    rpcUrl: 'https://rpc.example.test/v2/SUPERSECRETKEY',
    fetchImpl: rpcReturning(replies),
  });
}

/** Assert a rejection is ATRA's typed error, not a raw TypeError from a cast. */
async function expectAppError(promise: Promise<unknown>): Promise<AppError> {
  const caught = await promise.then(
    () => null,
    (error: unknown) => error,
  );

  expect(caught).toBeInstanceOf(AppError);
  expect(caught).not.toBeInstanceOf(TypeError);
  return caught as AppError;
}

describe('SolanaChainAdapter reply validation', () => {
  it('reads a well-formed balance', async () => {
    const observation = await solana({ getBalance: { value: 1_500 } }).getNativeBalance(OWNER);
    expect(observation.value.amount).toBe('1500');
  });

  it('rejects a balance that is not an integer', async () => {
    const error = await expectAppError(
      solana({ getBalance: { value: 1.5 } }).getNativeBalance(OWNER),
    );
    expect(error.code).toBe(ErrorCode.UPSTREAM_UNAVAILABLE);
  });

  it('rejects a balance the node sent as a string', async () => {
    const error = await expectAppError(
      solana({ getBalance: { value: '1500' } }).getNativeBalance(OWNER),
    );
    expect(error.message).toContain('getBalance');
  });

  it('rejects a reply that is not an object at all', async () => {
    await expectAppError(solana({ getBalance: null }).getNativeBalance(OWNER));
  });

  it('sums token accounts when every amount is a digit string', async () => {
    const account = (amount: string) => ({
      account: { data: { parsed: { info: { tokenAmount: { amount, decimals: 6 } } } } },
    });

    const observation = await solana({
      getTokenAccountsByOwner: { value: [account('10'), account('32')] },
    }).getTokenBalance(OWNER, MINT);

    // Both token programs are queried and this node answers the same for each.
    expect(observation.value.amount).toBe('84');
    expect(observation.value.decimals).toBe(6);
  });

  it('rejects a token amount that is not a digit string', async () => {
    const error = await expectAppError(
      solana({
        getTokenAccountsByOwner: {
          value: [
            {
              account: {
                data: { parsed: { info: { tokenAmount: { amount: '1e9', decimals: 6 } } } },
              },
            },
          ],
        },
      }).getTokenBalance(OWNER, MINT),
    );
    expect(error.code).toBe(ErrorCode.UPSTREAM_UNAVAILABLE);
  });

  it('rejects a token account missing its parsed info', async () => {
    await expectAppError(
      solana({ getTokenAccountsByOwner: { value: [{ account: { data: {} } }] } }).getTokenBalance(
        OWNER,
        MINT,
      ),
    );
  });

  it('rejects decimals outside the u8 range', async () => {
    await expectAppError(
      solana({
        getAccountInfo: { value: { owner: MINT, data: { parsed: { info: { decimals: 999 } } } } },
      }).getTokenMetadata(MINT),
    );
  });

  it('reads mint decimals from a parsed account', async () => {
    const observation = await solana({
      getAccountInfo: { value: { owner: MINT, data: { parsed: { info: { decimals: 9 } } } } },
    }).getTokenMetadata(MINT);
    expect(observation.value.decimals).toBe(9);
  });

  it('reports an unparsed account as unknown decimals rather than failing', async () => {
    const observation = await solana({
      getAccountInfo: { value: { owner: MINT, data: ['ZGF0YQ==', 'base64'] } },
    }).getTokenMetadata(MINT);
    expect(observation.value.decimals).toBeNull();
  });

  it('rejects a signature status whose slot is negative', async () => {
    await expectAppError(
      solana({
        getSignatureStatuses: {
          value: [{ slot: -1, confirmations: null, confirmationStatus: 'finalized', err: null }],
        },
      }).getTransactionStatus(SIGNATURE),
    );
  });

  it('reads a confirmed signature status', async () => {
    const observation = await solana({
      getSignatureStatuses: {
        value: [{ slot: 42, confirmations: 3, confirmationStatus: 'finalized', err: null }],
      },
    }).getTransactionStatus(SIGNATURE);

    expect(observation.value.state).toBe('confirmed');
    expect(observation.value.height).toBe(42);
    expect(observation.value.confirmations).toBe(3);
  });

  it('rejects a blockhash that is not 32 base58 bytes', async () => {
    const error = await expectAppError(
      solana({
        getLatestBlockhash: { value: { blockhash: 'not-a-blockhash', lastValidBlockHeight: 10 } },
      }).prepareTransfer({ from: OWNER, to: MINT, token: null, amount: 1n, decimals: 9 }),
    );
    expect(error.message).toContain('getLatestBlockhash');
  });

  it('accepts a real blockhash', async () => {
    const prepared = await solana({
      getLatestBlockhash: { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 10 } },
    }).prepareTransfer({ from: OWNER, to: MINT, token: null, amount: 1n, decimals: 9 });

    expect(prepared.feeNative).toBe('5000');
  });

  it('rejects a body larger than the cap before parsing it', async () => {
    const huge = ((_url: string) =>
      Promise.resolve(
        new Response('{"jsonrpc":"2.0","id":1,"result":{"value":1}}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': '99999999' },
        }),
      )) as unknown as typeof fetch;

    const adapter = new SolanaChainAdapter({ rpcUrl: 'https://rpc.example.test', fetchImpl: huge });
    const error = await expectAppError(adapter.getNativeBalance(OWNER));
    expect(error.code).toBe(ErrorCode.UPSTREAM_UNAVAILABLE);
  });

  it('names the failure in health without quoting the endpoint', async () => {
    const health = await solana({ getGenesisHash: 'devnet', getSlot: 1 }).health();

    expect(health.healthy).toBe(false);
    expect(health.error).toMatch(/^solana RPC health check failed: /);
    expect(health.error).not.toContain('SUPERSECRETKEY');
  });

  it('reports a genuine mainnet endpoint as healthy', async () => {
    const health = await solana({ getGenesisHash: GENESIS, getSlot: 7 }).health();

    expect(health.healthy).toBe(true);
    expect(health.identityMatches).toBe(true);
    expect(health.height).toBe(7);
  });
});

/**
 * A JSON-RPC server the EVM adapter can really talk to. viem's client cannot be
 * replaced from the outside, so the node is the thing under control here.
 */
describe('EvmChainAdapter receipt lookup', () => {
  let url: string;
  let mode: 'no-receipt' | 'down' = 'no-receipt';
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      if (mode === 'down') {
        response.writeHead(503, { 'content-type': 'text/plain' });
        response.end('upstream is down');
        return;
      }

      const call = JSON.parse(body) as { id: number; method: string };
      // A node that has not seen the transaction answers with a null receipt.
      const result = call.method === 'eth_blockNumber' ? '0x10' : null;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    });
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    url = `http://127.0.0.1:${String(address.port)}/v2/SUPERSECRETKEY`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  function adapter(): EvmChainAdapter {
    return new EvmChainAdapter('base', { rpcUrl: url, timeoutMs: 2_000 });
  }

  const HASH = `0x${'ab'.repeat(32)}`;

  it('reports a transaction with no receipt as pending', async () => {
    mode = 'no-receipt';
    const observation = await adapter().getTransactionStatus(HASH);

    expect(observation.value.state).toBe('pending');
    expect(observation.value.height).toBeNull();
  });

  it('fails loudly when the node cannot be reached', async () => {
    mode = 'down';
    const error = await expectAppError(adapter().getTransactionStatus(HASH));

    // "Not mined yet" and "cannot reach the node" must not look the same: the
    // first is a state, the second is an outage.
    expect(error.code).toBe(ErrorCode.UPSTREAM_UNAVAILABLE);
    expect(error.message).toContain('txStatus');
  });

  it('names the failure in health without quoting the endpoint', async () => {
    mode = 'down';
    const health = await adapter().health();

    expect(health.healthy).toBe(false);
    expect(health.error).toMatch(/^base RPC health check failed: /);
    expect(health.error).not.toContain('SUPERSECRETKEY');
  });
});
