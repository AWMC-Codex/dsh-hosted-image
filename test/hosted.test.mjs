// Transport-level tests: request body, idempotency key, SSE framing, image decoding,
// error mapping, and one end-to-end request against a local mock of the contract.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import {
  buildRequestBody,
  decodeImageResult,
  deriveIdempotencyKey,
  hostedError,
  parseSse,
  requestHostedImage,
  sniffImage,
} from '../hosted.js';

// 1x1 opaque PNG.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function sseFrame(type, value) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: 1, ...value })}\n\n`;
}

async function* chunksOf(values) {
  for (const value of values) yield Buffer.from(value, 'utf8');
}

// ------------------------------------------------------------------ buildRequestBody

test('buildRequestBody puts image options on the tool and streams', () => {
  const body = buildRequestBody({
    model: 'example-main-model',
    prompt: 'a blue robot',
    size: '1024x1024',
    quality: 'low',
    outputFormat: 'png',
  });
  assert.equal(body.model, 'example-main-model');
  assert.equal(body.input, 'a blue robot');
  assert.equal(body.stream, true);
  assert.deepEqual(body.tools, [
    { type: 'image_generation', size: '1024x1024', quality: 'low', output_format: 'png' },
  ]);
  assert.deepEqual(body.tool_choice, { type: 'image_generation' });
  assert.equal(body.size, undefined, 'size must not be duplicated at the top level');
});

test('buildRequestBody can omit tool_choice', () => {
  const body = buildRequestBody({ model: 'm', prompt: 'p', forceToolChoice: false });
  assert.equal(body.tool_choice, undefined);
  assert.deepEqual(body.tools, [{ type: 'image_generation' }]);
});

// --------------------------------------------------------------- deriveIdempotencyKey

test('deriveIdempotencyKey is stable for the same logical request', () => {
  const input = {
    sessionId: 'session-1',
    model: 'example-main-model',
    prompt: 'a blue robot',
    size: '1024x1024',
  };
  const first = deriveIdempotencyKey(input);
  const second = deriveIdempotencyKey({ ...input });
  assert.equal(first, second);
  assert.match(first, /^dsh-img-[A-Za-z0-9_-]{32}$/u);
  assert.ok(first.length <= 128);
});

test('deriveIdempotencyKey forks on any material change', () => {
  const base = { sessionId: 's', model: 'm', prompt: 'a blue robot', size: '1024x1024' };
  const key = deriveIdempotencyKey(base);
  assert.notEqual(deriveIdempotencyKey({ ...base, prompt: 'a red robot' }), key);
  assert.notEqual(deriveIdempotencyKey({ ...base, size: '2048x2048' }), key);
  assert.notEqual(deriveIdempotencyKey({ ...base, quality: 'high' }), key);
  assert.notEqual(deriveIdempotencyKey({ ...base, sessionId: 'other' }), key);
});

test('deriveIdempotencyKey honours regenerate', () => {
  const base = { sessionId: 's', model: 'm', prompt: 'p', size: '1024x1024', callId: 'call-9' };
  const key = deriveIdempotencyKey(base);
  assert.equal(deriveIdempotencyKey({ ...base }), key);
  assert.notEqual(deriveIdempotencyKey({ ...base, regenerate: true }), key);
});

// ------------------------------------------------------------------------- parseSse

test('parseSse skips comments and [DONE], keeps multi-line data', async () => {
  const comments = [];
  const frames = [
    ': keepalive\n\n',
    'event: response.created\ndata: {"type":"response.created"}\n\n',
    'data: {"type":"response.completed",\n',
    'data:   "id":"resp_1"}\n\n',
    'data: [DONE]\n\n',
  ];
  const events = [];
  for await (const event of parseSse(chunksOf(frames), { onComment: (line) => comments.push(line) })) {
    events.push(event);
  }
  assert.equal(comments.length, 1);
  assert.equal(comments[0], ': keepalive');
  assert.deepEqual(events, [
    { type: 'response.created' },
    { type: 'response.completed', id: 'resp_1' },
  ]);
});

