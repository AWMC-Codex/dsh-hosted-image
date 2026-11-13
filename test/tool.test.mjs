// Tool-definition tests.
//
// They run against the *real* `@deepseek-ai/dsh-tools`: the schema DSL and the
// `defineTool` contract are what actually decide whether the harness accepts this
// tool, so testing against a hand-written stub would prove nothing.
//
// `dsh-tools` ships inside the DSH desktop app (in app.asar), so it is not a normal
// npm dependency. Point `DSH_TOOLS_ROOT` at a directory that contains
// `node_modules/@deepseek-ai/dsh-tools`, or install the package yourself:
//
//     DSH_TOOLS_ROOT=/path/to/extracted/dsh npm test
//
// Without it, this file skips instead of failing, so `npm test` still works for
// someone who only wants the transport tests.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const toolsRoot = process.env.DSH_TOOLS_ROOT === undefined ? undefined : resolve(process.env.DSH_TOOLS_ROOT);
const dshToolsEntry =
  toolsRoot === undefined ? undefined : join(toolsRoot, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js');
const hasDshTools = dshToolsEntry !== undefined && existsSync(dshToolsEntry);

const { createToolDefinition, imageEnvelope, readConfig, resolveKeyFromContext } = await import('../tool.js');

if (!hasDshTools) {
  test('dsh-tools contract tests are skipped', (t) => {
    t.skip(
      'set DSH_TOOLS_ROOT to a directory containing node_modules/@deepseek-ai/dsh-tools ' +
        'to run the defineTool contract tests (see the header of this file)',
    );
  });
}

/** `defineTool` from the real package; only called from tests that assert `hasDshTools`. */
const { defineTool } = hasDshTools ? await import(pathToFileURL(dshToolsEntry).href) : {};

/** Skip a test body when the real package is unavailable. */
function requiresDshTools(t) {
  if (!hasDshTools) t.skip('DSH_TOOLS_ROOT is not set (or dsh-tools is missing there)');
  return hasDshTools;
}

// 1x1 opaque PNG.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const CFG = {
  baseURL: 'http://127.0.0.1:8080/v1',
  model: 'example-main-model',
  apiKeyEnv: 'HOSTED_IMAGE_API_KEY',
  size: '1024x1024',
  timeoutMs: 270_000,
};

function fakeContext({ resolve } = {}) {
  const saved = [];
  return {
    saved,
    get(name) {
      if (name === 'attachments') {
        return {
          async saveImage(input) {
            saved.push(input);
            return {
              attachmentId: 'sha256:abc',
              mediaType: input.mediaType,
              bytes: input.data.length,
              width: 1024,
              height: 1024,
              name: input.name,
            };
          },
          imageLimits: { maxMessageImageBytes: 20 * 1024 * 1024 },
        };
      }
      if (name === 'credentials' && resolve !== undefined) return { resolve };
      return undefined;
    },
  };
}

// --------------------------------------------------------------------- readConfig

test('readConfig prefers explicit config and falls back to the environment', () => {
  assert.deepEqual(readConfig({ baseURL: 'http://x/v1', model: 'm' }, {}), {
    baseURL: 'http://x/v1',
    model: 'm',
    apiKeyEnv: 'HOSTED_IMAGE_API_KEY',
    apiKeyFile: '',
    outputDir: '',
    size: '1024x1024',
    timeoutMs: 270_000,
  });

  const fromEnv = readConfig(undefined, {
    DSH_HOSTED_IMAGE_BASE_URL: 'http://env/v1',
    DSH_HOSTED_IMAGE_MODEL: 'env-model',
    DSH_HOSTED_IMAGE_API_KEY_ENV: 'DEMO_IMAGE_KEY_REF',
  });
  assert.equal(fromEnv.baseURL, 'http://env/v1');
  assert.equal(fromEnv.model, 'env-model');
  assert.equal(fromEnv.apiKeyEnv, 'DEMO_IMAGE_KEY_REF');
  assert.equal(readConfig({ baseURL: 'http://cfg/v1' }, { DSH_HOSTED_IMAGE_BASE_URL: 'http://env/v1' }).baseURL, 'http://cfg/v1');
});

