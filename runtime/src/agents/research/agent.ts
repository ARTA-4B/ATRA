import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ChainId } from '../../chains/registry.js';
import { CHAINS } from '../../chains/registry.js';
import { childLogger } from '../../logging/logger.js';
import { errorMessage } from '../../util/errors.js';
import type { MarketService } from '../../market/service.js';
import type { MarketSnapshot, OhlcvSeries } from '../../market/types.js';
import type { LlmProvider } from '../../llm/provider.js';
import type { AuditLog } from '../../audit/audit.js';
import type { Db } from '../../db/database.js';

/**
 * The Research Agent.
 *
 * It gathers evidence and describes what it found. It does not trade, does not
 * sign, does not propose an action and has no access to the vault.
 *
 * The output separates two things that are easy to blur and expensive to
 * confuse:
 *
 *  - **facts** — values ATRA actually observed, each with its source and age;
 *  - **interpretation** — what a model made of them.
 *
 * A fact can be checked. An interpretation cannot, so it is never allowed to
 * introduce a number. Any figure the model states that was not in the evidence
 * is stripped and reported as a hallucination, which is also how the model's
 * evaluation suite scores it.
 *
 * When the evidence is thin the result is `INSUFFICIENT_DATA`. That is a
 * success, not a failure: an agent that handles money must be able to say it
 * does not know.
 */

export type ResearchStatus = 'OK' | 'INSUFFICIENT_DATA' | 'ERROR';

export interface ResearchFact {
  /** A short machine-readable name, e.g. `price.usd` or `liquidity.usd`. */
  key: string;
  value: string;
  source: string;
  observedAt: string;
  ageMs: number;
  stale: boolean;
}

export interface ResearchResult {
  id: string;
  createdAt: string;
  chain: ChainId;
  poolId: string | null;
  token: string | null;
  status: ResearchStatus;
  /** Everything ATRA observed. Empty when nothing could be read. */
  facts: ResearchFact[];
  /** The model's reading of those facts. Never contains a new number. */
  interpretation: string[];
  /** Inputs that were missing or too old to use. */
  staleInputs: string[];
  sources: string[];
  model: string;
  modelStatus: 'UNTRAINED' | 'TRAINED' | 'UNAVAILABLE';
  /** Set when the model asserted a figure that was not in the evidence. */
  hallucinatedValues: string[];
  summary: string;
}

/** What the model is allowed to return. Deliberately narrow. */
const interpretationSchema = z.object({
  summary: z.string().min(1).max(500),
  observations: z.array(z.string().min(1).max(300)).max(8),
  concerns: z.array(z.string().min(1).max(300)).max(8),
  confidence: z.enum(['low', 'medium', 'high']),
});

const SYSTEM_PROMPT = `You are ATRA's research assistant.

You are given market evidence that ATRA has already observed and verified. Your
job is to describe what it means for someone deciding whether a market is worth
attention.

Rules you must follow:
- Never state a number that is not present in the evidence. If you want to
  mention a price, liquidity figure or percentage, it must appear verbatim in
  the evidence given to you.
- Never guess at data that is missing. Say it is missing.
- Never recommend a trade, a size or a direction. You describe; you do not
  decide.
- If the evidence is thin, stale or contradictory, say so plainly. "The data is
  insufficient to judge this market" is a complete and acceptable answer.
- Reply only with JSON matching the schema.`;

export interface ResearchRequest {
  chain: ChainId;
  /** A token address, or a pool identifier when researching one market. */
  token?: string;
  poolId?: string;
  /** Include historical candles. Costs an extra provider call. */
  includeHistory?: boolean;
}

export interface ResearchAgentOptions {
  db?: Db | undefined;
  audit?: AuditLog | undefined;
  /** Facts older than this are reported as stale. */
  maxAgeMs?: number;
  now?: () => number;
}

export class ResearchAgent {
  readonly #market: MarketService;
  readonly #llm: LlmProvider;
  readonly #db: Db | undefined;
  readonly #audit: AuditLog | undefined;
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  readonly #log = childLogger('research');

  constructor(market: MarketService, llm: LlmProvider, options: ResearchAgentOptions = {}) {
    this.#market = market;
    this.#llm = llm;
    this.#db = options.db;
    this.#audit = options.audit;
    this.#maxAgeMs = options.maxAgeMs ?? 120_000;
    this.#now = options.now ?? (() => Date.now());
  }

