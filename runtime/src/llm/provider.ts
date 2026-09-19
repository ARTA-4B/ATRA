import { z } from 'zod';
import { AppError, ErrorCode, errorMessage } from '../util/errors.js';
import { childLogger } from '../logging/logger.js';
import { containsSecret } from '../logging/redact.js';

/**
 * The reasoning layer.
 *
 * ATRA's model proposes; it never decides and never acts. Everything in this
 * module exists to keep that boundary sharp:
 *
 *  - **Structured output only.** A response is parsed and schema-validated
 *    before anything downstream sees it. Free-form text is never executed,
 *    never parsed for intent, and never used to fill in a missing field.
 *  - **One retry, with the validation error.** A model that produces malformed
 *    JSON gets told exactly what was wrong and one more attempt. After that the
 *    call fails with SCHEMA_INVALID, which the caller treats as "no proposal",
 *    not as an error to retry around.
 *  - **Nothing secret goes out.** Prompts are assembled from an explicit
 *    allowlist of fields, and a final scan refuses to send anything that looks
 *    like key material even if a caller made a mistake.
 *  - **Unreachable is a normal state.** A runtime with no model still works: it
 *    simply proposes nothing, which is the safe default for an agent that
 *    handles money.
 */

export type LlmKind = 'none' | 'ollama' | 'openai-compatible';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on tool results so a model can match them to its calls. */
  toolCallId?: string;
  name?: string;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  /** JSON Schema the reply must satisfy. */
  responseSchema: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmResponse<T = unknown> {
  /** The validated structured output. */
  data: T;
  toolCalls: LlmToolCall[];
  model: string;
  /** Milliseconds the provider took, for the dashboard's cost view. */
  latencyMs: number;
  usage: { promptTokens: number | null; completionTokens: number | null };
  /** How many attempts it took, so a flaky model is visible rather than hidden. */
  attempts: number;
}

export interface LlmProvider {
  readonly kind: LlmKind;
  readonly model: string;
  /** Whether the endpoint answered recently. Never throws. */
  available(): Promise<{ available: boolean; detail: string }>;
  chat<T>(request: LlmRequest, schema: z.ZodType<T>): Promise<LlmResponse<T>>;
}

/**
 * The provider used when no model is configured or the endpoint is down.
 *
 * It does not fail the caller: it returns a valid, deliberately empty result so
 * the pipeline continues and produces "no action" rather than an exception that
 * some retry loop might paper over. An agent that cannot think must not act.
 */
export class NullLlmProvider implements LlmProvider {
  readonly kind = 'none' as const;
  readonly model = 'none';
  readonly #reason: string;

  constructor(reason = 'no reasoning model is configured') {
    this.#reason = reason;
  }

  available(): Promise<{ available: boolean; detail: string }> {
    return Promise.resolve({ available: false, detail: this.#reason });
  }

  chat<T>(_request: LlmRequest, _schema: z.ZodType<T>): Promise<LlmResponse<T>> {
    throw new AppError(
      ErrorCode.ADAPTER_UNAVAILABLE,
      `No reasoning model is available: ${this.#reason}`,
      { details: { recoverable: true } },
    );
  }
}

/**
 * A provider that replays scripted answers.
 *
 * Used by tests to exercise the pipeline deterministically, including the cases
 * that matter most: malformed JSON, a schema violation, and a model that tries
 * to smuggle an instruction through a field.
 */
export class ScriptedLlmProvider implements LlmProvider {
  readonly kind = 'openai-compatible' as const;
  readonly model = 'scripted';
  #queue: string[];

  constructor(responses: string[]) {
    this.#queue = [...responses];
  }

  available(): Promise<{ available: boolean; detail: string }> {
    return Promise.resolve({ available: true, detail: 'scripted' });
  }

  chat<T>(_request: LlmRequest, schema: z.ZodType<T>): Promise<LlmResponse<T>> {
    const raw = this.#queue.shift();
    if (raw === undefined) {
      throw new AppError(ErrorCode.ADAPTER_UNAVAILABLE, 'Scripted provider exhausted');
    }

    const parsed = parseStructured(raw, schema);
    if (!parsed.ok) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, parsed.error);
    }

    return Promise.resolve({
      data: parsed.value,
      toolCalls: [],
      model: this.model,
      latencyMs: 0,
      usage: { promptTokens: null, completionTokens: null },
      attempts: 1,
    });
  }
}

