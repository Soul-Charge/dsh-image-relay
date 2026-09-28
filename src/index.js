// SPDX-License-Identifier: MIT
// dsh-image-relay: generate images through an OpenAI-compatible relay's Image API.
//
// Why this exists: DSH's LLM adapters speak only chat protocols
// (openai-completions / openai-responses / anthropic-messages). A relay that
// serves image models only on the standard Image API therefore cannot be reached
// by configuring it as a provider: the model would be called as a chat model and
// fail (observed: HTTP 502 on POST /v1/responses). This plugin adds the missing
// Image API path as a real tool instead.
//
// LOCKED BY DEFAULT. Under PTC mode every VISIBLE tool is projected into the
// generated \`tools:sdk\` prompt section, so a globally registered tool would
// occupy the model's context from turn one. This plugin therefore registers
// nothing on the model's surface until the user explicitly unlocks it for the
// current session with the \`/image\` command. The unlock registers the tool into
// THAT AGENT's scope layer (or lifts a per-agent denial when the deployment
// registered it globally), so other sessions stay unaffected.
import z from '@deepseek-ai/schemastery';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import {
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_SAVE_DIR,
  DEFAULT_TIMEOUT_MS,
  ImageRelayError,
  buildSavePath,
  generateImage
} from './relay.js';

export const name = 'image-relay';
export const inject = ['tools', 'attachments', 'credentials'];

/** Tool name the model calls. Kept stable so prompts, docs, and gates agree. */
export const IMAGE_RELAY_TOOL_NAME = 'relay_image_generate';

/** Slash command that unlocks the tool for one session. */
export const IMAGE_RELAY_COMMAND_NAME = 'image';

export const Config = z.object({
  enabled: z.boolean().default(true),
  /**
   * true (default): the tool is invisible to every agent until the user runs
   * \`/image\` in that session. false: register it globally, so native-mode
   * sessions see it immediately and \`/image off\` can hide it per session.
   */
  defaultLocked: z.boolean().default(true),
  /** Provider route whose stored credential is reused when apiKeyEnv resolves to nothing. */
  provider: z.string().default('cool-coffee-image'),
  /** Environment-variable name (a credential reference) holding the relay key. */
  apiKeyEnv: z.string().default(DEFAULT_API_KEY_ENV),
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  model: z.string().default(DEFAULT_MODEL),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  maxRetries: z.number().default(4),
  /**
   * Workspace-relative directory that also receives every generated PNG.
   *
   * Why this exists: under PTC mode DSH re-injects a tool's image result as a
   * `user/message` whose source is `{ kind: 'plugin', plugin: 'tools-ptc' }`,
   * and the chat renderer routes any non-`user` source down its "injected
   * context" branch — which renders text only, never image blocks. The model
   * sees a successful result while the human sees nothing. Writing the bytes to
   * a real file makes the image reachable regardless of that render path.
   * Set to an empty string to disable the file copy.
   */
  saveTo: z.string().default(DEFAULT_SAVE_DIR)
});

/** The credential scope the pi-ai adapter family writes provider keys under. */
const PI_AI_RECORD_SCOPE = 'llm-pi-ai';

/**
 * Resolve the relay key, trying the environment reference first and then the
 * provider record DSH writes when a key is entered on the Models page. Keys are
 * resolved per call so a rotated credential reaches the next generation without
 * a restart.
 */
async function resolveApiKey(ctx, config) {
  const credentials = ctx.credentials;
  if (credentials === undefined) return undefined;

  const refName = typeof config.apiKeyEnv === 'string' ? config.apiKeyEnv.trim() : '';
  if (refName !== '') {
    try {
      const found = await credentials.resolve(credentialRef(refName));
      if (found !== undefined && typeof found.value === 'string' && found.value !== '') {
        return { value: found.value, source: refName };
      }
    } catch {
      // Fall through to the provider-scoped lookup below.
    }
  }

  const provider = typeof config.provider === 'string' ? config.provider.trim() : '';
  if (provider !== '') {
    try {
      const record = await credentials.readRecord(credentialKey(PI_AI_RECORD_SCOPE, provider));
      if (record !== undefined && record !== null && record.kind === 'api-key') {
        const key = typeof record.key === 'string' ? record.key : '';
        if (key !== '') return { value: key, source: PI_AI_RECORD_SCOPE + '/' + provider };
      }
    } catch {
      // Fall through to the error below.
    }
  }

  return undefined;
}