  async research(request: ResearchRequest): Promise<ResearchResult> {
    const id = randomUUID();
    const createdAt = new Date(this.#now()).toISOString();

    const evidence = await this.#gather(request);

    const result: ResearchResult = {
      id,
      createdAt,
      chain: request.chain,
      poolId: request.poolId ?? evidence.pool?.poolId ?? null,
      token: request.token ?? null,
      status: 'OK',
      facts: evidence.facts,
      interpretation: [],
      staleInputs: evidence.staleInputs,
      sources: [...new Set(evidence.facts.map((fact) => fact.source))],
      model: this.#llm.model,
      modelStatus: 'UNAVAILABLE',
      hallucinatedValues: [],
      summary: '',
    };

    // Not enough to reason about. This is the common case for an unknown token
    // and it must not produce confident-sounding prose.
    //
    // Registry facts (the chain's own name and native symbol) are excluded from
    // the count: they are always present and always fresh, so counting them
    // made INSUFFICIENT_DATA unreachable — every request looked like it had
    // two solid data points before a single provider had been asked.
    const usable = evidence.facts.filter((fact) => !fact.stale && fact.source !== 'registry');
    if (usable.length === 0) {
      result.status = 'INSUFFICIENT_DATA';
      result.summary =
        evidence.facts.length === 0
          ? 'No market data could be retrieved for this request.'
          : 'All available market data was too old to rely on.';
      this.#record(result);
      return result;
    }

    const availability = await this.#llm.available();
    if (!availability.available) {
      // Without a model there is no interpretation — but the facts are still
      // worth returning, clearly labelled as facts only.
      result.status = 'OK';
      result.modelStatus = 'UNAVAILABLE';
      result.summary = `Observed ${String(usable.length)} data points. No reasoning model is available (${availability.detail}), so this report contains observations only.`;
      this.#record(result);
      return result;
    }

    try {
      const response = await this.#llm.chat(
        {
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: renderEvidence(request, evidence) }],
          responseSchema: jsonSchemaForInterpretation(),
          temperature: 0.2,
        },
        interpretationSchema,
      );

      const allowed = allowedNumbers(evidence);
      const checked = [...response.data.observations, ...response.data.concerns].map((line) =>
        checkForInventedNumbers(line, allowed),
      );

      result.interpretation = checked.map((entry) => entry.text);
      result.hallucinatedValues = checked.flatMap((entry) => entry.invented);

      const summaryCheck = checkForInventedNumbers(response.data.summary, allowed);
      result.summary = summaryCheck.text;
      result.hallucinatedValues.push(...summaryCheck.invented);

      result.modelStatus = 'UNTRAINED';

