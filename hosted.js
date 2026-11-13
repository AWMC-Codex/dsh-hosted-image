// Transport for sub2api's "hosted image" Responses contract.
//
// Everything here is plain HTTP + SSE plus byte-level image sniffing: no DSH imports, so
// the whole module is unit-testable with `node --test`.
//
// The contract this module satisfies (see sub2api HOSTED_IMAGE_ROLLOUT.md):
//   POST <baseURL>/responses
//   Authorization: Bearer <main key>
//   Idempotency-Key: <stable per logical request>
//   { "model": …, "input": …, "tools": [{ "type": "image_generation", … }], "stream": true }
// The response is SSE. The image arrives as an `image_generation_call` output item whose
// `result` is base64; `response.completed` closes the operation.

import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const DEFAULT_TIMEOUT_MS = 270_000;
const MAX_RESULT_BYTES = 24 * 1024 * 1024;
const MAX_DIMENSION = 8192;

/**
 * The gateway sits behind an upstream that 403s requests with no `User-Agent` (and 403s
 * Python-urllib's default one), which sub2api's error mapper reports as a 502
 * "Upstream access forbidden". `node:http` adds no UA, so we must name ourselves.
 */
export const USER_AGENT = 'dsh-hosted-image/0.1.0';

/** Sizes the contract accepts. It normalises each to a `1K`/`2K`/`4K` resolution hint. */
export const SIZES = ['1024x1024', '2048x2048', '4096x4096'];
export const QUALITIES = ['auto', 'low', 'medium', 'high'];
export const BACKGROUNDS = ['auto', 'opaque', 'transparent'];
export const OUTPUT_FORMATS = ['png', 'jpeg', 'webp'];

/** Build the request body. Image options ride the tool declaration, never the top level. */
export function buildRequestBody({ model, prompt, size, quality, background, outputFormat, moderation, outputCompression, forceToolChoice = true }) {
  const tool = { type: 'image_generation' };
  if (size) tool.size = size;
  if (quality) tool.quality = quality;
  if (background) tool.background = background;
  if (outputFormat) tool.output_format = outputFormat;
  if (moderation) tool.moderation = moderation;
  if (outputCompression !== undefined && outputCompression !== null) tool.output_compression = outputCompression;
  const body = { model, input: prompt, tools: [tool], stream: true };
  if (forceToolChoice) body.tool_choice = { type: 'image_generation' };
  return body;
}

/**
 * Derive the Idempotency-Key.
 *
 * Same logical request → same key, so a retry (plugin-level retry, a tool-call timeout, a
 * user re-asking for the same picture) is served from the server's idempotency store and
 * costs nothing. Changing the prompt/size/options, or passing `regenerate`, fords a new key.
 */
export function deriveIdempotencyKey({ sessionId, model, prompt, size, quality, background, outputFormat, regenerate, callId, random }) {
  const material = JSON.stringify([
    sessionId ?? '',
    model ?? '',
    prompt ?? '',
    size ?? '',
    quality ?? '',
    background ?? '',
    outputFormat ?? '',
  ]);
  const salt = regenerate ? String(callId ?? random ?? '') : '';
  const digest = createHash('sha256').update(`${material}\u0000${salt}`).digest('base64url').slice(0, 32);
  return `dsh-img-${digest}`;
}

/**
 * Parse an SSE byte stream into decoded JSON events (async generator).
 * - `:` comment lines (the contract's 10s keepalives) are skipped, but reported through `onComment`
 * - multi-line `data:` fields are joined with `\n`
 * - `[DONE]` is skipped
 * - invalid JSON yields `{ __unparsable }` instead of throwing, so one bad frame is survivable
 */
export async function* parseSse(body, { onComment } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.startsWith(':')) {
        onComment?.(line);
        continue;
      }
      if (line === '') {
        if (data.length === 0) continue;
        const raw = data.join('\n');
        data = [];
        if (raw === '[DONE]') continue;
        try {
          yield JSON.parse(raw);
        } catch {
          yield { __unparsable: raw };
        }
        continue;
      }
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      // `event:` lines are ignored: the payload's own `type` field is authoritative.
    }
  }
}

