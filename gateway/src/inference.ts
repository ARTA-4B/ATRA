/**
 * POST /v1/inference: optional, off by default.
 *
 * The gateway proxies a chat completion if and only if the operator has
 * configured a provider: either a Workers AI binding (`AI`) plus
 * INFERENCE_MODEL, or an OpenAI-compatible INFERENCE_URL plus INFERENCE_MODEL
 * (and optionally INFERENCE_API_KEY). With neither, the route answers 501 so
 * a runtime knows to use its own provider (BYOK, the documented default).
 *
 * The gateway does not know what the configured model is, so it says nothing
 * about it beyond echoing the configured name. ATRA-4B is UNTRAINED and is
 * not hosted anywhere; nothing here changes that. The response is text; the
 * runtime's deterministic risk engine, not the model, decides what happens
 * to it.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { requireInstall } from './auth.js';
import type { AppEnv } from './context.js';
import type { Env } from './env.js';
import { logger } from './log.js';
import { badGateway, badRequest, notImplemented } from './problem.js';
import { guardProxy, readJson } from './proxy.js';
import { quotaHeaders } from './quota.js';
import { recordUsage } from './usage.js';
import type { UsageOutcome } from './usage.js';

const log = logger('inference');

export const INFERENCE_TIMEOUT_MS = 30_000;
export const NOT_CONFIGURED_DETAIL = 'no inference provider is configured on this gateway';

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1).max(16_000),
});

export const inferenceRequestSchema = z
  .object({
    messages: z.array(messageSchema).min(1).max(32),
    maxTokens: z.number().int().min(1).max(2048).optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .strict();

export type InferenceRequest = z.infer<typeof inferenceRequestSchema>;

export type InferenceProvider =
  | { kind: 'workers-ai'; model: string }
  | { kind: 'upstream'; model: string; url: string; apiKey: string | undefined }
  | null;

/** Which provider is configured, or null. The URL and key never leave this function's callers' logs. */
export function inferenceProvider(env: Env): InferenceProvider {
  const model = env.INFERENCE_MODEL?.trim();
  if (!model) return null;
  if (env.AI !== undefined && typeof env.AI.run === 'function') {
    return { kind: 'workers-ai', model };
  }
  const url = env.INFERENCE_URL?.trim();
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        return {
          kind: 'upstream',
          model,
          url: parsed.href,
          apiKey: env.INFERENCE_API_KEY?.trim() || undefined,
        };
      }
    } catch {
      // fall through
    }
    log.warn('INFERENCE_URL is not a valid http(s) URL; inference stays off');
  }
  return null;
}

export interface InferenceResult {
  model: string;
  output: string;
  finishReason: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null } | null;
}

type RunOutcome = { ok: true; result: InferenceResult } | { ok: false; detail: string };

function pickString(value: unknown, ...path: Array<string | number>): string | null {
  let cursor: unknown = value;
  for (const step of path) {
    if (cursor === null || typeof cursor !== 'object') return null;
    cursor = (cursor as Record<string | number, unknown>)[step];
  }
  return typeof cursor === 'string' ? cursor : null;
}

function pickNumber(value: unknown, ...path: Array<string | number>): number | null {
  let cursor: unknown = value;
  for (const step of path) {
    if (cursor === null || typeof cursor !== 'object') return null;
    cursor = (cursor as Record<string | number, unknown>)[step];
  }
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : null;
}

async function runWorkersAi(
  env: Env,
  model: string,
  request: InferenceRequest,
): Promise<RunOutcome> {
  if (env.AI === undefined) return { ok: false, detail: 'the AI binding disappeared' };
  let raw: unknown;
  try {
    raw = await env.AI.run(model, {
      messages: request.messages,
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    });
  } catch (error) {
    log.warn('workers ai call failed', { name: error instanceof Error ? error.name : 'Error' });
    return { ok: false, detail: 'the Workers AI call failed' };
  }
  const output = pickString(raw, 'response');
  if (output === null) return { ok: false, detail: 'the Workers AI response carried no text' };
  return {
    ok: true,
    result: {
      model,
      output,
      finishReason: null,
      usage: {
        promptTokens: pickNumber(raw, 'usage', 'prompt_tokens'),
        completionTokens: pickNumber(raw, 'usage', 'completion_tokens'),
      },
    },
  };
}

async function runUpstream(
  provider: Extract<InferenceProvider, { kind: 'upstream' }>,
  request: InferenceRequest,
): Promise<RunOutcome> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  let response: Response;
  try {
    response = await fetch(provider.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: provider.model,
        messages: request.messages,
        ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        stream: false,
      }),
      signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
    });
  } catch {
    return {
      ok: false,
      detail: `the inference upstream did not answer within ${INFERENCE_TIMEOUT_MS / 1000} s`,
    };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, detail: `the inference upstream answered HTTP ${response.status}` };
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return { ok: false, detail: 'the inference upstream did not answer with JSON' };
  }
  const output = pickString(raw, 'choices', 0, 'message', 'content');
  if (output === null)
    return { ok: false, detail: 'the inference upstream answered without a message' };
  return {
    ok: true,
    result: {
      model: pickString(raw, 'model') ?? provider.model,
      output,
      finishReason: pickString(raw, 'choices', 0, 'finish_reason'),
      usage: {
        promptTokens: pickNumber(raw, 'usage', 'prompt_tokens'),
        completionTokens: pickNumber(raw, 'usage', 'completion_tokens'),
      },
    },
  };
}

export function inferenceRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/v1/inference', requireInstall('inference'), async (c) => {
    const install = c.get('install');
    const meter = (outcome: UsageOutcome) =>
      recordUsage(c.env, {
        installId: install.installId,
        route: 'inference',
        chain: 'none',
        outcome,
        cached: false,
      });

    const provider = inferenceProvider(c.env);
    if (provider === null) {
      meter('not_configured');
      return notImplemented('inference_not_configured', NOT_CONFIGURED_DETAIL);
    }

    const parsed = await readJson(c);
    if (!parsed.ok) {
      meter('invalid');
      return badRequest('not_json', 'the body is not JSON');
    }
    const request = inferenceRequestSchema.safeParse(parsed.body);
    if (!request.success) {
      meter('invalid');
      return badRequest(
        'invalid_request',
        'body must be { messages: [{ role, content }], maxTokens?, temperature? }',
        {
          issue: request.error.issues[0]?.message ?? 'invalid',
        },
      );
    }

    const guard = await guardProxy(c, 'inference', 'inference', 'none');
    if (!guard.ok) return guard.response;

    const outcome =
      provider.kind === 'workers-ai'
        ? await runWorkersAi(c.env, provider.model, request.data)
        : await runUpstream(provider, request.data);
    if (!outcome.ok) {
      meter('upstream_error');
      return badGateway('inference_upstream_error', outcome.detail, { provider: provider.kind });
    }

    meter('ok');
    return new Response(
      JSON.stringify({
        data: outcome.result,
        source: provider.kind,
        asOf: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { ...quotaHeaders(guard.decision), 'content-type': 'application/json' },
      },
    );
  });

  return app;
}