      if (result.hallucinatedValues.length > 0) {
        this.#log.warn(
          { invented: result.hallucinatedValues, model: this.#llm.model },
          'model asserted figures absent from the evidence',
        );
      }
    } catch (error) {
      // A failed model call degrades the report; it does not fail the request.
      // The operator still gets the facts.
      result.modelStatus = 'UNAVAILABLE';
      result.summary = `Observed ${String(usable.length)} data points. The reasoning model could not be used: ${errorMessage(error)}`;
      this.#log.warn({ err: error }, 'research interpretation failed');
    }

    this.#record(result);
    return result;
  }

  /** Collect evidence. Every value carries its source and age. */
  async #gather(request: ResearchRequest): Promise<Evidence> {
    const facts: ResearchFact[] = [];
    const staleInputs: string[] = [];
    let pool: MarketSnapshot | undefined;
    let history: OhlcvSeries | undefined;

    const chainInfo = CHAINS[request.chain];
    facts.push(
      this.#fact('chain.id', request.chain, 'registry', new Date(this.#now()).toISOString()),
      this.#fact(
        'chain.nativeSymbol',
        chainInfo.nativeSymbol,
        'registry',
        new Date(this.#now()).toISOString(),
      ),
    );

    if (request.poolId) {
      try {
        const snapshot = await this.#market.getPool(request.chain, request.poolId);
        if (snapshot) {
          pool = snapshot;
          facts.push(...this.#poolFacts(snapshot));
        } else {
          staleInputs.push(`pool ${request.poolId} was not found by any provider`);
        }
      } catch (error) {
        staleInputs.push(`pool lookup failed: ${errorMessage(error)}`);
      }
    }

    if (request.token) {
      try {
        const price = await this.#market.getCrossCheckedPrice(request.chain, request.token);
        if (price.priceUsd !== null) {
          facts.push(
            this.#fact(
              'price.usd',
              price.priceUsd,
              price.sources.map((source) => source.source).join('+'),
              price.sources[0]?.observedAt ?? new Date(this.#now()).toISOString(),
            ),
          );
          if (price.deviationBps !== null) {
            facts.push(
              this.#fact(
                'price.crossCheckDeviationBps',
                String(price.deviationBps),
                'atra',
                new Date(this.#now()).toISOString(),
              ),
            );
          }
          if (price.disputed) {
            staleInputs.push(price.reason ?? 'providers disagree about this price');
          }
        } else {
          staleInputs.push(price.reason ?? 'no provider returned a price');
        }
      } catch (error) {
        staleInputs.push(`price lookup failed: ${errorMessage(error)}`);
      }

      if (!pool) {
        try {
          const pools = await this.#market.getPoolsForToken(request.chain, request.token);
          const deepest = pools[0];
          if (deepest) {
            pool = deepest;
            facts.push(...this.#poolFacts(deepest));
          }
        } catch (error) {
          staleInputs.push(`pool discovery failed: ${errorMessage(error)}`);
        }
      }
    }

    if (request.includeHistory && pool) {
      try {
        history = (await this.#market.getOhlcv(request.chain, pool.poolId, '1h', 24)) ?? undefined;
        if (history && history.candles.length > 0) {
          const first = history.candles[0];
          const last = history.candles.at(-1);
          if (first && last) {
            facts.push(
              this.#fact(
                'history.candles',
                String(history.candles.length),
                history.source,
                history.fetchedAt,
              ),
              this.#fact('history.firstClose', first.close, history.source, first.openedAt),
              this.#fact('history.lastClose', last.close, history.source, last.openedAt),
            );
          }
        } else {
          staleInputs.push('no historical candles were available for this pool');
        }
      } catch (error) {
        staleInputs.push(`history lookup failed: ${errorMessage(error)}`);
      }
    }

    for (const fact of facts) {
      if (fact.stale)
        staleInputs.push(`${fact.key} is ${String(Math.round(fact.ageMs / 1000))}s old`);
    }

    return { facts, staleInputs, pool, history };
  }

  #poolFacts(snapshot: MarketSnapshot): ResearchFact[] {
    const facts: ResearchFact[] = [
      this.#fact('pool.id', snapshot.poolId, snapshot.source, snapshot.observedAt),
    ];

    if (snapshot.dexId) {
      facts.push(this.#fact('pool.dex', snapshot.dexId, snapshot.source, snapshot.observedAt));
    }
    if (snapshot.base.symbol && snapshot.quote.symbol) {
      facts.push(
        this.#fact(
          'pool.pair',
          `${snapshot.base.symbol}/${snapshot.quote.symbol}`,
          snapshot.source,
          snapshot.observedAt,
        ),
      );
    }
    if (snapshot.priceUsd !== null) {
      facts.push(
        this.#fact('pool.priceUsd', snapshot.priceUsd, snapshot.source, snapshot.observedAt),
      );
    }
    if (snapshot.liquidityUsd !== null) {
      facts.push(
        this.#fact('liquidity.usd', snapshot.liquidityUsd, snapshot.source, snapshot.observedAt),
      );
    }
    if (snapshot.volume24hUsd !== null) {
      facts.push(
        this.#fact('volume.24hUsd', snapshot.volume24hUsd, snapshot.source, snapshot.observedAt),
      );
    }
    if (snapshot.change.h24 !== null) {
      facts.push(
        this.#fact(
          'change.24hBps',
          String(snapshot.change.h24),
          snapshot.source,
          snapshot.observedAt,
        ),
      );
    }

    return facts;
  }

  #fact(key: string, value: string, source: string, observedAt: string): ResearchFact {
    const ageMs = Math.max(this.#now() - Date.parse(observedAt), 0);
    return { key, value, source, observedAt, ageMs, stale: ageMs > this.#maxAgeMs };
  }

  #record(result: ResearchResult): void {
    this.#audit?.append({
      category: 'research',
      action: 'research.completed',
      status: result.status === 'ERROR' ? 'failed' : 'ok',
      summary: `Research on ${result.chain}: ${result.status}`,
      chain: result.chain,
      actor: 'agent:research',
      detail: {
        researchId: result.id,
        facts: result.facts.length,
        staleInputs: result.staleInputs.length,
        hallucinated: result.hallucinatedValues.length,
        model: result.model,
      },
    });

    if (!this.#db) return;

    try {
      this.#db
        .prepare(
          'INSERT INTO research_results (id, created_at, chain, pool_id, status, facts_json,' +
            ' interpretation_json, stale_inputs_json, sources_json, model, model_status)' +
            ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          result.id,
          result.createdAt,
          result.chain,
          result.poolId,
          result.status,
          JSON.stringify(result.facts),
          JSON.stringify(result.interpretation),
          JSON.stringify(result.staleInputs),
          JSON.stringify(result.sources),
          result.model,
          result.modelStatus,
        );
    } catch (error) {
      this.#log.warn({ err: error }, 'could not persist research result');
    }
  }
}

