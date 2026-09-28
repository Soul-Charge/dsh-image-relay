// Live verification: real relay + real file save, using the INSTALLED plugin.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, IMAGE_RELAY_TOOL_NAME } from '../src/index.js';

const root = fileURLToPath(new URL('../temp/live-workspace', import.meta.url));
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

let tool;
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  tools: { register(def) { tool = def; return () => {}; } },
  attachments: {
    imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 1e9, maxMessageImageBytes: 1e9 },
    async saveImage(input) { return { attachmentId: 'sha256:x', mediaType: 'image/png', bytes: input.data.byteLength, width: 1024, height: 1024, name: input.name }; }
  },
  credentials: { async resolve(ref) { return { value: process.env.RELAY_KEY, source: ref }; }, async readRecord() { return undefined; } },
  inject: () => {}
};

apply(ctx, { defaultLocked: false, saveTo: 'temp/imagegen' });
console.log('tool:', tool.name);
const started = Date.now();
const out = await tool.execute(
  { prompt: 'a single ripe red apple on a light gray table, soft window light, photorealistic' },
  { callId: 'live1', signal: AbortSignal.timeout(180000), agent: { session: { header: { cwd: root } } } }
);
console.log('model:', out.model, '| attempts:', out.attempts, '| attachment bytes:', out.image.bytes, '|', ((Date.now() - started) / 1000).toFixed(1) + 's');
console.log('savedPath:', out.savedPath);
console.log('savedError:', out.savedError ?? '(none)');
if (out.savedPath === undefined) { console.log('LIVE FAIL: no file saved'); process.exit(1); }
const st = fs.statSync(out.savedPath);
const head = fs.readFileSync(out.savedPath, { length: 8 });
console.log('file size:', st.size, '| is PNG:', head.toString('hex') === '89504e470d0a1a0a');
console.log('inside workspace:', path.resolve(out.savedPath).startsWith(path.resolve(root)));
const rel = path.relative(root, out.savedPath);
console.log('relative path:', rel);
console.log('LIVE OK');
