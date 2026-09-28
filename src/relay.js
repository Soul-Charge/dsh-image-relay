// SPDX-License-Identifier: MIT
// Pure core for the DSH image relay tool. No DSH imports so it can be tested
// standalone with plain `node`. The wiring layer lives in index.js.
//
// Talks to an OpenAI-compatible relay's standard Image API:
//   POST {baseUrl}/images/generations  { model, prompt, n, size, quality }
// Point baseUrl at your own relay; the default is the vanilla OpenAI endpoint.

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_MODEL = 'gpt-image-2';
export const DEFAULT_API_KEY_ENV = 'COOL_COFFEE_IMAGE_API_KEY';
export const DEFAULT_TIMEOUT_MS = 180000;
export const DEFAULT_MAX_RETRIES = 4;
export const DEFAULT_RETRY_DELAY_MS = 2500;

/** Error carrying a stable machine code plus the relay's own status/detail. */
export class ImageRelayError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'ImageRelayError';
    this.code = code;
    this.detail = detail;
  }
}

/** Build the Image API request body. */
export function buildRequestBody(options) {
  const body = {
    model: options.model,
    prompt: options.prompt,
    n: 1
  };
  if (options.size !== undefined && options.size !== '') body.size = options.size;
  if (options.quality !== undefined && options.quality !== '') body.quality = options.quality;
  return body;
}

/** Join a base URL and a path without doubling or dropping the separator. */
export function joinUrl(baseUrl, path) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const tail = String(path).replace(/^\/+/, '');
  return base + '/' + tail;
}

/**
 * Whether a failed attempt is worth retrying.
 * The relay intermittently answers 503 "No available compatible accounts" while
 * its upstream account pool rebalances (measured ~1 in 5 on gpt-image-2), and
 * gateways produce bare 5xx pages. Auth and malformed-request failures are not
 * retried because repetition cannot fix them.
 */
export function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/** Pull the relay's human-readable error out of whatever shape the body has. */
export function describeErrorBody(text) {
  if (typeof text !== 'string' || text.trim() === '') return '';
  try {
    const parsed = JSON.parse(text);
    const err = parsed && typeof parsed === 'object' ? parsed.error : undefined;
    if (err && typeof err === 'object' && typeof err.message === 'string') return err.message;
    if (typeof err === 'string') return err;
    if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string') return parsed.message;
  } catch {
    // Not JSON: a gateway page or a bare status string like "error code: 502".
  }
  return text.trim().slice(0, 400);
}

/**
 * Extract base64 image bytes from a successful response.
 * Accepts the shapes relays actually return: {data:[{b64_json}]}, the same with
 * a bare {b64_json}, and an SSE-ish {image}. A URL-only response is rejected
 * because fetching a second host would bypass this tool's configured endpoint.
 */
export function parseImagePayload(payload) {
  if (payload === null || typeof payload !== 'object') {
    throw new ImageRelayError('Relay returned a non-object image response.', 'IMAGE_RESPONSE_INVALID');
  }
  const first = Array.isArray(payload.data) ? payload.data[0] : undefined;
  const candidates = [
    first && typeof first === 'object' ? first.b64_json : undefined,
    first && typeof first === 'object' ? first.image_base64 : undefined,
    payload.b64_json,
    payload.image,
    payload.image_base64
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) {
      const revised = first && typeof first === 'object' && typeof first.revised_prompt === 'string'
        ? first.revised_prompt
        : undefined;
      return { base64: value, revisedPrompt: revised };
    }
  }
  const urlOnly = first && typeof first === 'object' && typeof first.url === 'string' ? first.url : undefined;
  if (urlOnly !== undefined) {
    throw new ImageRelayError(
      'Relay returned an image URL instead of inline bytes; set the relay to inline base64.',
      'IMAGE_RESPONSE_URL_UNSUPPORTED',
      { url: urlOnly.slice(0, 120) }
    );
  }
  throw new ImageRelayError('Relay response did not include image data.', 'IMAGE_RESPONSE_INVALID');
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Decode base64 and verify it really is a PNG, guarding the byte budget. */
export function decodePng(base64, maxBytes) {
  const cleaned = String(base64).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new ImageRelayError('Relay image payload was not valid base64.', 'IMAGE_RESPONSE_INVALID');
  }
  const bytes = Buffer.from(cleaned, 'base64');
  if (bytes.length === 0) {
    throw new ImageRelayError('Relay returned an empty image.', 'IMAGE_RESPONSE_INVALID');
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      throw new ImageRelayError('Relay image was not a PNG.', 'IMAGE_RESPONSE_INVALID');
    }
  }
  if (typeof maxBytes === 'number' && bytes.length > maxBytes) {
    throw new ImageRelayError(
      'Generated image is ' + bytes.length + ' bytes, over the ' + maxBytes + '-byte attachment limit.',
      'IMAGE_TOO_LARGE',
      { bytes: bytes.length, maxBytes }
    );
  }
  return bytes;
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal !== undefined && signal.aborted) {
      reject(new ImageRelayError('Image generation was cancelled.', 'IMAGE_ABORTED'));
      return;
    }
    const timer = setTimeout(() => {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new ImageRelayError('Image generation was cancelled.', 'IMAGE_ABORTED'));
    }
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Call the relay until it returns an image or the retry budget runs out.
 * @returns {Promise<{bytes: Uint8Array, revisedPrompt: string|undefined, attempts: number}>}
 */