interface Evidence {
  facts: ResearchFact[];
  staleInputs: string[];
  pool: MarketSnapshot | undefined;
  history: OhlcvSeries | undefined;
}

function renderEvidence(request: ResearchRequest, evidence: Evidence): string {
  const lines: string[] = [
    `Chain: ${request.chain}`,
    request.token ? `Token: ${request.token}` : '',
    '',
    'EVIDENCE (every value below was observed by ATRA):',
  ].filter(Boolean);

  for (const fact of evidence.facts) {
    const age = `${String(Math.round(fact.ageMs / 1000))}s old`;
    lines.push(
      `- ${fact.key} = ${fact.value} (source: ${fact.source}, ${age}${fact.stale ? ', STALE' : ''})`,
    );
  }

  if (evidence.staleInputs.length > 0) {
    lines.push('', 'MISSING OR UNRELIABLE:');
    for (const issue of evidence.staleInputs) lines.push(`- ${issue}`);
  }

  lines.push(
    '',
    'Describe what this evidence shows. Use only the numbers above. If it is not enough to judge the market, say so.',
  );

  return lines.join('\n');
}

function jsonSchemaForInterpretation(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'observations', 'concerns', 'confidence'],
    properties: {
      summary: { type: 'string', maxLength: 500 },
      observations: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 300 } },
      concerns: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 300 } },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    },
  };
}

/** Every numeric token that appears in the evidence, as written. */
function allowedNumbers(evidence: Evidence): Set<string> {
  const allowed = new Set<string>();

  for (const fact of evidence.facts) {
    for (const match of fact.value.matchAll(/\d+(?:\.\d+)?/g)) {
      allowed.add(normalizeNumber(match[0]));
    }
    // Ages are rendered into the prompt in seconds, so they are fair to cite.
    allowed.add(normalizeNumber(String(Math.round(fact.ageMs / 1000))));
  }

  // Small integers are almost always counts or ordinals rather than claims
  // about the market, and flagging them produces noise that hides real
  // fabrications.
  for (let i = 0; i <= 24; i += 1) allowed.add(String(i));

  return allowed;
}

/**
 * Strip numbers the model invented.
 *
 * A sentence containing a figure that was not in the evidence is replaced
 * rather than edited: partially rewriting a claim leaves something that reads
 * as verified when it is not.
 */
export function checkForInventedNumbers(
  text: string,
  allowed: Set<string>,
): { text: string; invented: string[] } {
  const invented: string[] = [];

  for (const match of text.matchAll(/\d+(?:\.\d+)?/g)) {
    const value = normalizeNumber(match[0]);
    if (!allowed.has(value)) invented.push(match[0]);
  }

  if (invented.length === 0) return { text, invented };

  return {
    text: '[removed: this statement contained figures that were not in the evidence]',
    invented,
  };
}

/** Trim trailing zeros so "1.00" and "1" compare equal. */
function normalizeNumber(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}
