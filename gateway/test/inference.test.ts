import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NOT_CONFIGURED_DETAIL, inferenceProvider } from '../src/inference.js';
import { jsonResponse, mintToken, postJson, stubUpstreams } from './helpers.js';
import type { UpstreamStub } from './helpers.js';

const UPSTREAM = 'https://inference.test/v1/chat/completions';

let upstream: UpstreamStub | null = null;
let token: string;
beforeEach(async () => {
  token = (await mintToken({ scopes: ['telegram', 'inference'] })).token;
});
afterEach(() => {
  upstream?.restore();
  upstream = null;
});

const prompt = { messages: [{ role: 'user', content: 'Say hi.' }], maxTokens: 16 };

describe('inference configuration', () => {
  it('is off unless a model and either an AI binding or an upstream URL are set', () => {
    expect(inferenceProvider(env)).toBeNull();
    expect(inferenceProvider({ ...env, INFERENCE_MODEL: 'm' })).toBeNull();
    expect(inferenceProvider({ ...env, INFERENCE_URL: UPSTREAM })).toBeNull();
    expect(
      inferenceProvider({ ...env, INFERENCE_URL: 'ftp://x', INFERENCE_MODEL: 'm' }),
    ).toBeNull();
    expect(inferenceProvider({ ...env, INFERENCE_URL: UPSTREAM, INFERENCE_MODEL: 'm' })).toEqual({
      kind: 'upstream',
      model: 'm',
      url: UPSTREAM,
      apiKey: undefined,
    });
    const ai = { run: () => Promise.resolve({ response: 'x' }) };
    expect(inferenceProvider({ ...env, AI: ai, INFERENCE_MODEL: '@cf/some/model' })).toEqual({
      kind: 'workers-ai',
      model: '@cf/some/model',
    });
  });
});

describe('POST /v1/inference', () => {
  it('returns 501 when no provider is configured, after authenticating', async () => {
    upstream = stubUpstreams({});
    expect((await postJson('/v1/inference', null, prompt)).response.status).toBe(401);
    const { response, body } = await postJson('/v1/inference', token, prompt);
    expect(response.status).toBe(501);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(body).toMatchObject({ code: 'inference_not_configured', detail: NOT_CONFIGURED_DETAIL });
    expect(body.detail).toBe('no inference provider is configured on this gateway');
    expect(upstream.calls).toHaveLength(0);
  });

  it('needs the inference scope, which the default mint does not grant', async () => {
    const plain = await mintToken();
    const configured = {
      ...env,
      INFERENCE_URL: UPSTREAM,
      INFERENCE_MODEL: 'test-model',
    } as typeof env;
    const { response, body } = await postJson('/v1/inference', plain.token, prompt, {
      env: configured,
    });
    expect(response.status).toBe(403);
    expect(body).toMatchObject({ code: 'scope_missing', scope: 'inference' });
  });

  it('proxies to an OpenAI-compatible upstream under the inference quota, key never echoed', async () => {
    upstream = stubUpstreams({
      [UPSTREAM]: () =>
        jsonResponse({
          id: 'x',
          model: 'test-model-2026',
          choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        }),
    });
    const configured = {
      ...env,
      INFERENCE_URL: UPSTREAM,
      INFERENCE_MODEL: 'test-model',
      INFERENCE_API_KEY: 'sk-test-secret-key-0000',
      QUOTA_INFERENCE_PER_DAY: '1',
    } as typeof env;
    const { response, body } = await postJson('/v1/inference', token, prompt, { env: configured });
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: {
        model: 'test-model-2026',
        output: 'hi',
        finishReason: 'stop',
        usage: { promptTokens: 5, completionTokens: 1 },
      },
      source: 'upstream',
    });
    expect(typeof body.asOf).toBe('string');
    expect(response.headers.get('x-ratelimit-limit')).toBe('1');
    expect(JSON.stringify(body)).not.toContain('sk-test');
    expect(upstream.calls[0]!.headers.authorization).toBe('Bearer sk-test-secret-key-0000');
    expect(upstream.calls[0]!.body).toMatchObject({
      model: 'test-model',
      messages: prompt.messages,
      max_tokens: 16,
      stream: false,
    });

    const over = await postJson('/v1/inference', token, prompt, { env: configured });
    expect(over.response.status).toBe(429);
    expect(over.body).toMatchObject({ code: 'quota_exceeded', quota: 'inference', limit: 1 });
    expect(upstream.calls).toHaveLength(1);
  });

  it('uses the AI binding when bound and reports its failures as 502', async () => {
    const calls: unknown[] = [];
    const ai = {
      run: (model: string, inputs: unknown) => {
        calls.push([model, inputs]);
        return Promise.resolve({
          response: 'from workers ai',
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        });
      },
    };
    const configured = { ...env, AI: ai, INFERENCE_MODEL: '@cf/meta/some-model' } as typeof env;
    const { response, body } = await postJson('/v1/inference', token, prompt, { env: configured });
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: {
        model: '@cf/meta/some-model',
        output: 'from workers ai',
        usage: { promptTokens: 3, completionTokens: 4 },
      },
      source: 'workers-ai',
    });
    expect(calls).toEqual([['@cf/meta/some-model', { messages: prompt.messages, max_tokens: 16 }]]);

    const broken = {
      ...env,
      AI: { run: () => Promise.reject(new Error('neurons exhausted')) },
      INFERENCE_MODEL: 'm',
    } as typeof env;
    const failed = await postJson('/v1/inference', token, prompt, { env: broken });
    expect(failed.response.status).toBe(502);
    expect(failed.body).toMatchObject({ code: 'inference_upstream_error', provider: 'workers-ai' });
  });

  it('validates the body', async () => {
    const configured = {
      ...env,
      INFERENCE_URL: UPSTREAM,
      INFERENCE_MODEL: 'test-model',
    } as typeof env;
    upstream = stubUpstreams({});
    expect((await postJson('/v1/inference', token, '{', { env: configured })).body.code).toBe(
      'not_json',
    );
    expect(
      (await postJson('/v1/inference', token, { messages: [] }, { env: configured })).body.code,
    ).toBe('invalid_request');
    expect(
      (
        await postJson(
          '/v1/inference',
          token,
          { messages: [{ role: 'tool', content: 'x' }] },
          { env: configured },
        )
      ).body.code,
    ).toBe('invalid_request');
    expect(
      (
        await postJson(
          '/v1/inference',
          token,
          { ...prompt, model: 'gpt-anything' },
          { env: configured },
        )
      ).body.code,
    ).toBe('invalid_request');
    expect(upstream.calls).toHaveLength(0);
  });
});