test('readConfig rejects an unsupported default size', () => {
  assert.equal(readConfig({ size: '512x512' }, {}).size, '1024x1024');
  assert.equal(readConfig({ size: '2048x2048' }, {}).size, '2048x2048');
});

// ------------------------------------------------------------------ key resolution

test('resolveKeyFromContext prefers the credential store, then the environment', async () => {
  const ctx = fakeContext({ resolve: async (ref) => (ref === 'DEMO_IMAGE_KEY_REF' ? { value: 'stored-key', source: 'record' } : undefined) });
  assert.equal(await resolveKeyFromContext(ctx, 'DEMO_IMAGE_KEY_REF'), 'stored-key');

  const envCtx = fakeContext({ resolve: async () => undefined });
  process.env.HOSTED_IMAGE_TEST_KEY = 'env-key';
  try {
    assert.equal(await resolveKeyFromContext(envCtx, 'HOSTED_IMAGE_TEST_KEY'), 'env-key');
    await assert.rejects(resolveKeyFromContext(envCtx, 'NOT_SET_ANYWHERE'), /nothing is stored for credential/u);
  } finally {
    delete process.env.HOSTED_IMAGE_TEST_KEY;
  }
});

test('resolveKeyFromContext falls back to a key file and never leaks the value', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hosted-image-key-'));
  const file = join(dir, 'main-key.txt');
  writeFileSync(file, '  file-key\n', 'utf8');

  const ctx = fakeContext({ resolve: async () => undefined });
  assert.equal(await resolveKeyFromContext(ctx, 'NOT_SET_ANYWHERE', undefined, { keyFile: file }), 'file-key');

  const missing = join(dir, 'absent.txt');
  await assert.rejects(
    resolveKeyFromContext(ctx, 'NOT_SET_ANYWHERE', undefined, { keyFile: missing }),
    /has no key/u,
  );
});

// ---------------------------------------------------------------- defineTool contract

test('defineTool accepts the generated definition', (t) => {
  if (!requiresDshTools(t)) return;
  const tool = createToolDefinition(defineTool, fakeContext(), CFG, {
    resolveApiKey: async () => 'k',
    request: async () => { throw new Error('unused'); },
  });
  assert.equal(tool.name, 'generate_image');
  assert.equal(tool.timeoutMs, 280_000, 'the tool outlives the HTTP timeout so the transport error wins');
  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(tool.parameters.required, ['prompt']);
  assert.deepEqual(tool.parameters.properties.size.enum, ['1024x1024', '2048x2048', '4096x4096']);
  assert.equal(tool.parameters.properties.prompt.type, 'string');
  assert.equal(tool.parameters.properties.regenerate.type, 'boolean');
  assert.equal(tool.output.schema.additionalProperties, false);
  assert.deepEqual(tool.output.schema.required, ['model', 'idempotencyKey', 'replayed', 'terminalStatus', 'image']);
  assert.equal(tool.output.schema.properties.image.additionalProperties, false);
});

test('the renderer emits a text envelope plus a real image block', (t) => {
  if (!requiresDshTools(t)) return;
  const tool = createToolDefinition(defineTool, fakeContext(), CFG, {
    resolveApiKey: async () => 'k',
    request: async () => { throw new Error('unused'); },
  });
  const value = {
    model: 'example-main-model',
    idempotencyKey: 'dsh-img-0123456789abcdef0123456789abcdef',
    replayed: false,
    terminalStatus: 'completed',
    requestId: 'resp_1',
    image: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 68, width: 1024, height: 1024, name: 'hosted-abcdef01.png' },
  };
  const content = tool.output.render({ prompt: 'p' }, value);
  assert.equal(content.length, 2);
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /image\/png image, 1024x1024 px, 68 bytes/u);
  assert.match(content[0].text, /<idempotency>dsh-img-0123/u);
  assert.deepEqual(content[1], {
    type: 'image',
    attachment: {
      attachmentId: 'sha256:abc',
      mediaType: 'image/png',
      bytes: 68,
      width: 1024,
      height: 1024,
      name: 'hosted-abcdef01.png',
    },
  });
});