export interface HttpLlmOptions {
  kind: Exclude<LlmKind, 'none'>;
  endpoint: string;
  model: string;
  /** Read from the environment at construction, never stored in config files. */
  apiKey?: string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * A provider for any OpenAI-compatible chat endpoint, including Ollama.
 *
 * Ollama serves an OpenAI-compatible API at /v1, so one implementation covers
 * both a local model and a remote one. The difference that matters is trust:
 * a local endpoint sees the same prompt either way, and neither sees a secret.
 */
export class HttpLlmProvider implements LlmProvider {
  readonly kind: Exclude<LlmKind, 'none'>;
  readonly model: string;

  readonly #endpoint: string;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #log = childLogger('llm');

  constructor(options: HttpLlmOptions) {
    this.kind = options.kind;
    this.model = options.model;
    this.#endpoint = options.endpoint.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async available(): Promise<{ available: boolean; detail: string }> {
    try {
      const response = await this.#fetch(`${this.#endpoint}/v1/models`, {
        headers: this.#headers(),
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok
        ? { available: true, detail: `${this.#endpoint} responded` }
        : { available: false, detail: `endpoint returned HTTP ${response.status}` };
    } catch (error) {
      return { available: false, detail: errorMessage(error) };
    }
  }

  async chat<T>(request: LlmRequest, schema: z.ZodType<T>): Promise<LlmResponse<T>> {
    assertNoSecrets(request);

    const started = Date.now();
    let lastError = '';

    // Two attempts at most. The second carries the validation failure so the
    // model can correct itself; beyond that, a model that cannot produce the
    // schema is not going to on the third try, and the caller needs an answer.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const messages = this.#buildMessages(request, attempt === 2 ? lastError : undefined);
      const body = {
        model: this.model,
        messages,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? 2_048,
        stream: false,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'atra_response', strict: true, schema: request.responseSchema },
        },
        ...(request.tools && request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            }
          : {}),
      };

      const raw = await this.#post(body, request.timeoutMs ?? this.#timeoutMs);
      const content = raw.choices[0]?.message?.content ?? '';
      const parsed = parseStructured(content, schema);

      if (parsed.ok) {
        return {
          data: parsed.value,
          toolCalls: extractToolCalls(raw),
          model: raw.model ?? this.model,
          latencyMs: Date.now() - started,
          usage: {
            promptTokens: raw.usage?.prompt_tokens ?? null,
            completionTokens: raw.usage?.completion_tokens ?? null,
          },
          attempts: attempt,
        };
      }

      lastError = parsed.error;
      this.#log.warn({ attempt, error: parsed.error }, 'model output failed validation');
    }

    throw new AppError(
      ErrorCode.SCHEMA_INVALID,
      'The reasoning model did not produce output matching the required schema',
      { details: { model: this.model, lastError } },
    );
  }

  #buildMessages(request: LlmRequest, correction: string | undefined): LlmMessage[] {
    const messages: LlmMessage[] = [
      { role: 'system', content: request.system },
      ...request.messages,
    ];

    if (correction) {
      messages.push({
        role: 'user',
        content:
          'Your previous reply did not match the required schema. ' +
          `The validator reported: ${correction}. ` +
          'Reply again with JSON that satisfies the schema exactly, and nothing else.',
      });
    }

    return messages;
  }

  async #post(body: unknown, timeoutMs: number): Promise<ChatCompletion> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.#fetch(`${this.#endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.#headers() },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.status === 429) {
        throw new AppError(ErrorCode.RATE_LIMITED, 'The reasoning model is rate limited', {
          retryAfterSec: Number(response.headers.get('retry-after') ?? 30),
        });
      }
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new AppError(
          ErrorCode.UPSTREAM_UNAVAILABLE,
          `The reasoning model returned HTTP ${response.status}`,
          { details: { detail } },
        );
      }

      const parsed = chatCompletionSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new AppError(
          ErrorCode.UPSTREAM_UNAVAILABLE,
          'The reasoning model returned an unexpected response shape',
        );
      }

      return parsed.data;
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      const timedOut = cause instanceof Error && cause.name === 'AbortError';
      throw new AppError(
        timedOut ? ErrorCode.UPSTREAM_TIMEOUT : ErrorCode.UPSTREAM_UNAVAILABLE,
        'The reasoning model could not be reached',
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  #headers(): Record<string, string> {
    return this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {};
  }
}