// -------------------------------------------------------------- image sniffing

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Detect media type and pixel dimensions from magic bytes; undefined when unsupported. */
export function sniffImage(buffer) {
  if (buffer.length >= 24 && PNG_SIGNATURE.every((byte, i) => buffer[i] === byte)) {
    return { mediaType: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    let i = 2;
    while (i + 9 < buffer.length) {
      if (buffer[i] !== 0xff) { i += 1; continue; }
      const marker = buffer[i + 1];
      const length = buffer.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mediaType: 'image/jpeg', height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
      }
      i += 2 + length;
    }
    return { mediaType: 'image/jpeg', width: 0, height: 0 };
  }
  if (buffer.length >= 16 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const format = buffer.toString('ascii', 12, 16);
    if (format === 'VP8X') return { mediaType: 'image/webp', width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    if (format === 'VP8 ') return { mediaType: 'image/webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    if (format === 'VP8L') {
      const bits = buffer.readUInt32LE(21);
      return { mediaType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { mediaType: 'image/webp', width: 0, height: 0 };
  }
  return undefined;
}

/** Decode `image_generation_call.result` (raw base64 or a data: URL) into PNG/JPEG/WebP bytes. */
export function decodeImageResult(result) {
  if (typeof result !== 'string' || result.length === 0) throw hostedError(0, 'hosted_image_missing', 'the response item carried no result bytes');
  let base64 = result;
  const dataUrl = /^data:image\/(?:png|jpeg|webp);base64,(.*)$/s.exec(result);
  if (dataUrl !== null) base64 = dataUrl[1];
  if (base64.length > MAX_RESULT_BYTES) throw hostedError(0, 'hosted_image_too_large', 'the image exceeded the 24MB transport cap');
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) throw hostedError(0, 'hosted_image_format_invalid', 'the image decoded to zero bytes');
  if (buffer.toString('base64') !== base64) throw hostedError(0, 'hosted_image_format_invalid', 'the image payload was not canonical base64');
  const info = sniffImage(buffer);
  if (info === undefined) throw hostedError(0, 'hosted_image_format_invalid', 'the image was not PNG/JPEG/WebP');
  if (info.width <= 0 || info.height <= 0) throw hostedError(0, 'hosted_image_format_invalid', 'the image dimensions could not be read');
  if (info.width > MAX_DIMENSION || info.height > MAX_DIMENSION) {
    throw hostedError(0, 'hosted_image_dimensions_invalid', `the image is ${info.width}x${info.height}, above the ${MAX_DIMENSION}px limit`);
  }
  return { buffer, ...info };
}

// --------------------------------------------------------------------- errors

const EXPLANATIONS = {
  hosted_image_idempotency_key_required: 'the request went out without an Idempotency-Key (plugin bug)',
  invalid_idempotency_key: 'the Idempotency-Key was longer than 128 characters or padded (plugin bug)',
  idempotency_payload_conflict: 'a different request already used this idempotency key; nothing was generated',
  hosted_request_requires_reconciliation: 'the previous attempt has an unresolved billing state — an operator must reconcile it, do NOT retry with a new key',
  hosted_image_arguments_invalid: 'the parent model produced an unusable prompt (empty or over 16000 characters)',
  hosted_image_size_conflict: 'the requested size conflicts with the tool declaration',
  unsupported_image_size: 'size must be 1024x1024, 2048x2048 or 4096x4096',
  transparent_jpeg_not_supported: 'a transparent background cannot be combined with jpeg output',
  image_compression_requires_jpeg_or_webp: 'output_compression requires jpeg or webp',
  hosted_image_edit_not_supported: 'image editing is not supported — only generation',
  multiple_image_tools_unsupported: 'exactly one image_generation tool may be declared',
  hosted_image_too_large: 'the generated image exceeded the 24MB transport cap',
  hosted_image_format_invalid: 'the generated image was not PNG/JPEG/WebP',
  image_tool_configuration_unavailable: 'this main key has no hosted-image binding; bind an image key on the Keys page first',
  image_tool_key_unavailable: 'the bound image key is missing, disabled or out of quota',
  hosted_image_child_failed: 'the image provider call failed; nothing was generated',
  hosted_main_response_invalid: 'the parent model did not complete the response',
  hosted_stream_incomplete: 'the stream ended before a terminal response event',
  hosted_image_missing: 'the response carried no image_generation_call item',
  hosted_image_not_completed: 'the image item did not reach the completed state',
  hosted_image_dimensions_invalid: 'the generated image exceeded the 8192px limit',
  upstream_error: 'the endpoint rejected the request upstream (see message)',
};

/** Turn a contract error envelope (or a local failure) into an Error with a stable `code`. */
export function hostedError(status, code, detail) {
  const explanation = EXPLANATIONS[code];
  const suffix = detail === undefined ? '' : ` (${detail})`;
  const error = new Error(`${code}${explanation === undefined ? '' : ` — ${explanation}`}${suffix}`);
  error.code = code;
  error.status = status;
  error.reconcile = code === 'hosted_request_requires_reconciliation' || status === 409;
  return error;
}

function errorFromPayload(status, payload) {
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { parsed = undefined; }
    if (parsed !== undefined) return errorFromPayload(status, parsed);
    return hostedError(status, 'upstream_error', trimmed.slice(0, 300));
  }
  const envelope = payload?.error ?? payload;
  const code = typeof envelope?.code === 'string' ? envelope.code : undefined;
  if (code !== undefined) return hostedError(status, code, typeof envelope.message === 'string' && envelope.message !== code ? envelope.message : undefined);
  const message = typeof envelope?.message === 'string' ? envelope.message : 'request failed';
  const error = hostedError(status, 'upstream_error', message.slice(0, 300));
  if (typeof envelope?.type === 'string') error.type = envelope.type;
  return error;
}

// -------------------------------------------------------------------- transport

/**
 * Minimal `fetch`-shaped client built on `node:http`/`node:https`.
 *
 * We deliberately avoid `globalThis.fetch`: harness plugins such as ACP / compression plugins replace
 * it with an intercepting compression proxy that matches any URL ending in `/responses`
 * (`MODEL_API_SUFFIX`) and turns a long image generation into a fabricated
 * `upstream_stream_truncated` event. Talking to the socket directly keeps the tool honest —
 * what we send is what the server sees, and what the server streams is what we parse.
 */
function transportFetch(url, init = {}) {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const send = secure ? httpsRequest : httpRequest;
  const headers = {};
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    if (value !== undefined && value !== null) headers[name] = String(value);
  }
  const payload = init.body === undefined ? undefined : Buffer.from(String(init.body), 'utf8');
  if (payload !== undefined) headers['content-length'] = String(payload.byteLength);

  return new Promise((resolve, reject) => {
    const req = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port === '' ? undefined : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: init.method ?? 'GET',
        headers,
        signal: init.signal,
      },
      (res) => {
        const headerMap = new Map();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          headerMap.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
        }
        const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
        resolve({
          status: res.statusCode ?? 0,
          ok,
          headers: { get: (name) => headerMap.get(String(name).toLowerCase()) ?? null },
          body: res,
          text: async () => {
            const parts = [];
            for await (const chunk of res) parts.push(Buffer.from(chunk));
            return Buffer.concat(parts).toString('utf8');
          },
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/**
 * Run one hosted-image operation and return the decoded image plus the terminal response.
 *
 * Streaming is mandatory in production: Cloudflare closes idle connections at 125s and only
 * the orchestrator's `: keepalive` comments keep bytes flowing while the provider works.
 */
export async function requestHostedImage({
  baseURL,
  apiKey,
  model,
  prompt,
  size,
  quality,
  background,
  outputFormat,
  moderation,
  outputCompression,
  idempotencyKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  forceToolChoice = true,
  fetch: fetchImpl,
  signal,
  onProgress,
}) {
  if (typeof baseURL !== 'string' || baseURL.length === 0) throw new Error('a hosted-image baseURL is required');
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('a hosted-image API key is required');
  // Never let `fetch` stringify a missing key into the literal "undefined": the server
  // would accept that header and only fail later, after paid work has begun.
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '' || idempotencyKey !== idempotencyKey.trim()) {
    throw hostedError(0, 'hosted_image_idempotency_key_required', 'the plugin produced no usable Idempotency-Key');
  }
  if (idempotencyKey.length > 128) throw hostedError(0, 'invalid_idempotency_key', 'the key exceeded 128 characters');
  const endpoint = `${baseURL.replace(/\/+$/u, '')}/responses`;
  const body = buildRequestBody({ model, prompt, size, quality, background, outputFormat, moderation, outputCompression, forceToolChoice });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`the hosted image operation exceeded ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal !== undefined) signal.addEventListener('abort', forwardAbort, { once: true });

  let response;
  try {
    onProgress?.({ phase: 'request' });
    response = await (fetchImpl ?? transportFetch)(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        // `node:http` sends no User-Agent of its own, and the gateway rejects UA-less requests
        // with a 502 "Upstream access forbidden" that looks like an auth problem but is not.
        'user-agent': USER_AGENT,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    if (signal !== undefined) signal.removeEventListener('abort', forwardAbort);
  }

  const replayed = String(response.headers.get('idempotent-replayed') ?? '').toLowerCase() === 'true';
  const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();

  if (!contentType.includes('text/event-stream')) {
    // A non-streaming reply is either the JSON form of the same result or an error envelope.
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    if (!response.ok) throw errorFromPayload(response.status, parsed ?? text);
    return collectFromJson(parsed, { status: response.status, replayed, idempotencyKey, body });
  }

  onProgress?.({ phase: 'stream' });
  let terminal;
  let streamError;
  let lastItem;
  let keepalives = 0;
  for await (const event of parseSse(response.body, { onComment: () => { keepalives += 1; } })) {
    if (event.__unparsable !== undefined) continue;
    const type = event.type;
    if (type === 'response.output_item.done' && event.item?.type === 'image_generation_call') lastItem = event.item;
    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') terminal = event.response;
    if (type === 'error') streamError = event;
  }
  if (streamError !== undefined) throw errorFromPayload(response.status, streamError);
  if (terminal === undefined) throw hostedError(response.status, 'hosted_stream_incomplete');

  const item = (terminal.output ?? []).find((entry) => entry?.type === 'image_generation_call') ?? lastItem;
  if (item === undefined) throw hostedError(response.status, 'hosted_image_missing');
  if (item.status !== 'completed') throw hostedError(response.status, 'hosted_image_not_completed', String(item.status ?? 'unknown'));

  const decoded = decodeImageResult(item.result);
  return {
    status: response.status,
    replayed,
    idempotencyKey,
    keepalives,
    terminalStatus: terminal.status,
    terminalId: terminal.id,
    usage: terminal.usage ?? undefined,
    image: decoded,
    request: { body, streamed: true },
  };
}

function collectFromJson(payload, context) {
  if (payload === undefined || payload === null) throw hostedError(context.status, 'upstream_error', 'the endpoint returned a non-JSON body');
  const item = (payload.output ?? []).find((entry) => entry?.type === 'image_generation_call');
  if (item === undefined) throw hostedError(context.status, 'hosted_image_missing');
  if (item.status !== 'completed') throw hostedError(context.status, 'hosted_image_not_completed', String(item.status ?? 'unknown'));
  const decoded = decodeImageResult(item.result);
  return {
    status: context.status,
    replayed: context.replayed,
    idempotencyKey: context.idempotencyKey,
    keepalives: 0,
    terminalStatus: payload.status,
    terminalId: payload.id,
    usage: payload.usage ?? undefined,
    image: decoded,
    request: { body: context.body, streamed: false },
  };
}