test('imageEnvelope marks a replayed result', () => {
  const marked = imageEnvelope({
    model: 'm',
    idempotencyKey: 'k',
    replayed: true,
    terminalStatus: 'completed',
    image: { mediaType: 'image/webp', bytes: 10, width: 4, height: 4 },
  });
  assert.match(marked, /replayed from the server idempotency store/u);
});

// ------------------------------------------------------------------- execute wiring

test('execute saves the bytes and returns the structured value', async (t) => {
  if (!requiresDshTools(t)) return;
  const ctx = fakeContext();
  const requests = [];
  const tool = createToolDefinition(defineTool, ctx, CFG, {
    resolveApiKey: async () => 'resolved-key',
    request: async (input) => {
      requests.push(input);
      return {
        status: 200,
        replayed: true,
        idempotencyKey: input.idempotencyKey,
        keepalives: 2,
        terminalStatus: 'completed',
        terminalId: 'resp_42',
        usage: { input_tokens: 1, output_tokens: 2 },
        image: { buffer: PNG_1X1, mediaType: 'image/png', width: 1, height: 1 },
        request: { body: {}, streamed: true },
      };
    },
  });

  const value = await tool.execute(
    { prompt: '  a blue robot  ', size: '2048x2048', quality: 'high' },
    { callId: 'call-1', agent: { session: { id: 'session-7' } } },
  );

  assert.equal(requests.length, 1);
  const [sent] = requests;
  assert.equal(sent.baseURL, CFG.baseURL);
  assert.equal(sent.apiKey, 'resolved-key');
  assert.equal(sent.model, CFG.model);
  assert.equal(sent.prompt, 'a blue robot', 'the prompt is trimmed');
  assert.equal(sent.size, '2048x2048');
  assert.equal(sent.quality, 'high');
  assert.equal(sent.timeoutMs, CFG.timeoutMs);
  assert.match(sent.idempotencyKey, /^dsh-img-[A-Za-z0-9_-]{32}$/u);

  assert.equal(ctx.saved.length, 1);
  assert.deepEqual(ctx.saved[0].data, PNG_1X1);
  assert.equal(ctx.saved[0].mediaType, 'image/png');
  assert.match(ctx.saved[0].name, /^hosted-[A-Za-z0-9_-]{8}\.png$/u);

  assert.equal(value.replayed, true);
  assert.equal(value.terminalStatus, 'completed');
  assert.equal(value.requestId, 'resp_42');
  assert.equal(value.idempotencyKey, sent.idempotencyKey);
  assert.equal(value.image.attachmentId, 'sha256:abc');
  assert.equal(value.savedPath, undefined, 'no workingDirectory service means no workspace copy');
});

test('execute mirrors the image into the session working directory', async (t) => {
  if (!requiresDshTools(t)) return;
  const { mkdtemp, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const workspace = await mkdtemp(join(tmpdir(), 'hosted-image-ws-'));

  const base = fakeContext();
  const ensured = [];
  const ctx = {
    ...base,
    get(name) {
      if (name === 'workingDirectory') {
        return {
          async ensure(agent, signal) {
            ensured.push({ agent, signal });
            return workspace;
          },
        };
      }
      return base.get(name);
    },
  };

  const tool = createToolDefinition(defineTool, ctx, CFG, {
    resolveApiKey: async () => 'k',
    request: async (input) => ({
      status: 200,
      replayed: false,
      idempotencyKey: input.idempotencyKey,
      keepalives: 0,
      terminalStatus: 'completed',
      image: { buffer: PNG_1X1, mediaType: 'image/png', width: 1, height: 1 },
      request: {},
    }),
  });

  const agent = { session: { id: 'session-ws' } };
  const value = await tool.execute({ prompt: 'a red cube' }, { callId: 'call-ws', agent });

  assert.equal(ensured.length, 1, 'the working directory is resolved once');
  assert.equal(ensured[0].agent, agent);
  assert.equal(
    value.savedPath,
    join(workspace, 'generated-images', `hosted-${value.idempotencyKey.slice(-8)}.png`),
  );
  assert.deepEqual(await readFile(value.savedPath), PNG_1X1, 'the copy holds the exact bytes');
  assert.match(imageEnvelope(value), /<saved>/u);
});

test('execute keeps the attachment when the workspace copy fails', async (t) => {
  if (!requiresDshTools(t)) return;
  const base = fakeContext();
  const warnings = [];
  const ctx = {
    ...base,
    logger: { warn: (message) => warnings.push(message) },
    get(name) {
      if (name === 'workingDirectory') {
        return {
          async ensure() {
            throw new Error('disk on fire');
          },
        };
      }
      return base.get(name);
    },
  };

  const tool = createToolDefinition(defineTool, ctx, CFG, {
    resolveApiKey: async () => 'k',
    request: async (input) => ({
      status: 200,
      replayed: false,
      idempotencyKey: input.idempotencyKey,
      keepalives: 0,
      terminalStatus: 'completed',
      image: { buffer: PNG_1X1, mediaType: 'image/png', width: 1, height: 1 },
      request: {},
    }),
  });

  const value = await tool.execute({ prompt: 'x' }, { callId: 'c', agent: { session: { id: 's' } } });
  assert.equal(value.savedPath, undefined);
  assert.equal(value.image.attachmentId, 'sha256:abc', 'the paid image is still returned');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not copy it into the workspace/u);
});

