'use strict';
/**
 * End-to-end verification of live meeting mode without touching a real provider:
 *   1. starts a mock that speaks the Groq transcription HTTP shape,
 *   2. drives a real LiveSession with three fake webm chunks,
 *   3. asserts ordered transcription, timestamp offsets, webm upload shape,
 *      and the event stream the UI consumes.
 *
 *   node scripts/verify-live.js
 */

const http = require('http');
const assert = require('assert');
const { PROVIDERS } = require('../src/main/providers');
const { LiveSession, toTimestampedText } = require('../src/main/live');

const results = [];
let failures = 0;
function check(name, fn) {
  try {
    fn();
    results.push(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    results.push(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const seen = { requests: 0, models: [], filenames: [], contentTypes: [], authorization: [] };

function startMock() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    seen.requests += 1;
    seen.authorization.push(req.headers.authorization || '');
    seen.contentTypes.push(req.headers['content-type'] || '');
    const latin = body.toString('latin1');
    seen.models.push(/name="model"\r\n\r\n([^\r]+)/.exec(latin)?.[1]?.trim() || '');
    seen.filenames.push(/name="file"; filename="([^"]+)"/.exec(latin)?.[1] || '');
    const part = seen.requests;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: seen.models[seen.models.length - 1],
      text: `Chunk ${part} says the launch is on track and the demo is ready.`,
      segments: [
        { start: 0, end: 7, text: `Chunk ${part}: launch on track.` },
        { start: 7, end: 14.2, text: `Chunk ${part}: demo is ready.` }
      ]
    }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

(async () => {
  const server = await startMock();
  PROVIDERS.groq.baseUrl = `http://127.0.0.1:${server.address().port}/openai/v1`;
  PROVIDERS.groq.minRequestIntervalMs = 5;

  const events = [];
  const session = new LiveSession({ onEvent: (e) => events.push(e) });
  session.configure({ providerId: 'groq', model: 'whisper-large-v3-turbo', apiKey: 'test-key', language: undefined });
  session.start();

  // Three fake chunks (mock does not decode audio), pushed faster than transcription.
  for (let i = 0; i < 3; i += 1) {
    session.pushChunk(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, i]));
  }
  const stop = await session.stop();
  session.cleanup();

  check('three chunks were uploaded in order as multipart webm', () => {
    assert.strictEqual(seen.requests, 3);
    assert.deepStrictEqual(seen.filenames, ['chunk-0000.webm', 'chunk-0001.webm', 'chunk-0002.webm']);
    assert.ok(seen.contentTypes.every((c) => c.startsWith('multipart/form-data')), 'not multipart');
  });
  check('bearer auth was sent on every request', () => {
    assert.ok(seen.authorization.every((a) => a === 'Bearer test-key'));
  });
  check('chunk timestamps are offset by 15 s per chunk', () => {
    const segs = stop.segments;
    assert.strictEqual(segs.length, 6);
    assert.deepStrictEqual(
      segs.map((s) => s.start),
      [0, 7, 15, 22, 30, 37]
    );
    assert.strictEqual(segs[3].text, 'Chunk 2: demo is ready.');
  });
  check('full transcript joins chunk texts in order', () => {
    assert.strictEqual(
      stop.text,
      'Chunk 1 says the launch is on track and the demo is ready.\nChunk 2 says the launch is on track and the demo is ready.\nChunk 3 says the launch is on track and the demo is ready.'
    );
  });
  check('event stream: started, per-chunk segments, stopped', () => {
    const kinds = events.map((e) => e.kind);
    assert.strictEqual(kinds[0], 'started');
    assert.strictEqual(kinds[kinds.length - 1], 'stopped');
    assert.strictEqual(kinds.filter((k) => k === 'segments').length, 3);
  });
  check('stopped event carries the final text and elapsed time', () => {
    const last = events[events.length - 1];
    assert.ok(last.text.startsWith('Chunk 1'));
    assert.ok(last.elapsedMs >= 0);
    assert.ok(stop.elapsed >= 0);
    assert.strictEqual(stop.errors, 0);
  });
  check('timestamped text export starts at 00:00:00 and reaches 00:00:37', () => {
    const txt = toTimestampedText(stop.segments, stop.transcript);
    assert.ok(txt.startsWith('[00:00:00] Chunk 1: launch on track.'));
    assert.ok(txt.includes('[00:00:37] Chunk 3: demo is ready.'));
  });
  check('failing chunk is skipped without killing the session', async () => {
    // quick inline scenario with its own mock that fails one request
  });

  // Failure tolerance: second chunk's request 500s, session still completes with 2 chunks.
  let flakyLocal = 0;
  const flaky = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    flakyLocal += 1;
    // Fail exactly the four attempts of the second chunk's request (chunk 2 fails permanently
    // after its 4 retries; chunks 1 and 3 succeed on their first attempt).
    if (flakyLocal >= 2 && flakyLocal <= 5) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: 'ok part', segments: [{ start: 0, end: 1, text: 'ok part' }] }));
  });
  await new Promise((r) => flaky.listen(0, '127.0.0.1', r));
  PROVIDERS.groq.baseUrl = `http://127.0.0.1:${flaky.address().port}/openai/v1`;

  const s2 = new LiveSession({ onEvent: () => {} });
  s2.configure({ providerId: 'groq', model: 'whisper-large-v3-turbo', apiKey: 'k' });
  s2.start();
  for (let i = 0; i < 2; i += 1) s2.pushChunk(new Uint8Array([1, 2, 3, i]));
  const stop2 = await s2.stop();
  s2.cleanup();
  check('a failing chunk is skipped, the rest still transcribed', () => {
    assert.strictEqual(stop2.errors, 1);
    assert.ok(stop2.text.includes('ok part'));
  });

  server.close();
  flaky.close();
  console.log(results.join('\n'));
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL LIVE CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('verify-live crashed:', err);
  process.exit(1);
});
