// The tool definition itself, with `defineTool` injected so the same code can be
// exercised by `node --test` (against the dsh-tools copy extracted from app.asar)
// and by the running harness (which resolves the real package).

import {
  BACKGROUNDS,
  OUTPUT_FORMATS,
  QUALITIES,
  SIZES,
  deriveIdempotencyKey,
  requestHostedImage,
} from './hosted.js';

const MEDIA_TYPE_EXTENSION = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export const DEFAULT_TIMEOUT_MS = 270_000;
export const DEFAULT_SIZE = '1024x1024';
export const DEFAULT_KEY_ENV = 'HOSTED_IMAGE_API_KEY';
/** Sub-directory of the Session working directory that receives the visible copy. */
export const DEFAULT_OUTPUT_DIRNAME = 'generated-images';

function configText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Normalise the cordis `config` object. Every field falls back to an environment
 * variable so a deployment can be switched on without editing YAML.
 */
export function readConfig(config, env = process.env) {
  const source = config ?? {};
  return {
    baseURL: configText(source.baseURL) ?? configText(env.DSH_HOSTED_IMAGE_BASE_URL) ?? '',
    model: configText(source.model) ?? configText(env.DSH_HOSTED_IMAGE_MODEL) ?? '',
    apiKeyEnv:
      configText(source.apiKeyEnv) ?? configText(env.DSH_HOSTED_IMAGE_API_KEY_ENV) ?? DEFAULT_KEY_ENV,
    apiKeyFile:
      configText(source.apiKeyFile) ?? configText(env.DSH_HOSTED_IMAGE_API_KEY_FILE) ?? '',
    outputDir:
      configText(source.outputDir) ?? configText(env.DSH_HOSTED_IMAGE_OUTPUT_DIR) ?? '',
    size: SIZES.includes(source.size) ? source.size : DEFAULT_SIZE,
    timeoutMs:
      Number.isFinite(source.timeoutMs) && source.timeoutMs > 0 ? source.timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

/** Session-scoped material for the idempotency key; falls back to the tool call id. */
function scopeOf(exec) {
  const session = exec?.agent?.session;
  const id = session?.id ?? session?.sessionId;
  if (typeof id === 'string' && id !== '') return id;
  return typeof exec?.callId === 'string' && exec.callId !== '' ? exec.callId : 'anonymous';
}

/** Model-facing envelope that rides beside the image block in the tool result. */
export function imageEnvelope(value) {
  const replay = value.replayed ? ' (replayed from the server idempotency store)' : '';
  return [
    `<image>${value.image.mediaType} image, ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes</image>`,
    `<model>${value.model}</model>`,
    `<idempotency>${value.idempotencyKey}${replay}</idempotency>`,
    ...(value.savedPath === undefined ? [] : [`<saved>${value.savedPath}</saved>`]),
  ].join('\n');
}

/** Rebrand the structured output back into the attachment reference an image block carries. */
export function attachmentOf(image) {
  return {
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(image.name === undefined ? {} : { name: image.name }),
  };
}

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true, description: 'Durable attachment id in the DSH attachment store.' },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string', description: 'Display name of the stored image.' },
  },
};

/**
 * Build the `generate_image` definition.
 *
 * @param defineTool - the harness's `defineTool` helper.
 * @param ctx - the plugin context (needs `attachments` and optionally `credentials`).
 * @param cfg - resolved configuration: `{ baseURL, model, apiKeyEnv, size, timeoutMs }`.
 * @param deps - overrides used by tests: `{ resolveApiKey, request }`.
 */