export async function generateImage(options) {
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const url = joinUrl(baseUrl, 'images/generations');
  const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : DEFAULT_MAX_RETRIES;
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : DEFAULT_RETRY_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;

  const body = buildRequestBody({
    model: options.model ?? DEFAULT_MODEL,
    prompt: options.prompt,
    size: options.size,
    quality: options.quality
  });

  let attempt = 0;
  let lastDetail = '';
  while (attempt <= maxRetries) {
    attempt += 1;
    let response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + options.apiKey,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      if (signal !== undefined && signal.aborted) {
        throw new ImageRelayError('Image generation was cancelled.', 'IMAGE_ABORTED');
      }
      lastDetail = error !== null && error !== undefined && error.message !== undefined ? error.message : String(error);
      if (attempt > maxRetries) {
        throw new ImageRelayError(
          'Could not reach the image relay after ' + attempt + ' attempt(s): ' + lastDetail,
          'IMAGE_NETWORK_FAILED'
        );
      }
      await sleep(Math.min(retryDelayMs * 2 ** (attempt - 1), 20000), signal);
      continue;
    }

    const text = await response.text().catch(() => '');
    if (response.ok) {
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ImageRelayError('Relay returned a successful status but unparsable JSON.', 'IMAGE_RESPONSE_INVALID');
      }
      const parsed = parseImagePayload(payload);
      const bytes = decodePng(parsed.base64, options.maxBytes);
      return { bytes, revisedPrompt: parsed.revisedPrompt, attempts: attempt };
    }

    lastDetail = describeErrorBody(text) || (response.status + ' status code (no body)');
    if (!isRetryableStatus(response.status) || attempt > maxRetries) {
      throw new ImageRelayError(
        'Image relay failed (' + response.status + '): ' + lastDetail,
        'IMAGE_RELAY_FAILED',
        { status: response.status, detail: lastDetail, attempts: attempt }
      );
    }
    await sleep(Math.min(retryDelayMs * 2 ** (attempt - 1), 20000), signal);
  }

  throw new ImageRelayError(
    'Image relay failed after ' + attempt + ' attempt(s): ' + lastDetail,
    'IMAGE_RELAY_FAILED',
    { detail: lastDetail, attempts: attempt }
  );
}


/** Default workspace-relative directory for rescued image files. */
export const DEFAULT_SAVE_DIR = 'temp/imagegen';

/**
 * Turn a prompt into a short, filesystem-safe filename stem.
 * Only ASCII letters, digits, and single dashes survive; everything else
 * (including CJK, punctuation, and path separators) becomes a dash. The result
 * is truncated so one long prompt cannot produce an unwritable name.
 */
export function slugifyPrompt(prompt, maxLength = 40) {
  const cleaned = String(prompt ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return cleaned === '' ? 'image' : cleaned;
}

/** Format one local timestamp as YYYYMMDD-HHMMSS in the process timezone. */
export function timestampStem(at) {
  const d = at instanceof Date ? at : new Date(at ?? Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

/**
 * Build the absolute path a rescued image should be written to.
 *
 * Pure so it can be unit-tested without a filesystem. Returns undefined when
 * saving is disabled (no working directory, or an empty directory setting).
 *
 * @param options.cwd - absolute session working directory.
 * @param options.saveDir - workspace-relative directory; empty disables saving.
 * @param options.prompt - generation prompt, used for the filename stem.
 * @param options.at - timestamp source; defaults to now.
 * @returns {{ path: string, fileName: string, dir: string } | undefined}
 */
export function buildSavePath(options) {
  const cwd = typeof options.cwd === 'string' ? options.cwd.trim() : '';
  const rawDir = typeof options.saveDir === 'string' ? options.saveDir.trim() : '';
  if (cwd === '' || rawDir === '') return undefined;

  // Containment: the save directory is workspace-relative, so an absolute path
  // or a `..` segment could escape the session root. Drop those segments
  // instead of trusting configuration to be well-formed.
  const segments = [];
  for (const part of rawDir.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  if (segments.length === 0) return undefined;

  const dir = joinUrl(cwd.replace(/\\/g, '/'), segments.join('/'));
  const fileName = timestampStem(options.at) + '-' + slugifyPrompt(options.prompt) + '.png';
  return { path: dir + '/' + fileName, fileName, dir };
}