test('parseSse survives an unparsable frame', async () => {
  const events = [];
  for await (const event of parseSse(chunksOf(['data: {not json}\n\n']))) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0].__unparsable, '{not json}');
});

// ------------------------------------------------------------- image byte handling

test('sniffImage reads PNG dimensions', () => {
  assert.deepEqual(sniffImage(PNG_1X1), { mediaType: 'image/png', width: 1, height: 1 });
});

test('decodeImageResult accepts raw base64', () => {
  const decoded = decodeImageResult(PNG_1X1.toString('base64'));
  assert.equal(decoded.mediaType, 'image/png');
  assert.equal(decoded.width, 1);
  assert.deepEqual(decoded.buffer, PNG_1X1);
});

test('decodeImageResult accepts a data URL', () => {
  const decoded = decodeImageResult(`data:image/png;base64,${PNG_1X1.toString('base64')}`);
  assert.equal(decoded.mediaType, 'image/png');
  assert.deepEqual(decoded.buffer, PNG_1X1);
});

test('decodeImageResult rejects non-canonical base64 and unknown formats', () => {
  const padded = `${PNG_1X1.toString('base64')}\n`;
  assert.throws(() => decodeImageResult(padded), /not canonical base64/u);
  assert.throws(() => decodeImageResult(Buffer.from('hello world').toString('base64')), /not PNG\/JPEG\/WebP/u);
  assert.throws(() => decodeImageResult(''), /no result bytes/u);
});

// -------------------------------------------------------------------- error mapping

test('hostedError explains known codes and flags reconciliation', () => {
  const conflict = hostedError(409, 'idempotency_payload_conflict');
  assert.match(conflict.message, /different request already used this idempotency key/u);
  assert.equal(conflict.reconcile, true);

  const uncertain = hostedError(409, 'hosted_request_requires_reconciliation');
  assert.equal(uncertain.reconcile, true);

  const plain = hostedError(400, 'unsupported_image_size');
  assert.match(plain.message, /1024x1024, 2048x2048 or 4096x4096/u);
  assert.equal(plain.reconcile, false);
});

// ------------------------------------------------------------- end-to-end transport

