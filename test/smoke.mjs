// Standalone smoke test of the pure core against the real relay.
import { generateImage, buildRequestBody, joinUrl, isRetryableStatus, describeErrorBody, parseImagePayload, decodePng, DEFAULT_MODEL } from '../src/relay.js';

let pass = 0, fail = 0;
const eq = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n       actual:   ' + JSON.stringify(actual) + '\n       expected: ' + JSON.stringify(expected)); }
};

console.log('--- unit: pure helpers ---');
eq('joinUrl trims both sides', joinUrl('https://x.top/v1/', '/images/generations'), 'https://x.top/v1/images/generations');
eq('joinUrl keeps single slash', joinUrl('https://x.top/v1', 'images/generations'), 'https://x.top/v1/images/generations');
eq('body omits empty size', buildRequestBody({ model: 'm', prompt: 'p', size: '', quality: '' }), { model: 'm', prompt: 'p', n: 1 });
eq('body includes size', buildRequestBody({ model: 'm', prompt: 'p', size: '1024x1024' }), { model: 'm', prompt: 'p', n: 1, size: '1024x1024' });
eq('502 retryable', isRetryableStatus(502), true);
eq('503 retryable', isRetryableStatus(503), true);
eq('401 not retryable', isRetryableStatus(401), false);
eq('404 not retryable', isRetryableStatus(404), false);
eq('empty body message', describeErrorBody(''), '');
eq('bare status text preserved', describeErrorBody('error code: 502'), 'error code: 502');
eq('json error extracted', describeErrorBody('{"error":{"message":"boom"}}'), 'boom');
eq('wrapped json error', describeErrorBody('{"message":"No available compatible accounts","type":"api_error"}'), 'No available compatible accounts');

console.log('--- unit: payload parsing ---');
eq('data[0].b64_json', parseImagePayload({ data: [{ b64_json: 'AA==' }] }).base64, 'AA==');
eq('bare b64_json', parseImagePayload({ b64_json: 'AA==' }).base64, 'AA==');
let threw = '';
try { parseImagePayload({ data: [{ url: 'https://x/y.png' }] }); } catch (e) { threw = e.code; }
eq('url-only rejected', threw, 'IMAGE_RESPONSE_URL_UNSUPPORTED');
threw = '';
try { decodePng(Buffer.from('nope').toString('base64'), 10); } catch (e) { threw = e.code; }
eq('non-png rejected', threw, 'IMAGE_RESPONSE_INVALID');

console.log('--- unit: fake-fetch retry behavior ---');
let calls = 0;
const flaky = async () => {
  calls++;
  if (calls < 3) return new Response('{"message":"No available compatible accounts","type":"api_error"}', { status: 503 });
  return new Response('{}', { status: 200 });
};
threw = '';
try { await generateImage({ apiKey: 'k', prompt: 'p', fetchFn: flaky, sleep: async () => {}, maxRetries: 5 }); } catch (e) { threw = e.code + ':' + e.message.slice(0, 40); }
eq('retries then fails on bad payload', threw.startsWith('IMAGE_RESPONSE_INVALID'), true);
eq('retried exactly 3 calls', calls, 3);

calls = 0;
const noRetry = async () => { calls++; return new Response('{"error":{"message":"bad key"}}', { status: 401 }); };
threw = '';
try { await generateImage({ apiKey: 'k', prompt: 'p', fetchFn: noRetry, sleep: async () => {}, maxRetries: 5 }); } catch (e) { threw = e.code; }
eq('401 not retried', calls, 1);
eq('401 code', threw, 'IMAGE_RELAY_FAILED');

console.log('\nunit results: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);

// The live section needs a real relay credential. Skip cleanly when absent so
// the default `node test/smoke.mjs` is hermetic; export RELAY_KEY to run it.
if (process.env.RELAY_KEY === undefined || process.env.RELAY_KEY === '') {
  console.log('\n--- live: skipped (set RELAY_KEY to run against a real relay) ---');
  process.exit(0);
}

console.log('\n--- live: real relay (gpt-image-2) ---');
const started = Date.now();
try {
  const out = await generateImage({ apiKey: process.env.RELAY_KEY, prompt: 'a small green pear on a wooden table, photorealistic', maxRetries: 6 });
  console.log('  LIVE OK: ' + out.bytes.length + ' bytes, attempts=' + out.attempts + ', ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
  const fs = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  fs.writeFileSync(fileURLToPath(new URL('./live-pear.png', import.meta.url)), out.bytes);
  console.log('  wrote test/live-pear.png');
} catch (error) {
  console.log('  LIVE FAIL: ' + error.code + ' :: ' + error.message);
  process.exit(2);
}
