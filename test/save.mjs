// Tests for the workspace-save path helpers and the end-to-end save behavior.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slugifyPrompt, timestampStem, buildSavePath, DEFAULT_SAVE_DIR } from '../src/relay.js';
import { apply, IMAGE_RELAY_TOOL_NAME } from '../src/index.js';

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { if (ok) { pass++; console.log('  ok   ' + label + (extra ? ' :: ' + extra : '')); } else { fail++; console.log('  FAIL ' + label + (extra ? ' :: ' + extra : '')); } };

console.log('--- slugifyPrompt ---');
check('ascii lowercased and dashed', slugifyPrompt('A Red Apple On A Table') === 'a-red-apple-on-a-table', slugifyPrompt('A Red Apple On A Table'));
check('CJK collapses to dashes', slugifyPrompt('一只红苹果') === 'image', slugifyPrompt('一只红苹果'));
check('CJK+ascii keeps ascii', slugifyPrompt('画一张 red apple') === 'red-apple', slugifyPrompt('画一张 red apple'));
check('punctuation removed', slugifyPrompt('apple!!! (crisp)') === 'apple-crisp', slugifyPrompt('apple!!! (crisp)'));
check('path separators neutralized', slugifyPrompt('../../etc/passwd') === 'etc-passwd', slugifyPrompt('../../etc/passwd'));
check('empty falls back', slugifyPrompt('') === 'image');
check('truncated to max', slugifyPrompt('x'.repeat(200), 10).length <= 10, slugifyPrompt('x'.repeat(200), 10));

console.log('--- timestampStem ---');
const fixed = new Date(2026, 8, 27, 19, 5, 7);
check('formats YYYYMMDD-HHMMSS', timestampStem(fixed) === '20260927-190507', timestampStem(fixed));
check('pads single digits', timestampStem(new Date(2026, 0, 2, 3, 4, 5)) === '20260102-030405', timestampStem(new Date(2026, 0, 2, 3, 4, 5)));

console.log('--- buildSavePath ---');
const at = new Date(2026, 8, 27, 19, 5, 7);
const p1 = buildSavePath({ cwd: '/work', saveDir: 'temp/imagegen', prompt: 'a red apple', at });
check('builds absolute path', p1.path === '/work/temp/imagegen/20260927-190507-a-red-apple.png', p1.path);
check('default dir value', DEFAULT_SAVE_DIR === 'temp/imagegen', DEFAULT_SAVE_DIR);
check('disabled when saveDir empty', buildSavePath({ cwd: '/work', saveDir: '', prompt: 'x', at }) === undefined);
check('disabled when cwd missing', buildSavePath({ cwd: '', saveDir: 'temp', prompt: 'x', at }) === undefined);
const p2 = buildSavePath({ cwd: '/work', saveDir: '../../etc', prompt: 'x', at });
check('cannot escape workspace via ..', p2.path.startsWith('/work/'), p2.path);
const p3 = buildSavePath({ cwd: '/work', saveDir: '/absolute/path', prompt: 'x', at });
check('absolute-looking dir stays relative', p3.path.startsWith('/work/absolute/path/'), p3.path);
const p4 = buildSavePath({ cwd: 'C:\\Users\\me', saveDir: 'temp', prompt: 'x', at });
check('windows cwd normalized', p4.path.startsWith('C:/Users/me/temp/'), p4.path);

console.log('--- end-to-end: execute writes the file ---');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'imgrelay-'));
const savedByAttachment = [];
let tool;
const ctx = {
  logger: { info: () => {}, warn: (...a) => console.log('    [warn]', ...a) },
  tools: { register(def) { tool = def; return () => {}; } },
  attachments: {
    imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 1e9, maxMessageImageBytes: 1e9 },
    async saveImage(input) { savedByAttachment.push(input); return { attachmentId: 'sha256:test', mediaType: 'image/png', bytes: input.data.byteLength, width: 8, height: 8, name: input.name }; }
  },
  credentials: { async resolve() { return { value: 'k' }; }, async readRecord() { return undefined; } },
  inject: () => {}
};
// defaultLocked: false registers globally, which is what these execution tests
// need; the gate itself is covered by test/gate.mjs.
apply(ctx, { defaultLocked: false, saveTo: 'temp/imagegen' });
check('tool registered', tool !== undefined && tool.name === IMAGE_RELAY_TOOL_NAME);

// stub fetch to return a tiny valid PNG so no network is needed
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 });
const fakeAgent = { session: { header: { cwd: tmpRoot } } };
const out = await tool.execute({ prompt: 'a red apple' }, { callId: 'c1', signal: AbortSignal.timeout(10000), agent: fakeAgent });

check('attachment saved', savedByAttachment.length === 1);
check('savedPath returned', typeof out.savedPath === 'string', String(out.savedPath));
check('file exists on disk', out.savedPath !== undefined && fs.existsSync(out.savedPath), String(out.savedPath));
check('bytes match', out.savedPath !== undefined && fs.readFileSync(out.savedPath).equals(png));
check('path inside workspace', out.savedPath !== undefined && out.savedPath.startsWith(tmpRoot + path.sep + 'temp' + path.sep), String(out.savedPath));
check('filename is png', out.savedPath !== undefined && out.savedPath.endsWith('.png'));
check('no savedError', out.savedError === undefined, String(out.savedError));

console.log('--- render surfaces the path in text ---');
const parts = tool.output.render({ prompt: 'x' }, out);
const textPart = parts.find((p) => p.type === 'text');
check('text mentions path', textPart.text.includes(out.savedPath), textPart.text.replace(/\n/g, ' | '));
check('image part still present', parts.some((p) => p.type === 'image'));

console.log('--- disabled saveTo still succeeds ---');
tool = undefined;
savedByAttachment.length = 0;
apply(ctx, { defaultLocked: false, saveTo: '' });
const out2 = await tool.execute({ prompt: 'x' }, { callId: 'c2', signal: AbortSignal.timeout(10000), agent: fakeAgent });
check('no savedPath when disabled', out2.savedPath === undefined);
check('still returns image', out2.image !== undefined);

console.log('--- missing cwd degrades gracefully ---');
tool = undefined;
apply(ctx, { defaultLocked: false, saveTo: 'temp/imagegen' });
const out3 = await tool.execute({ prompt: 'x' }, { callId: 'c3', signal: AbortSignal.timeout(10000) });
check('no crash without agent', out3.image !== undefined && out3.savedPath === undefined);

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('\nsave tests: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