function startMock({ image = PNG_1X1, keepalive = true, replay = false, terminal = 'completed' } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push({ headers: req.headers, body: JSON.parse(body) });
      if (req.headers['idempotency-key'] === undefined) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'hosted_image_error', code: 'hosted_image_idempotency_key_required', message: 'hosted_image_idempotency_key_required' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', ...(replay ? { 'idempotent-replayed': 'true' } : {}) });
      res.write(sseFrame('response.created', { response: { id: 'resp_1', status: 'in_progress', output: [] } }));
      if (keepalive) res.write(': keepalive\n\n');
      res.write(sseFrame('response.output_item.added', { output_index: 0, item: { id: 'ig_1', type: 'image_generation_call', status: 'in_progress' } }));
      res.write(sseFrame('response.output_item.done', {
        output_index: 0,
        item: terminal === 'completed'
          ? { id: 'ig_1', type: 'image_generation_call', status: 'completed', result: image.toString('base64') }
          : { id: 'ig_1', type: 'image_generation_call', status: 'failed' },
      }));
      res.write(sseFrame(`response.${terminal}`, {
        response: {
          id: 'resp_1',
          status: terminal,
          output: terminal === 'completed'
            ? [{ id: 'ig_1', type: 'image_generation_call', status: 'completed', result: image.toString('base64') }]
            : [{ id: 'ig_1', type: 'image_generation_call', status: 'failed' }],
          usage: { input_tokens: 11, output_tokens: 22 },
        },
      }));
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/v1`, calls, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

test('requestHostedImage streams, decodes the image and reports keepalives', async () => {
  const mock = await startMock();
  try {
    const outcome = await requestHostedImage({
      baseURL: mock.url,
      apiKey: 'test-key',
      model: 'example-main-model',
      prompt: 'a blue robot',
      size: '1024x1024',
      idempotencyKey: 'dsh-img-unit-test-0001',
    });
    assert.equal(outcome.status, 200);
    assert.equal(outcome.replayed, false);
    assert.equal(outcome.terminalStatus, 'completed');
    assert.equal(outcome.terminalId, 'resp_1');
    assert.ok(outcome.keepalives >= 1);
    assert.deepEqual(outcome.image.buffer, PNG_1X1);
    assert.equal(outcome.image.mediaType, 'image/png');
    assert.deepEqual(outcome.usage, { input_tokens: 11, output_tokens: 22 });

    const [call] = mock.calls;
    assert.equal(call.headers['idempotency-key'], 'dsh-img-unit-test-0001');
    assert.equal(call.headers.authorization, 'Bearer test-key');
    assert.equal(call.headers.accept, 'text/event-stream');
    assert.equal(call.headers['user-agent'], 'dsh-hosted-image/0.1.0');
    assert.equal(call.body.stream, true);
    assert.deepEqual(call.body.tools, [{ type: 'image_generation', size: '1024x1024' }]);
  } finally {
    await mock.close();
  }
});

test('requestHostedImage reports a replayed response', async () => {
  const mock = await startMock({ replay: true });
  try {
    const outcome = await requestHostedImage({
      baseURL: mock.url,
      apiKey: 'k',
      model: 'm',
      prompt: 'p',
      idempotencyKey: 'dsh-img-unit-test-0002',
    });
    assert.equal(outcome.replayed, true);
  } finally {
    await mock.close();
  }
});

test('requestHostedImage refuses to send a request without a usable idempotency key', async () => {
  const mock = await startMock();
  try {
    await assert.rejects(
      requestHostedImage({
        baseURL: mock.url,
        apiKey: 'k',
        model: 'm',
        prompt: 'p',
        idempotencyKey: undefined,
      }),
      /hosted_image_idempotency_key_required/u,
    );
    await assert.rejects(
      requestHostedImage({
        baseURL: mock.url,
        apiKey: 'k',
        model: 'm',
        prompt: 'p',
        idempotencyKey: '  padded  ',
      }),
      /hosted_image_idempotency_key_required/u,
    );
    await assert.rejects(
      requestHostedImage({
        baseURL: mock.url,
        apiKey: 'k',
        model: 'm',
        prompt: 'p',
        idempotencyKey: 'x'.repeat(129),
      }),
      /invalid_idempotency_key/u,
    );
    assert.equal(mock.calls.length, 0, 'no request may reach the server without a key');
  } finally {
    await mock.close();
  }
});

test('requestHostedImage maps a server error envelope to a coded error', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        type: 'hosted_image_error',
        code: 'image_tool_configuration_unavailable',
        message: 'image_tool_configuration_unavailable',
      },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await assert.rejects(
      requestHostedImage({
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: 'k',
        model: 'm',
        prompt: 'p',
        idempotencyKey: 'dsh-img-unit-test-0004',
      }),
      (error) => {
        assert.equal(error.code, 'image_tool_configuration_unavailable');
        assert.equal(error.status, 503);
        assert.match(error.message, /bind an image key on the Keys page/u);
        return true;
      },
    );
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('requestHostedImage surfaces a failed image item', async () => {
  const mock = await startMock({ terminal: 'failed' });
  try {
    await assert.rejects(
      requestHostedImage({
        baseURL: mock.url,
        apiKey: 'k',
        model: 'm',
        prompt: 'p',
        idempotencyKey: 'dsh-img-unit-test-0003',
      }),
      /hosted_image_not_completed/u,
    );
  } finally {
    await mock.close();
  }
});
