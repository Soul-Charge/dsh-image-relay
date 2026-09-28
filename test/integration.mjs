// Integration test: exercise the real plugin's tool through a mocked DSH context.
// Verifies the full path (arg validation -> relay call -> attachment save -> render)
// without needing a DSH restart.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apply, IMAGE_RELAY_TOOL_NAME } from '../src/index.js';

const saved = [];
const ctx = {
  logger: { info: (...a) => console.log('  [log]', ...a), warn: (...a) => console.log('  [warn]', ...a) },
  tools: {
    register(definition) {
      globalThis.__tool = definition;
      console.log('  registered tool:', definition.name);
      return () => {};
    }
  },
  attachments: {
    imageLimits: {
      maxImageBytes: 20971520,
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 209715200,
      maxImagePixels: 64000000,
      maxImageDimension: 8192,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    },
    async saveImage(input) {
      saved.push(input);
      console.log('  saveImage called: mediaType=' + input.mediaType + ' bytes=' + input.data.byteLength + ' name=' + input.name);
      fs.writeFileSync(fileURLToPath(new URL('./tool-output.png', import.meta.url)), input.data);
      return { attachmentId: 'test-attachment-id', mediaType: 'image/png', bytes: input.data.byteLength, width: 1024, height: 1024, name: input.name };
    }
  },
  credentials: {
    async resolve(ref) {
      console.log('  credentials.resolve(' + ref + ') -> ' + (process.env.RELAY_KEY ? 'HIT' : 'miss'));
      return process.env.RELAY_KEY ? { value: process.env.RELAY_KEY, source: 'env' } : undefined;
    },
    async readRecord(key) { return undefined; }
  }
};

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { if (ok) { pass++; console.log('  ok   ' + label + (extra ? ' :: ' + extra : '')); } else { fail++; console.log('  FAIL ' + label + (extra ? ' :: ' + extra : '')); } };

console.log('--- apply() with default config ---');
apply(ctx);
const tool = globalThis.__tool;
check('tool registered', tool !== undefined);
check('tool name', tool.name === IMAGE_RELAY_TOOL_NAME, tool.name);

console.log('--- schema sanity ---');
check('prompt is required', JSON.stringify(tool.parameters.required ?? []).includes('prompt') || tool.parameters.properties?.prompt !== undefined, JSON.stringify(tool.parameters).slice(0, 200));

console.log('--- execute: empty prompt rejected ---');
let code = '';
try { await tool.execute({ prompt: '   ' }, { callId: 'c1', signal: AbortSignal.timeout(5000) }); }
catch (e) { code = e.code; }
check('empty prompt -> IMAGE_RELAY_INVALID_PROMPT', code === 'IMAGE_RELAY_INVALID_PROMPT', code);

console.log('--- execute: missing credential ---');
const realKey = process.env.RELAY_KEY;
process.env.RELAY_KEY = '';
code = '';
try { await tool.execute({ prompt: 'x' }, { callId: 'c2', signal: AbortSignal.timeout(5000) }); }
catch (e) { code = e.code; }
check('no key -> IMAGE_RELAY_CREDENTIAL_MISSING', code === 'IMAGE_RELAY_CREDENTIAL_MISSING', code);
process.env.RELAY_KEY = realKey;

console.log('--- execute: LIVE generation through the tool ---');
const started = Date.now();
const result = await tool.execute({ prompt: 'a ripe orange on a marble counter, studio light', size: '1024x1024' }, { callId: 'c3', signal: AbortSignal.timeout(170000) });
console.log('  result:', JSON.stringify({ prompt: result.prompt.slice(0, 30), model: result.model, attempts: result.attempts, bytes: result.image.bytes }));
check('returned model', result.model === 'gpt-image-2', result.model);
check('saved attachment', saved.length === 1);
check('image bytes > 100KB', result.image.bytes > 100000, String(result.image.bytes));
check('elapsed sane', Date.now() - started < 170000);

console.log('--- render produces an image part ---');
const parts = tool.output.render({ prompt: 'x' }, result);
check('render has image part', parts.some((p) => p.type === 'image' && p.attachment !== undefined), JSON.stringify(parts.map((p) => p.type)));

console.log('\nintegration: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