export function createToolDefinition(defineTool, ctx, cfg, deps = {}) {
  const resolveApiKey =
    deps.resolveApiKey ?? ((exec) => resolveKeyFromContext(ctx, cfg.apiKeyEnv, exec, { keyFile: cfg.apiKeyFile }));
  const request = deps.request ?? requestHostedImage;

  return defineTool({
    name: 'generate_image',
    description:
      'Generate one image from a text description through the hosted image tool, and return the image itself ' +
      'so it is displayed in the conversation. One image per call; no editing and no multi-image output. ' +
      'Repeating an identical request returns the stored result instead of paying twice; pass regenerate:true ' +
      'to deliberately pay for a new picture.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'What the picture should show. Be concrete about subject, style and composition.',
      },
      size: {
        type: 'string',
        enum: [...SIZES],
        description: 'Square output size. Defaults to the configured size.',
      },
      quality: { type: 'string', enum: [...QUALITIES], description: 'Rendering quality hint.' },
      background: {
        type: 'string',
        enum: [...BACKGROUNDS],
        description: '`transparent` cannot be combined with jpeg output.',
      },
      output_format: {
        type: 'string',
        enum: [...OUTPUT_FORMATS],
        description: 'Encoded image format; defaults to png.',
      },
      output_compression: {
        type: 'integer',
        description: 'Compression level 0-100; only valid together with jpeg or webp output.',
      },
      regenerate: {
        type: 'boolean',
        description: 'Pay for a fresh picture even when the identical request already succeeded before.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          idempotencyKey: { type: 'string', required: true },
          replayed: { type: 'boolean', required: true },
          terminalStatus: { type: 'string', required: true },
          requestId: { type: 'string' },
          savedPath: { type: 'string', description: 'Absolute path of the workspace copy, when one was written.' },
          image: { ...IMAGE_SCHEMA, required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: imageEnvelope(value) },
        { type: 'image', attachment: attachmentOf(value.image) },
      ],
    },
    timeoutMs: cfg.timeoutMs + 10_000,
    async execute(args, exec) {
      const attachments = ctx.get('attachments');
      if (attachments === undefined) {
        throw new Error('the attachment store is not mounted, so a generated image cannot be saved');
      }
      const prompt = String(args.prompt ?? '').trim();
      if (prompt === '') throw new Error('prompt must be a non-empty string');

      const size = args.size ?? cfg.size;
      const apiKey = await resolveApiKey(exec);
      const idempotencyKey = deriveIdempotencyKey({
        sessionId: scopeOf(exec),
        model: cfg.model,
        prompt,
        size,
        quality: args.quality,
        background: args.background,
        outputFormat: args.output_format,
        regenerate: args.regenerate === true,
        callId: exec?.callId,
      });

      const outcome = await request({
        baseURL: cfg.baseURL,
        apiKey,
        model: cfg.model,
        prompt,
        size,
        quality: args.quality,
        background: args.background,
        outputFormat: args.output_format,
        outputCompression: args.output_compression,
        idempotencyKey,
        timeoutMs: cfg.timeoutMs,
        signal: exec?.signal,
      });

      const extension = MEDIA_TYPE_EXTENSION[outcome.image.mediaType] ?? 'png';
      const filename = `hosted-${idempotencyKey.slice(-8)}.${extension}`;
      const ref = await attachments.saveImage({
        data: outcome.image.buffer,
        mediaType: outcome.image.mediaType,
        name: filename,
      });

      // Mirror into the workspace so the file is findable outside the chat. A workspace
      // failure must not discard an image the user already paid for.
      let savedPath;
      try {
        savedPath = await saveVisibleCopy(ctx, cfg, exec, outcome.image.buffer, filename);
      } catch (error) {
        ctx.logger?.warn?.(`hosted-image: stored the attachment but could not copy it into the workspace: ${String(error)}`);
      }

      return {
        model: cfg.model,
        idempotencyKey,
        replayed: outcome.replayed === true,
        terminalStatus: String(outcome.terminalStatus ?? 'completed'),
        ...(typeof outcome.terminalId === 'string' && outcome.terminalId !== ''
          ? { requestId: outcome.terminalId }
          : {}),
        ...(savedPath === undefined ? {} : { savedPath }),
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
        },
      };
    },
  });
}

/**
 * Write a visible copy of the image into the Session working directory.
 *
 * The attachment store is content-addressed (`objects/<sha prefix>/<sha256>`), which the
 * chat renders correctly but which a human cannot find by name. Mirroring the bytes into
 * the workspace keeps "where did my picture go" answerable with a normal file manager.
 *
 * Best effort: a failure here must never lose an image that was already paid for, so the
 * caller keeps the attachment reference and only loses the convenience copy.
 *
 * @returns the absolute path written, or undefined when no workspace is known.
 */
async function saveVisibleCopy(ctx, cfg, exec, bytes, filename) {
  const agent = exec?.agent;
  if (agent === undefined) return undefined;
  const workingDirectory = ctx.get?.('workingDirectory');
  if (workingDirectory === undefined || typeof workingDirectory.ensure !== 'function') return undefined;
  const base = await workingDirectory.ensure(agent, exec?.signal);
  if (typeof base !== 'string' || base === '') return undefined;
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = join(base, cfg.outputDir === undefined || cfg.outputDir === '' ? DEFAULT_OUTPUT_DIRNAME : cfg.outputDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, filename);
  await writeFile(path, bytes);
  return path;
}

/**
 * Resolve the main-key secret: the credential store first (`apiKeyEnv` may name a
 * stored ref such as `DEMO_IMAGE_KEY_REF`), then the process environment, then an
 * explicitly configured key file — the last resort for a test deployment whose
 * key never leaves the host.
 */
export async function resolveKeyFromContext(ctx, ref, exec, opts = {}) {
  const credentials = ctx.get?.('credentials');
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    const hit = await credentials.resolve(ref);
    if (hit !== undefined && typeof hit.value === 'string' && hit.value !== '') return hit.value;
  }
  const fromEnv = process.env[ref];
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  if (typeof opts.keyFile === 'string' && opts.keyFile !== '') {
    const { readFileSync } = await import('node:fs');
    try {
      const text = readFileSync(opts.keyFile, 'utf8').trim();
      if (text !== '') return text;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(
    `no hosted-image API key: nothing is stored for credential "${ref}", that environment variable is empty` +
      (typeof opts.keyFile === 'string' && opts.keyFile !== '' ? `, and "${opts.keyFile}" has no key. ` : '. ') +
      'Store the main key in DSH credentials, or point apiKeyEnv at a stored credential reference.',
  );
}
