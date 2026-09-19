import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/database.js';
import type { Db } from '../src/db/database.js';
import { AuditLog } from '../src/audit/audit.js';
import { StateStore } from '../src/core/state.js';
import { RiskPolicyStore } from '../src/risk/store.js';
import { RiskGate } from '../src/risk/gate.js';
import { LedgerService } from '../src/trading/ledger.js';
import {
  BASE_NATIVE,
  BASE_USDC,
  BASE_WETH,
  NOW,
  makeAction,
  makeSnapshot,
} from './helpers/risk-fixtures.js';

/**
 * Ledger and gate tests.
 *
 * The ledger is where "how much have I lost today" comes from, so its
 * arithmetic is checked with exact figures rather than approximate ones. The
 * gate is where a proposal becomes a persisted decision, so the properties
 * checked are the ones that stop a decision from being acted on twice.
 */

const TRADE = 'trade-1';

/** fills.trade_id is a foreign key; a fill without a parent trade is an orphan. */
function insertTrade(db: Db, id: string): void {
  db.prepare(
    'INSERT INTO trades (id, action_id, decision_cycle_id, mode, chain, protocol, kind, side,' +
      ' market_key, token_in, token_out, amount_in, status, proposed_at, updated_at)' +
      " VALUES (?, ?, ?, 'PAPER', 'base', 'uniswap-v4', 'swap', 'swap', 'm', ?, ?, '1', 'dispatched', ?, ?)",
  ).run(
    id,
    `action-${id}`,
    'cycle',
    BASE_USDC,
    BASE_WETH,
    new Date(NOW).toISOString(),
    new Date(NOW).toISOString(),
  );
}