test('execute reuses one idempotency key across retries and forks on regenerate', async (t) => {
  if (!requiresDshTools(t)) return;
  const keys = [];
  const tool = createToolDefinition(defineTool, fakeContext(), CFG, {
    resolveApiKey: async () => 'k',
    request: async (input) => {
      keys.push(input.idempotencyKey);
      return {
        status: 200,
        replayed: false,
        idempotencyKey: input.idempotencyKey,
        keepalives: 0,
        terminalStatus: 'completed',
        image: { buffer: PNG_1X1, mediaType: 'image/png', width: 1, height: 1 },
        request: {},
      };
    },
  });
  const exec = { callId: 'call-a', agent: { session: { id: 's1' } } };

  await tool.execute({ prompt: 'same prompt' }, exec);
  await tool.execute({ prompt: 'same prompt' }, exec); // a retry
  await tool.execute({ prompt: 'same prompt', regenerate: true }, exec);

  assert.equal(keys[0], keys[1], 'a retry of the same logical request keeps the key');
  assert.notEqual(keys[2], keys[1], 'regenerate must fork to a new key');
  assert.ok(keys.every((key) => key.length <= 128));
});

test('execute rejects empty prompts and a missing attachment store', async (t) => {
  if (!requiresDshTools(t)) return;
  const tool = createToolDefinition(defineTool, fakeContext(), CFG, {
    resolveApiKey: async () => 'k',
    request: async () => { throw new Error('must not be called'); },
  });
  await assert.rejects(tool.execute({ prompt: '   ' }, {}), /prompt must be a non-empty string/u);
  await assert.rejects(tool.execute({}, {}), /invalid arguments/u, 'prompt is required by the schema');

  const withoutStore = createToolDefinition(
    defineTool,
    { get: () => undefined },
    CFG,
    { resolveApiKey: async () => 'k', request: async () => { throw new Error('must not be called'); } },
  );
  await assert.rejects(
    withoutStore.execute({ prompt: 'p' }, {}),
    /attachment store is not mounted/u,
  );
});

test('execute surfaces transport failures without saving anything', async (t) => {
  if (!requiresDshTools(t)) return;
  const ctx = fakeContext();
  const tool = createToolDefinition(defineTool, ctx, CFG, {
    resolveApiKey: async () => 'k',
    request: async () => {
      const error = new Error('hosted_request_requires_reconciliation — an operator must reconcile it');
      error.code = 'hosted_request_requires_reconciliation';
      error.reconcile = true;
      throw error;
    },
  });
  await assert.rejects(tool.execute({ prompt: 'p' }, {}), (error) => {
    assert.equal(error.code, 'hosted_request_requires_reconciliation');
    assert.equal(error.reconcile, true);
    return true;
  });
  assert.equal(ctx.saved.length, 0);
});