function createImageRelayTool(ctx, config) {
  const baseUrl = config.baseUrl;
  const model = config.model;
  const timeoutMs = config.timeoutMs;
  const maxRetries = config.maxRetries;
  const saveTo = config.saveTo;

  return defineTool({
    name: IMAGE_RELAY_TOOL_NAME,
    description:
      'Generate a PNG image from a text prompt via an OpenAI-compatible image relay. ' +
      'Use it whenever the user asks to create, draw, render, or illustrate a picture. ' +
      'Returns the image inline and records it as a DSH attachment.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'A detailed description of the image to generate.'
      },
      size: {
        type: 'string',
        description: 'Output size such as 1024x1024, 1536x1024, or auto. Omit for the relay default.'
      },
      quality: {
        type: 'string',
        description: 'One of low, medium, high, or auto. Omit for the relay default.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', required: true },
          model: { type: 'string', required: true },
          revisedPrompt: { type: 'string' },
          attempts: { type: 'integer', required: true },
          savedPath: { type: 'string' },
          savedError: { type: 'string' },
          image: {
            type: 'object',
            required: true,
            additionalProperties: true,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', enum: ['image/png'], required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' }
            }
          }
        }
      },
      render: (_args, value) => {
        const output = value;
        // The text part is what survives the PTC context branch; the path must
        // live there so the result is actionable when the image itself is not
        // rendered. The image block is still emitted for renderers that do
        // handle plugin-sourced image parts.
        const lines = ['Generated image for: ' + output.prompt];
        if (output.savedPath !== undefined) lines.push('Saved to: ' + output.savedPath);
        if (output.savedError !== undefined) lines.push('File copy failed: ' + output.savedError);
        return [
          { type: 'text', text: lines.join('\n') },
          { type: 'image', attachment: output.image }
        ];
      }
    },
    timeoutMs: timeoutMs + 30000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', kind: 'other', title: 'Generate image', rawInput: args }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? 'Image generation failed' : 'Generated image',
      content: result.content
    }),
    async execute(args, exec) {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (prompt === '') {
        throw new HarnessError('Image prompt cannot be empty.', 'IMAGE_RELAY_INVALID_PROMPT');
      }
      const limits = ctx.attachments.imageLimits;
      if (!limits.mediaTypes.includes('image/png')) {
        throw new HarnessError(
          'PNG image attachments are not enabled in this DSH environment.',
          'IMAGE_RELAY_ATTACHMENT_UNSUPPORTED'
        );
      }
      const credential = await resolveApiKey(ctx, config);
      if (credential === undefined) {
        throw new HarnessError(
          'No relay API key: set the credential ' + config.apiKeyEnv + ' or configure provider "' + config.provider + '".',
          'IMAGE_RELAY_CREDENTIAL_MISSING'
        );
      }

      const maxBytes = Math.min(limits.maxImageBytes, limits.maxMessageImageBytes);
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = exec.signal !== undefined ? AbortSignal.any([exec.signal, timeoutSignal]) : timeoutSignal;

      let result;
      try {
        result = await generateImage({
          apiKey: credential.value,
          baseUrl,
          model,
          prompt,
          size: typeof args.size === 'string' ? args.size : undefined,
          quality: typeof args.quality === 'string' ? args.quality : undefined,
          maxRetries,
          maxBytes,
          signal
        });
      } catch (error) {
        if (error instanceof ImageRelayError) {
          throw new HarnessError(error.message, error.code, { cause: error });
        }
        if (timeoutSignal.aborted) {
          throw new HarnessError(
            'Image generation timed out after ' + Math.round(timeoutMs / 1000) + 's.',
            'IMAGE_RELAY_TIMEOUT'
          );
        }
        throw error;
      }

      const image = await ctx.attachments.saveImage({
        data: result.bytes,
        mediaType: 'image/png',
        name: 'relay-' + model + '.png'
      });

      // Rescue copy. Under PTC mode the image block never reaches the human's
      // transcript (see the saveTo config note), so the bytes are also written
      // to a real file the user can open. A failure here is reported alongside
      // a still-successful generation rather than failing the whole call.
      let savedPath;
      let savedError;
      const cwd = exec.agent?.session?.header?.cwd;
      const target = buildSavePath({ cwd, saveDir: saveTo, prompt });
      if (target !== undefined) {
        try {
          await writeFileAtomic(target.path, Buffer.from(result.bytes), { mode: 0o644 });
          savedPath = target.path;
        } catch (error) {
          savedError = error !== null && error !== undefined && error.message !== undefined
            ? String(error.message)
            : String(error);
        }
      }

      return {
        prompt,
        model,
        ...(result.revisedPrompt !== undefined ? { revisedPrompt: result.revisedPrompt } : {}),
        attempts: result.attempts,
        ...(savedPath !== undefined ? { savedPath } : {}),
        ...(savedError !== undefined ? { savedError } : {}),
        image
      };
    }
  });
}