describe('LedgerService', () => {
  let db: Db;
  let ledger: LedgerService;

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' });
    ledger = new LedgerService(db, () => NOW);
    ledger.setPaperBalance('base', BASE_USDC, 6, '1000000000'); // 1,000 USDC
    ledger.setPaperBalance('base', BASE_WETH, 18, '0');
    insertTrade(db, TRADE);
    insertTrade(db, 'trade-2');
  });

  afterEach(() => closeDatabase(db));

  function buy(amountUsdc: string, wethOut: string, wethPrice: string, feeUsd = '0.01') {
    return ledger.recordFill({
      tradeId: TRADE,
      mode: 'PAPER',
      chain: 'base',
      tokenIn: { address: BASE_USDC, decimals: 6 },
      tokenOut: { address: BASE_WETH, decimals: 18 },
      amountIn: amountUsdc,
      amountOut: wethOut,
      priceInUsd: '1',
      priceOutUsd: wethPrice,
      feeUsd,
      filledAt: NOW,
      simulated: true,
    });
  }

  it('opens a position at what was paid, not at what it is now worth', () => {
    // Pay 100 USDC, receive 0.04 WETH which marks at 2500 -> exactly 100 USD.
    buy('100000000', '40000000000000000', '2500');

    const position = ledger.getPosition('PAPER', 'base', BASE_WETH);
    expect(position?.amount).toBe('40000000000000000');
    expect(position?.costBasisUsd).toBe('100.000000');
  });

  it('debits and credits paper balances', () => {
    buy('100000000', '40000000000000000', '2500');
    expect(ledger.getPaperBalance('base', BASE_USDC)?.amount).toBe('900000000');
    expect(ledger.getPaperBalance('base', BASE_WETH)?.amount).toBe('40000000000000000');
  });

  it('refuses a paper fill that would overdraw', () => {
    expect(() => buy('5000000000', '1', '2500')).toThrow(/negative/);
    // Nothing partial was written.
    expect(ledger.getPaperBalance('base', BASE_USDC)?.amount).toBe('1000000000');
    expect(ledger.listPositions('PAPER')).toEqual([]);
  });

  it('charges the fee as realized loss', () => {
    const fill = buy('100000000', '40000000000000000', '2500', '0.25');
    expect(fill.realizedPnlUsd).toBe('-0.250000');
    expect(ledger.realizedPnlTodayUsd('PAPER')).toBe(-250_000n);
  });

  it('realizes profit on a close at average cost', () => {
    buy('100000000', '40000000000000000', '2500', '0');

    // Sell the 0.04 WETH for 120 USDC: WETH now at 3000.
    const fill = ledger.recordFill({
      tradeId: 'trade-2',
      mode: 'PAPER',
      chain: 'base',
      tokenIn: { address: BASE_WETH, decimals: 18 },
      tokenOut: { address: BASE_USDC, decimals: 6 },
      amountIn: '40000000000000000',
      amountOut: '120000000',
      priceInUsd: '3000',
      priceOutUsd: '1',
      feeUsd: '0',
      filledAt: NOW,
      simulated: true,
    });

    expect(fill.realizedPnlUsd).toBe('20.000000');
    expect(ledger.getPosition('PAPER', 'base', BASE_WETH)).toBeUndefined();
    expect(ledger.getPaperBalance('base', BASE_USDC)?.amount).toBe('1020000000');
  });

  it('realizes a partial reduce proportionally', () => {
    buy('100000000', '40000000000000000', '2500', '0');

    // Sell half at 2000: proceeds 40 USD against a 50 USD cost basis.
    const fill = ledger.recordFill({
      tradeId: 'trade-2',
      mode: 'PAPER',
      chain: 'base',
      tokenIn: { address: BASE_WETH, decimals: 18 },
      tokenOut: { address: BASE_USDC, decimals: 6 },
      amountIn: '20000000000000000',
      amountOut: '40000000',
      priceInUsd: '2000',
      priceOutUsd: '1',
      feeUsd: '0',
      filledAt: NOW,
      simulated: true,
    });

    expect(fill.realizedPnlUsd).toBe('-10.000000');
    const remaining = ledger.getPosition('PAPER', 'base', BASE_WETH);
    expect(remaining?.amount).toBe('20000000000000000');
    expect(remaining?.costBasisUsd).toBe('50.000000');
  });

  it('averages cost across two buys', () => {
    buy('100000000', '40000000000000000', '2500', '0'); // 0.04 @ 2500
    buy('60000000', '20000000000000000', '3000', '0'); // 0.02 @ 3000

    const position = ledger.getPosition('PAPER', 'base', BASE_WETH);
    expect(position?.amount).toBe('60000000000000000');
    expect(position?.costBasisUsd).toBe('160.000000');
  });

  it('marks positions and reports unrealized P&L', () => {
    buy('100000000', '40000000000000000', '2500', '0');

    const mark = ledger.mark('PAPER', (_chain, token) =>
      token === BASE_WETH ? '2600' : token === BASE_USDC ? '1' : null,
    );

    expect(mark.positionsValueUsd).not.toBeNull();
    // WETH: 0.04 * 2600 = 104 vs cost 100 -> +4.
    const weth = mark.positions.find((p) => p.token === BASE_WETH);
    expect(weth?.unrealizedUsd).toBe('4.000000');
    expect(mark.deployedUsd).toBe('100.000000');
  });

  it('refuses to total a portfolio with an unpriced position', () => {
    buy('100000000', '40000000000000000', '2500', '0');
    const mark = ledger.mark('PAPER', () => null);

    expect(mark.positionsValueUsd).toBeNull();
    expect(mark.unrealizedPnlUsd).toBeNull();
    expect(mark.unpriced.length).toBeGreaterThan(0);
  });

  it('treats a zero price as unpriced', () => {
    buy('100000000', '40000000000000000', '2500', '0');
    const mark = ledger.mark('PAPER', () => '0');
    expect(mark.positionsValueUsd).toBeNull();
  });

  it('keeps PAPER and LIVE positions apart', () => {
    buy('100000000', '40000000000000000', '2500', '0');
    expect(ledger.listPositions('LIVE')).toEqual([]);
    // Spending USDC from the balance opens no position; only the WETH bought is one.
    expect(ledger.listPositions('PAPER')).toHaveLength(1);
  });

  it('records the day start mark only once', () => {
    ledger.recordDayStart('PAPER', '-5');
    ledger.recordDayStart('PAPER', '99');
    const risk = ledger.toRiskLedger('PAPER', () => '1');
    expect(risk.unrealizedPnlAtDayStartUsd).toBe('-5');
  });

  it('never writes a fill row that can be edited', () => {
    const fill = buy('100000000', '40000000000000000', '2500');
    expect(() =>
      db.prepare('UPDATE fills SET realized_pnl_usd = ? WHERE id = ?').run('999', fill.id),
    ).toThrow(/append-only/);
  });
});

