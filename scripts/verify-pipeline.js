'use strict';
/**
 * End-to-end verification of the pipeline without touching a real provider:
 *  1. starts a mock that speaks the Groq/Mistral HTTP shapes (incl. one deliberate 429),
 *  2. generates real audio with ffmpeg,
 *  3. runs the real pipeline (chunk -> transcribe -> summarize -> write files),
 *  4. asserts the things that actually break in the wild: chunk size vs upload cap,
 *     retry-on-429, timestamp offsets across parts, and the files that get written.
 *
 *   node scripts/verify-pipeline.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');

const { PROVIDERS } = require('../src/main/providers');
const { Settings } = require('../src/main/settings');
const { runJob } = require('../src/main/pipeline');
const { windowText, summarizeTranscript } = require('../src/main/summarize');
const { toSrt, slugify } = require('../src/main/export');
const { ffmpegPath } = require('../src/main/audio');

const TEST_SECONDS = 32 * 60; // 32 minutes -> 3 parts at a 15-minute segment length
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

const serverState = { transcriptionCalls: 0, transcriptionRequests: 0, chatCalls: 0, uploadBytes: [], sawMultipart: [], rateLimitedOnce: false, models: [], mapPrompts: 0, mistralCalls: 0, mistral422: 0 };

async function readMultipart(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const headers = JSON.stringify(req.headers);
  const contentType = req.headers['content-type'] || '';
  const model = /name="model"\r\n\r\n([^\r]+)/.exec(body.toString('latin1'))?.[1]?.trim() || '';
  const hasFile = /name="file"; filename="/.test(body.toString('latin1'));
  const fileBytes = body.length;
  return { body, headers, contentType, model, hasFile, fileBytes };
}

function startMockServer() {
  const server = http.createServer(async (req, res) => {
    const url = req.url || '';
    try {
      if (url.endsWith('/audio/transcriptions')) {
        const info = await readMultipart(req);
        assert.ok(info.hasFile, 'transcription request had no file part');
        assert.ok(/multipart\/form-data/.test(info.contentType), 'transcription request was not multipart');
        assert.ok(req.headers.authorization?.startsWith('Bearer '), 'missing bearer token');
        serverState.transcriptionRequests += 1;
        // Mistral's real API is pickier about optional fields; make the mock behave the same so the
        // degradation path gets exercised.
        if (url.startsWith('/v1/audio') && /timestamp_granularities/.test(info.body.toString('latin1'))) {
          serverState.mistral422 += 1;
          res.writeHead(422, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ detail: [{ msg: 'extra fields not permitted: timestamp_granularities' }] }));
          return;
        }
        if (!serverState.rateLimitedOnce) {
          serverState.rateLimitedOnce = true;
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
          res.end(JSON.stringify({ error: { message: 'rate limit reached, try again shortly' } }));
          return;
        }
        serverState.transcriptionCalls += 1;
        serverState.uploadBytes.push(info.fileBytes);
        serverState.sawMultipart.push(info.model);
        if (url.startsWith('/v1/audio')) serverState.mistralCalls += 1;
        const part = serverState.transcriptionCalls;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: info.model,
          text: `Part ${part} of the recording. The speaker covered wiring the sensor array, the cost of the free tier, and a deadline of March 3rd.`,
          segments: [
            { start: 0, end: 12.5, text: `Part ${part}: opening remarks about the sensor array.` },
            { start: 12.5, end: 30, text: `Part ${part}: budget discussion, free tier limits, March 3rd deadline.` }
          ]
        }));
        return;
      }
      if (url.endsWith('/chat/completions')) {
        const info = await readMultipart(req);
        let payload = {};
        try { payload = JSON.parse(info.body.toString('utf8')); } catch { /* ignore */ }
        serverState.chatCalls += 1;
        serverState.models.push(payload.model);
        const raw = info.body.toString('utf8');
        if (/part \d+ of \d+ of an automatically generated transcript/i.test(raw)) serverState.mapPrompts += 1;
        const isReducer = /TL;DR/.test(raw);
        const content = isReducer
          ? '## TL;DR\nWiring the sensor array was the main topic.\n\n## Key points\n- Sensor array wiring\n- Free tier budget limits\n\n## Actions & decisions\n- Deadline March 3rd\n\n## Notable quotes\n- "the sensor array"'
          : '- Sensor array wiring notes\n- Budget: free tier limits\n- Deadline: March 3rd';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: payload.model, choices: [{ message: { content } }] }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `unexpected path ${url}` } }));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message } }));
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function makeAudio(file, seconds) {
  return new Promise((resolve, reject) => {
    const args = ['-nostdin', '-hide_banner', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'libmp3lame', '-b:a', '64k', file];
    const child = spawn(ffmpegPath(), args);
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-400)))));
  });
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-verify-'));
  const server = await startMockServer();
  const port = server.address().port;
  // Point every provider at the mock.
  PROVIDERS.groq.baseUrl = `http://127.0.0.1:${port}/openai/v1`;
  PROVIDERS.mistral.baseUrl = `http://127.0.0.1:${port}/v1`;
  PROVIDERS.groq.minRequestIntervalMs = 5;
  PROVIDERS.mistral.minRequestIntervalMs = 5;

  const audio = path.join(work, 'lecture.mp3');
  console.log('Generating 32-minute test audio with ffmpeg…');
  await makeAudio(audio, TEST_SECONDS);

  const settings = new Settings(path.join(work, 'settings.json'));
  settings.setKey('groq', 'test-key-1234');
  settings.setKey('mistral', 'test-key-5678');
  settings.set('chunkMinutes', 15);
  settings.set('concurrency', 2);
  settings.set('summaryStyle', 'meeting');

  const logLines = [];
  const events = [];
  const outDir = path.join(work, 'out');

  const started = Date.now();
  await runJob({
    files: [audio],
    summarize: true,
    language: 'auto',
    outputDir: outDir,
    userDataDir: work,
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'log') logLines.push(e.message);
    }
  }, settings);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  // ---- assertions ---------------------------------------------------------
  check('ffmpeg split the 32-minute file into 3 parts at a 15-minute segment length', () => {
    assert.strictEqual(serverState.transcriptionCalls, 3, `expected 3 successful transcription calls, got ${serverState.transcriptionCalls}`);
    assert.strictEqual(serverState.transcriptionRequests, 4, `expected 4 total requests (3 parts + the deliberate 429), got ${serverState.transcriptionRequests}`);
  });

  check('every part of the recording made it into the transcript', () => {
    const done = events.find((e) => e.type === 'done');
    for (const n of [1, 2, 3]) assert.ok(done.transcript.includes(`Part ${n} of the recording`), `part ${n} missing from the transcript`);
  });

  check('a 429 from the provider was retried and the job still finished', () => {
    assert.ok(logLines.some((l) => /429/.test(l) && /retrying/i.test(l)), 'no retry was logged for the 429');
  });

  check('every part was uploaded with the model name and stayed under the 24 MB cap', () => {
    for (const bytes of serverState.uploadBytes) {
      assert.ok(bytes < 24 * 1048576, `part was ${(bytes / 1048576).toFixed(1)} MB`);
      assert.ok(bytes > 1000, 'part was suspiciously small');
    }
    assert.ok(serverState.sawMultipart.every((m) => m === 'whisper-large-v3-turbo'), `unexpected models: ${serverState.sawMultipart}`);
  });

  check('timestamps from later parts are offset (so .srt keeps real timecodes)', () => {
    const done = events.find((e) => e.type === 'done');
    const segments = done.segments;
    assert.ok(segments.length >= 6, `expected >=6 segments, got ${segments.length}`);
    const starts = segments.map((s) => s.start);
    for (let i = 1; i < starts.length; i += 1) assert.ok(starts[i] > starts[i - 1], `starts not increasing at ${i}`);
    const offsets = new Set(segments.map((s) => Math.floor(s.start / 60)));
    assert.ok(offsets.has(0) && offsets.has(15) && offsets.has(30), `expected segments around 0/15/30 min, saw ${[...offsets].join(',')}`);
  });

  check('a short transcript is summarised in one call (no pointless map pass)', () => {
    assert.strictEqual(serverState.chatCalls, 1, `expected 1 chat call for a 370-character transcript, got ${serverState.chatCalls}`);
  });

  check('the reducer produced the structured summary and it reached the UI event stream', () => {
    const summaryEvent = events.find((e) => e.type === 'summary');
    assert.ok(summaryEvent, 'no summary event was emitted');
    for (const heading of ['## TL;DR', '## Key points', '## Actions & decisions']) {
      assert.ok(summaryEvent.markdown.includes(heading), `missing ${heading}`);
    }
  });

  check('all four output formats were written next to the source copy', () => {
    const names = fs.readdirSync(outDir).sort();
    for (const suffix of ['.summary.md', '.transcript.md', '.transcript.txt', '.srt', '.json']) {
      assert.ok(names.some((n) => n.endsWith(suffix)), `missing ${suffix} (saw ${names.join(', ')})`);
    }
  });

  check('the .srt is well formed and reaches past the 15-minute mark', () => {
    const srt = fs.readFileSync(path.join(outDir, fs.readdirSync(outDir).find((n) => n.endsWith('.srt'))), 'utf8');
    assert.ok(/^1\r?\n00:00:00,000 --> 00:00:12,500/m.test(srt), 'first cue looks wrong');
    assert.ok(/00:1[5-9]:/.test(srt), 'no cues past 15 minutes — offsets are broken');
    const cueCount = srt.trim().split(/\r?\n\r?\n/).length;
    assert.strictEqual(cueCount, 6, `expected 6 cues, got ${cueCount}`);
  });

  check('the job event stream reported stages in order', () => {
    const stages = events.filter((e) => e.type === 'stage').map((e) => e.stage);
    assert.deepStrictEqual(stages, ['prepare', 'transcribe', 'summarize'], `saw ${stages.join(' -> ')}`);
  });

  // Mistral path: rejected optional field must degrade instead of failing the part.
  try {
    const { transcribePart } = require('../src/main/transcribe');
    const { prepareAudio } = require('../src/main/audio');
    const prep = await prepareAudio(audio, { chunkSeconds: 60000, workDir: path.join(work, 'mistralparts'), onLog: () => {} });
    const notes = [];
    const res = await transcribePart({
      providerId: 'mistral',
      model: 'voxtral-mini-latest',
      apiKey: 'test-key-5678',
      file: prep.segments[0].file,
      startSeconds: 0,
      language: 'en',
      onLog: (m) => notes.push(m)
    });
    assert.ok(res.text.length > 10, 'mistral transcription returned nothing');
    assert.ok(serverState.mistral422 >= 1, 'mock never rejected the optional field, degradation path untested');
    assert.ok(('' + notes.join(' ')).includes('rejected optional request fields'), 'no degradation note was logged');
    assert.strictEqual(serverState.mistralCalls, 1, `expected 1 successful mistral call, got ${serverState.mistralCalls}`);
    results.push('  PASS  Mistral path degrades when an optional field is rejected (422 -> retry without it)');
  } catch (err) {
    failures += 1;
    results.push(`  FAIL  Mistral optional-field degradation\n        ${err.message}`);
  }

  // async check: cancellation must abort cleanly
  try {
    const controller = new AbortController();
    const p = runJob({
      files: [audio], summarize: false, outputDir: path.join(work, 'out2'), userDataDir: work, onEvent: () => {}
    }, settings, { signal: controller.signal });
    setTimeout(() => controller.abort(), 120);
    let cancelled = false;
    try {
      await p;
    } catch (err) {
      cancelled = Boolean(err.cancelled);
    }
    if (!cancelled) throw new Error('aborting the signal did not surface a cancelled error');
    results.push('  PASS  cancellation aborts cleanly');
  } catch (err) {
    failures += 1;
    results.push(`  FAIL  cancellation aborts cleanly\n        ${err.message}`);
  }

  check('slugify keeps names filesystem-safe', () => {
    assert.strictEqual(slugify('Lecture 3: Mixing & Mastering (v2).mp3'), 'Lecture-3-Mixing-Mastering-v2');
    assert.strictEqual(slugify('مقدمة في البرمجة.mp3'), 'مقدمة-في-البرمجة');
    assert.strictEqual(toSrt([]), '');
  });

  // Map-reduce over a long transcript: this is the path an hour-long recording takes.
  try {
    const before = serverState.chatCalls;
    const beforeMap = serverState.mapPrompts;
    const long = Array.from({ length: 400 }, (_, i) => `Paragraph ${i}: the design review covered latency budgets, the widget schema, and the March 3rd deadline.`).join('\n\n');
    const windows = windowText(long, 9000).length;
    const res = await summarizeTranscript({
      transcript: long,
      providerId: 'groq',
      model: 'openai/gpt-oss-120b',
      apiKey: 'test-key-1234',
      style: 'meeting',
      language: 'same',
      onLog: () => {}
    });
    assert.ok(windows > 1, `expected the long transcript to split into several windows, got ${windows}`);
    assert.strictEqual(serverState.chatCalls - before, windows + 1, `expected ${windows} map calls + 1 reduce call, got ${serverState.chatCalls - before}`);
    assert.strictEqual(serverState.mapPrompts - beforeMap, windows, 'map prompt not used for every window');
    assert.ok(res.markdown.includes('## TL;DR'), 'reducer output missing headings');
    results.push(`  PASS  long transcript used ${windows} map calls + 1 reduce call`);
  } catch (err) {
    failures += 1;
    results.push(`  FAIL  long transcript map-reduce\n        ${err.message}`);
  }

  console.log(`\nMock server saw: ${serverState.transcriptionCalls} transcription calls, ${serverState.chatCalls} chat calls, `
    + `upload sizes ${serverState.uploadBytes.map((b) => `${(b / 1024).toFixed(0)} KB`).join(', ')}\n`);
  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} — pipeline ran in ${elapsed}s`);

  server.close();
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('VERIFY CRASHED:', err);
  process.exit(2);
});