/**
 * Build the per-session gate over one deployment.
 *
 * An agent with no entry sees the tool exactly when the deployment registered
 * it globally. An entry records the one effect that flips visibility for that
 * agent: a scoped registration (unlock when the deployment is locked) or a
 * restriction denying the inherited global (lock when it is unlocked).
 *
 * @returns gate operations plus a per-agent availability read.
 */
function createGate(ctx, config) {
  const gates = new WeakMap();
  const defaultLocked = config.defaultLocked;

  const availability = (agent) => {
    const gate = gates.get(agent);
    if (gate !== undefined) return gate.mode === 'scoped' ? 'unlocked' : 'locked';
    return defaultLocked ? 'locked' : 'unlocked';
  };

  const unlock = (agent) => {
    const gate = gates.get(agent);
    if (gate !== undefined) {
      if (gate.mode === 'scoped') return 'already-unlocked';
      // Was explicitly hidden under a globally-registered deployment: drop the
      // restriction so the inherited global shows through again.
      gate.dispose();
      gates.delete(agent);
      return 'unlocked';
    }
    if (!defaultLocked) return 'already-unlocked';
    // Register into THIS agent's scope layer; the PTC SDK section regenerates
    // from the calling scope on the next assembly, so other sessions keep the
    // tool out of their prompt.
    gates.set(agent, { mode: 'scoped', dispose: agent.ctx.tools.register(createImageRelayTool(ctx, config)) });
    return 'unlocked';
  };

  const lock = (agent) => {
    const gate = gates.get(agent);
    if (gate !== undefined) {
      if (gate.mode === 'restricted') return 'already-locked';
      gate.dispose();
      gates.delete(agent);
      return 'locked';
    }
    if (defaultLocked) return 'already-locked';
    // Globally registered: deny it for this agent only.
    gates.set(agent, { mode: 'restricted', dispose: agent.ctx.tools.restrict({ deny: [IMAGE_RELAY_TOOL_NAME] }) });
    return 'locked';
  };

  return { availability, unlock, lock };
}

export function apply(ctx, config = {}) {
  // Apply the schema here as well as at the loader seam: defaults must hold even
  // when the tool is registered from a bare ctx (tests, manual composition).
  const resolved = Config(config);
  if (resolved.enabled === false) {
    ctx.logger?.info?.('[image-relay] disabled by configuration');
    return;
  }

  const gate = createGate(ctx, resolved);
  const disposers = [];
  if (resolved.defaultLocked === false) {
    disposers.push(ctx.tools.register(createImageRelayTool(ctx, resolved)));
  }

  ctx.logger?.info?.(
    '[image-relay] ready (locked by default: ' + String(resolved.defaultLocked) + ') -> ' +
    resolved.baseUrl + ' (' + resolved.model + '); unlock per session with /' + IMAGE_RELAY_COMMAND_NAME
  );

  // Register the unlock command. \`commands\` is a human-UI registry, never a
  // model-visible tool, so declaring the command costs no prompt context.
  // \`ctx.inject\` hands the callback a context whose \`commands\` resolves, and
  // ties the registration's lifetime to this plugin's fiber.
  ctx.inject(['commands'], (commandCtx) => {
    const describe = (agent) => (gate.availability(agent) === 'unlocked' ? '已解锁' : '已锁定');
    commandCtx.commands.register({
      name: IMAGE_RELAY_COMMAND_NAME,
      description: '解锁或锁定本会话的生图工具 relay_image_generate（PTC 模式下默认不注入提示词）',
      input: { hint: '[on|off|status]' },
      handler: (invocation) => {
        const verb = String(invocation.rawInput ?? '').trim().toLowerCase();
        if (verb === '' || verb === 'on' || verb === 'unlock' || verb === 'enable') {
          const outcome = gate.unlock(invocation.agent);
          return {
            kind: 'success',
            text: outcome === 'already-unlocked'
              ? '生图工具已处于解锁状态（' + describe(invocation.agent) + '）。'
              : '已解锁生图工具 relay_image_generate（仅本会话）；下一轮开始模型即可在 run_code 里调用。'
          };
        }
        if (verb === 'off' || verb === 'lock' || verb === 'disable') {
          const outcome = gate.lock(invocation.agent);
          return {
            kind: 'success',
            text: outcome === 'already-locked'
              ? '生图工具当前已锁定（' + describe(invocation.agent) + '）。'
              : '已锁定生图工具（仅本会话）。'
          };
        }
        if (verb === 'status') {
          return {
            kind: 'success',
            text: '本会话：' + describe(invocation.agent) +
              '（部署默认：' + (resolved.defaultLocked ? '锁定' : '全局可用') + '）'
          };
        }
        return { kind: 'error', text: '用法：/image [on|off|status]' };
      }
    });
  });

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch (error) {
        ctx.logger?.warn?.('[image-relay] disposer failed: ' + String(error));
      }
    }
  };
}