describe('RiskGate', () => {
  let db: Db;
  let gate: RiskGate;
  let ledger: LedgerService;
  const price = (_chain: unknown, token: string) =>
    token === BASE_USDC
      ? '1.000027'
      : token === BASE_WETH || token === BASE_NATIVE
        ? '2500.123456'
        : null;

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' });
    const audit = new AuditLog(db);
    const state = new StateStore(db, audit);
    state.createInstallation('i', 'test', ['base', 'solana']);
    const policy = new RiskPolicyStore(db, audit);
    policy.initialize(['base', 'solana']);
    ledger = new LedgerService(db, () => NOW);
    ledger.setPaperBalance('base', BASE_USDC, 6, '100000000');
    ledger.setPaperBalance('base', BASE_NATIVE, 18, '50000000000000000');
    gate = new RiskGate({ db, audit, state, policy, ledger, now: () => NOW });
    insertTrade(db, 't');
  });

  afterEach(() => closeDatabase(db));

  it('allows a good proposal and persists the decision', () => {
    const action = makeAction();
    const decision = gate.decide(action, makeSnapshot(), price);

    expect(decision.code).toBe('OK');
    expect(gate.getDecision(action.actionId)?.code).toBe('OK');
    expect(gate.listDecisions()).toHaveLength(1);
  });

  it('returns DUPLICATE_ACTION for the same intent, even when the first was allowed', () => {
    const first = makeAction();
    expect(gate.decide(first, makeSnapshot(), price).allowed).toBe(true);

    // Same cycle, same trade, new actionId: the idempotency key is identical.
    const second = makeAction({ decisionCycleId: first.decisionCycleId });
    const replay = gate.decide(second, makeSnapshot(), price);

    expect(replay.allowed).toBe(false);
    expect(replay.code).toBe('DUPLICATE_ACTION');
    expect(replay.replayOf).toBe(first.actionId);
  });

  it('does not start a cooldown on decide', () => {
    const action = makeAction();
    gate.decide(action, makeSnapshot(), price);

    const again = makeAction({ decisionCycleId: '11111111-1111-7111-8111-111111111111' });
    expect(gate.decide(again, makeSnapshot(), price).code).toBe('OK');
  });

  it('starts the cooldown only when dispatched', () => {
    const action = makeAction();
    gate.decide(action, makeSnapshot(), price);
    gate.markDispatched(action);

    const again = makeAction({ decisionCycleId: '11111111-1111-7111-8111-111111111111' });
    expect(gate.decide(again, makeSnapshot(), price).code).toBe('COOLDOWN_ACTIVE');
  });

  it('preview never persists', () => {
    const action = makeAction();
    expect(gate.preview(action, makeSnapshot(), price).code).toBe('OK');
    expect(gate.listDecisions()).toEqual([]);
    // And so a later decide on the same intent is not a duplicate.
    expect(gate.decide(action, makeSnapshot(), price).code).toBe('OK');
  });

  it('feeds the ledger into the daily-loss check', () => {
    // Lose 49.99 today, then propose: fee plus worst-case slippage tips it over.
    ledger.recordFill({
      tradeId: 't',
      mode: 'PAPER',
      chain: 'base',
      tokenIn: { address: BASE_USDC, decimals: 6 },
      tokenOut: { address: BASE_WETH, decimals: 18 },
      amountIn: '10000000',
      amountOut: '1',
      priceInUsd: '1',
      priceOutUsd: '2500',
      feeUsd: '49.99',
      filledAt: NOW,
      simulated: true,
    });

    const decision = gate.decide(makeAction(), makeSnapshot(), price);
    expect(decision.code).toBe('DAILY_LOSS_BREACHED');
  });

  it('writes an audit row for every decision', () => {
    gate.decide(makeAction(), makeSnapshot(), price);
    const audit = new AuditLog(db);
    const events = audit.list({ category: 'risk' });
    expect(events.some((e) => e.action === 'decision.allowed')).toBe(true);
  });

  it('cannot rewrite a persisted decision', () => {
    const action = makeAction();
    gate.decide(action, makeSnapshot(), price);
    expect(() =>
      db
        .prepare('UPDATE action_decisions SET allowed = 0 WHERE action_id = ?')
        .run(action.actionId),
    ).toThrow(/append-only/);
  });
});