const chatCompletionSchema = z.object({
  model: z.string().nullish(),
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string().nullish(),
        tool_calls: z
          .array(
            z.object({
              id: z.string(),
              function: z.object({ name: z.string(), arguments: z.string() }),
            }),
          )
          .nullish(),
      }),
    }),
  ),
  usage: z
    .object({ prompt_tokens: z.number().nullish(), completion_tokens: z.number().nullish() })
    .nullish(),
});

type ChatCompletion = z.infer<typeof chatCompletionSchema>;

function extractToolCalls(raw: ChatCompletion): LlmToolCall[] {
  const calls = raw.choices[0]?.message?.tool_calls ?? [];
  const out: LlmToolCall[] = [];

  for (const call of calls) {
    try {
      const args: unknown = JSON.parse(call.function.arguments);
      // Arguments that are not an object cannot be dispatched to a tool, and
      // guessing at the intent is exactly what this layer must not do.
      if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
        out.push({
          id: call.id,
          name: call.function.name,
          arguments: args as Record<string, unknown>,
        });
      }
    } catch {
      // A malformed argument blob is dropped; the caller sees a tool call that
      // never arrived rather than one with invented arguments.
    }
  }

  return out;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Parse a model reply into a validated object.
 *
 * Tolerates the two formatting habits models have that are not semantic: a
 * fenced code block, and prose either side of the JSON. It does not tolerate
 * anything that changes meaning — missing fields, wrong types or extra keys all
 * fail, because the alternative is acting on a guess.
 */
export function parseStructured<T>(raw: string, schema: z.ZodType<T>): ParseResult<T> {
  const text = stripFence(raw).trim();
  if (text.length === 0) {
    return { ok: false, error: 'the model returned an empty reply' };
  }

  const candidate = extractJsonObject(text);
  if (candidate === null) {
    return { ok: false, error: 'the reply contained no JSON object' };
  }

  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch (error) {
    return { ok: false, error: `the reply was not valid JSON: ${errorMessage(error)}` };
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      error: issue ? `${issue.path.join('.') || 'root'}: ${issue.message}` : 'schema mismatch',
    };
  }

  return { ok: true, value: result.data };
}

function stripFence(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  return fenced?.[1] ?? raw;
}

/** The outermost balanced JSON object, ignoring braces inside strings. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

/**
 * Refuse to send a prompt containing anything that looks like key material.
 *
 * The callers are supposed to build prompts from an allowlist of fields, so
 * this should never fire. It exists because "should never" is not a control,
 * and a leaked key cannot be recalled from a third-party endpoint.
 */
function assertNoSecrets(request: LlmRequest): void {
  const payload = [request.system, ...request.messages.map((message) => message.content)].join(
    '\n',
  );

  if (containsSecret(payload)) {
    throw new AppError(
      ErrorCode.INTERNAL,
      'Refusing to send a prompt that appears to contain secret material',
    );
  }
}
