# dsh-hosted-image

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that adds one tool —
`generate_image` — which turns a text prompt into a real image **inside the chat window**,
through a [sub2api](https://github.com/Wei-Shaw/sub2api) deployment that serves the
*hosted image* Responses contract.

The model asks for a picture, the plugin does the HTTP work, and the bytes come back as a
normal `image` block in the tool result: previewed in the chat, clickable to full size,
copyable into the workspace, and visible to the model on the next turn.

```
you:  画一张骑自行车的鹈鹕
model: → generate_image({ prompt: "...", quality: "low" })
tool:  <image>image/png image, 1024x1024 px, 953537 bytes</image>  +  [image block]
model: "画好了。" (and it can look at the picture it just made)
```

## Why a tool, and not a provider

DSH already speaks OpenAI Responses through `dsh-llm-pi-ai`. It still cannot reach this
contract, for three independent reasons:

| Required by the contract | What the pi-ai transport does |
| --- | --- |
| `tools: [{"type":"image_generation"}]` in the request body | only emits `function` / `custom` tools; there is no channel to declare an image tool |
| a stable `Idempotency-Key` header per logical operation | sends only static, profile-level headers — no per-call header |
| reading `image_generation_call.result` (base64) from the response | has no handler for that item type, so the picture is dropped |

A tool owns its own HTTP client, so all three gaps close without patching `app.asar`, the
pi-ai transport, or the server. That is the whole design.

## Requirements

- DSH desktop **0.2.x** (`@deepseek-ai/dsh-tools` is provided by the app; this plugin
  declares it as a peer dependency and imports it at runtime).
- Node **>= 22.19** (uses `node:http`, `node:https`, `node:crypto`, `fetch`-shaped internals).
- A sub2api deployment with the hosted image tools **enabled**:
  `SUB2API_HOSTED_IMAGE_TOOLS_ENABLED=true`, and a *main key* whose Keys page has a
  hosted-image binding (main key → image key → image model) already configured.
  The plugin only ever sends the **main** key; the image key stays server-side.

## Install

1. Put the package where the profile loader can resolve it:

   ```
   <DSH_HOME>/profiles/<profile>/node_modules/dsh-hosted-image/
   ```

2. Add it to the profile bundle list in `<DSH_HOME>/profiles/<profile>/package.json`:

   ```json
   {
     "dependencies": { "dsh-hosted-image": "0.1.0" },
     "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "...", "dsh-hosted-image"] } }
   }
   ```

3. Store the main key as a credential. Put a reference in
   `<DSH_HOME>/.credentials.yaml` (or export it in the app environment) — for example the
   reference `HOSTED_IMAGE_API_KEY` holding the `sk-...` value. The plugin never writes or
   logs the key.

4. Restart DSH (or just save the profile patch — the profile layer hot-reloads).

Verify: `generate_image` should appear in the tool list, and the profile log should contain
no `skipping profile bundle "dsh-hosted-image"` line.

## Configure

The plugin ships `cordis.patch.yml`, which the profile loader reads automatically. Edit the
`config` block:

```yaml
- insert:
    - id: dsh-hosted-image
      name: dsh-hosted-image
      config:
        baseURL: https://your-host/v1     # …/v1 of the sub2api deployment
        model: example-main-model                # the main model that drives the parent turn
        apiKeyEnv: HOSTED_IMAGE_API_KEY   # credential reference holding the main key
```

| Key | Default | Meaning |
| --- | --- | --- |
| `baseURL` | — (required) | Hosted-image endpoint; the plugin posts to `${baseURL}/responses`. |
| `model` | — (required) | Main model name for the parent Responses turn. |
| `apiKeyEnv` | `HOSTED_IMAGE_API_KEY` | Credential reference holding the **main** key. |
| `apiKeyFile` | `""` | Last-resort file containing the key. Empty in normal use. |
| `outputDir` | `generated-images` | Sub-directory of the session working directory for the visible copy. |
| `size` | `1024x1024` | Default size; `1024x1024`, `2048x2048`, or `4096x4096`. |
| `timeoutMs` | `270000` | HTTP timeout; keep it under the server's 4-minute accepted-operation window. |

Every key can also come from the environment: `DSH_HOSTED_IMAGE_BASE_URL`,
`DSH_HOSTED_IMAGE_MODEL`, `DSH_HOSTED_IMAGE_API_KEY_ENV`, `DSH_HOSTED_IMAGE_API_KEY_FILE`,
`DSH_HOSTED_IMAGE_OUTPUT_DIR`. Explicit config wins over the environment.

If `baseURL` or `model` is missing, the plugin disables itself with one log line instead of
registering a broken tool.

## Usage

The model calls the tool on its own when a request needs a picture. You can also ask for it
explicitly.

| Argument | Type | Notes |
| --- | --- | --- |
| `prompt` | string (required) | What to draw. Up to 16 000 characters server-side. |
| `size` | enum | `1024x1024` / `2048x2048` / `4096x4096`. The model never silently upgrades it. |
| `quality` | enum | `auto` / `low` / `medium` / `high`. |
| `background` | enum | `auto` / `opaque` / `transparent`. `transparent` is rejected together with `jpeg`. |
| `output_format` | enum | `png` / `jpeg` / `webp`. |
| `output_compression` | integer | `0`–`100`; only meaningful for `jpeg` / `webp`. |
| `regenerate` | boolean | `true` forces a new image for identical inputs. |

One image per call. Image *editing*, multiple images, and `previous_response_id`
continuations are not supported by the contract and fail before any work is billed.

### Idempotency

The `Idempotency-Key` is **derived, not random**:

```
dsh-img-<base64url(sha256(session · model · prompt · size · quality · background · format))[0..32]>
```

Consequences worth knowing:

- Asking for the same picture twice in the same session **replays** the stored response: no
  new charge, byte-identical file. The envelope says
  `(replayed from the server idempotency store)`.
- Pass `regenerate: true` to deliberately pay for a new image.
- Changing any of the inputs derives a new key, which is a new operation.
- If a call ends in an *uncertain* state, the server answers `409
  hosted_request_requires_reconciliation` for that key. Retrying with a **new** key would
  bill a second time; the plugin surfaces the conflict instead, with
  `error.reconcile = true`.

### Where the picture goes

Two copies, on purpose:

1. **Attachment store** (authoritative) — `<DSH_HOME>/attachments/...`, content-addressed by
   sha256. This is what the chat renders and what the model can read back next turn.
2. **Workspace copy** — `<session cwd>/generated-images/<name>.png`, so the file is easy to
   find, open in an editor, or commit. The absolute path is reported as `<saved>…</saved>`.

If the workspace copy fails (read-only checkout, full disk), the image is **not** lost: the
tool warns once and still returns the attachment.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Upstream access forbidden, please contact administrator` (502) | The upstream rejects requests without a `User-Agent`. The plugin sends `dsh-hosted-image/0.1.0`; a bare client you wrote yourself probably does not. |
| `hosted_image_child_failed` | The image provider call itself failed upstream (timeout, rate limit, unusable account, failover cooldown). Not a plugin fault — retrying with a different prompt often lands on another account. |
| `hosted_image_idempotency_key_required` | You are calling the endpoint by hand without the header. The plugin always sets it. |
| `hosted_request_requires_reconciliation` (409) | An earlier attempt with this key is unresolved. Check server-side state; do not re-key. |
| `ECONNREFUSED 127.0.0.1:…` | `baseURL` points at a local tunnel that is not running. Point it at the public endpoint instead. |
| The tool never appears | The bundle is not in `dsh.profile.bundles`, or the package is not under the profile's `node_modules`, or the key/`baseURL` config made the plugin disable itself. |
| `upstream_stream_truncated` from a *different* plugin | Some ACP/compression plugins replace `globalThis.fetch` and rewrite any URL ending in `/responses`. This plugin deliberately uses `node:http`/`node:https` to stay out of that path — do not "simplify" its transport back to `fetch`. |

## Design notes

- **Nothing is monkey-patched.** The plugin is an ordinary DSH tool: it registers with
  `ctx.tools.register`, does its own HTTP, and returns content blocks.
- **The image block goes in the tool result**, which is the only shape the Chat UI
  (`tool.call.images`), the trajectory view, *and* pi-ai's `convertToolResultOutput` all
  accept. An `image` block in an assistant message is rejected by both the pi-ai and the
  DeepSeek adapters, so the plugin never puts one there.
- **`node:http` instead of `fetch`** — see the last troubleshooting row. Long (60–180 s)
  image turns are exactly what an intercepting stream proxy mishandles.
- **Streaming SSE, not a blocking POST.** Public edges commonly cap a single response at
  ~125 s, which a slow 2K/4K render will exceed. The contract emits a keepalive comment
  every ~10 s, so an SSE body keeps the connection alive; the parser ignores those comments
  and waits for `response.completed`.
- **The tool times out after `timeoutMs + 10 s`**, so the transport error wins the race and
  the user sees the real reason instead of a generic tool timeout.

## Tests

```bash
npm test                                        # transport tests run; contract tests skip
DSH_TOOLS_ROOT=/path/to/extracted/dsh npm test  # everything runs
```

`test/tool.test.mjs` runs against the **real** `@deepseek-ai/dsh-tools`, because the schema
DSL and the `defineTool` contract are what decide whether the harness accepts the tool.
That package ships inside the DSH app, not on npm, so set `DSH_TOOLS_ROOT` to a directory
containing `node_modules/@deepseek-ai/dsh-tools`. Without it those tests skip rather than
fail.

`test/hosted.test.mjs` needs nothing: it starts a local mock of the contract and covers the
request body, the idempotency derivation, SSE framing (keepalives, multi-line data,
`[DONE]`), base64/format/pixel validation, and the error mapping.

## Files

| File | Contents |
| --- | --- |
| `index.js` | plugin entry: config, readiness-retrying registration, disable-if-unconfigured |
| `tool.js` | tool definition: arguments, output schema, rendering, key resolution, workspace copy |
| `hosted.js` | the contract: request body, idempotency key, SSE parser, image decode, error mapping |
| `cordis.patch.yml` | the profile patch that mounts the plugin |
| `test/` | transport tests and `defineTool` contract tests |

## License

MIT — see [LICENSE](LICENSE).
