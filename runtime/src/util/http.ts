import { AppError, ErrorCode } from './errors.js';

/**
 * Bounded HTTP body reading.
 *
 * `response.json()` buffers the entire body before parsing, so an upstream
 * that answers with a gigabyte (by accident, by compromise, or because someone
 * sits between ATRA and it) makes the runtime allocate a gigabyte. Every
 * external fetch goes through {@link readJsonBounded} instead, which refuses
 * a body larger than the caller's cap before a byte of it is parsed.
 */

/**
 * Read and parse a JSON body, refusing anything larger than `maxBytes`.
 *
 * The cap is enforced twice: against `content-length` when the server
 * declares one, and again while streaming, because the header is optional
 * and not always honest. An oversized body is cancelled mid-stream and
 * surfaces as UPSTREAM_UNAVAILABLE, the same class of failure as an endpoint
 * that answers with garbage.
 *
 * A body that fits but is not valid JSON raises the same `SyntaxError` that
 * `response.json()` would, so each caller keeps wrapping it with its own
 * context exactly as before.
 */
export async function readJsonBounded(response: Response, maxBytes: number): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new AppError(ErrorCode.INTERNAL, 'readJsonBounded requires a positive byte cap');
  }

  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw tooLarge(maxBytes, length);
    }
  }

  const body = response.body;
  if (body === null) {
    // No body at all, e.g. a 204 or a synthetic Response. JSON.parse reports
    // the empty string the same way response.json() would have.
    return JSON.parse('') as unknown;
  }

  // Typed explicitly: the DOM lib types a Response body as ReadableStream<any>,
  // which would make every read below an `any` in a strict codebase.
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = '';
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      received += value.byteLength;
      if (received > maxBytes) {
        // Stop the transfer rather than draining it: the point of the cap is
        // to spend neither the memory nor the bandwidth.
        await reader.cancel().catch(() => undefined);
        throw tooLarge(maxBytes, received);
      }

      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  text += decoder.decode();
  return JSON.parse(text) as unknown;
}

function tooLarge(maxBytes: number, observedBytes: number): AppError {
  return new AppError(
    ErrorCode.UPSTREAM_UNAVAILABLE,
    `response larger than ${String(maxBytes)} bytes`,
    { details: { maxBytes, observedBytes } },
  );
}
