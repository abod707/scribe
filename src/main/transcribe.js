'use strict';
/**
 * Speech to text against Groq Whisper or Mistral Voxtral.
 * Both are multipart POSTs to /audio/transcriptions, so one implementation covers them.
 */

const fs = require('fs');
const path = require('path');
const { postWithRetry } = require('./http');
const { getProvider } = require('./providers');

function normalizeSegments(payload, startSeconds) {
  const raw = Array.isArray(payload?.segments) ? payload.segments : [];
  return raw
    .map((s) => ({
      start: Number(s.start ?? 0) + startSeconds,
      end: Number(s.end ?? 0) + startSeconds,
      text: String(s.text ?? '').trim(),
      speaker: s.speaker ?? s.speaker_id ?? null
    }))
    .filter((s) => s.text);
}

async function transcribePart({ providerId, model, apiKey, file, startSeconds = 0, language, diarize, signal, onLog = () => {}, mimeType = 'audio/mpeg' }) {
  const provider = getProvider(providerId);
  const bytes = fs.statSync(file).size;
  if (bytes > provider.maxUploadBytes) {
    throw new Error(
      `${path.basename(file)} is ${(bytes / 1048576).toFixed(1)} MB, over ${provider.label}'s ${(provider.maxUploadBytes / 1048576).toFixed(0)} MB cap. ` +
      'Lower "Segment length" in Settings.'
    );
  }

  // Optional fields degrade one at a time: providers differ in which extras they accept, and a
  // 422 on an optional flag should cost us the extras, not the whole job.
  const optionalSets = [
    { granularity: true, language: true, diarize: Boolean(diarize) },
    { granularity: false, language: true, diarize: Boolean(diarize) && providerId !== 'mistral' },
    { granularity: false, language: false, diarize: false }
  ];

  let payload;
  let lastError;
  for (let i = 0; i < optionalSets.length; i += 1) {
    const opts = optionalSets[i];
    try {
      payload = await postWithRetry({
        providerId,
        path: '/audio/transcriptions',
        apiKey,
        signal,
        onLog,
        // Only retry hard on the first shape; a rejected optional flag fails fast and we degrade.
        attempts: i === 0 ? 4 : 2,
        makeBody: () => {
          const form = new FormData();
          const buf = fs.readFileSync(file);
          form.append('file', new Blob([buf], { type: mimeType }), path.basename(file).replace(/\.[a-z0-9]+$/i, mimeType === 'audio/webm' ? '.webm' : '.mp3'));
          form.append('model', model);
          if (opts.language && language && language !== 'auto') form.append('language', language);
          if (providerId === 'groq') {
            // verbose_json gives us segment timestamps -> real .srt output.
            if (opts.granularity) {
              form.append('response_format', 'verbose_json');
              form.append('timestamp_granularities[]', 'segment');
            }
          } else {
            if (opts.granularity) form.append('timestamp_granularities[]', 'segment');
            if (opts.diarize) form.append('diarize', 'true');
          }
          return { body: form, headers: {} };
        }
      });
      if (i > 0) onLog(`Retried part without ${optionalSets[i - 1].granularity ? 'timestamp granularity' : 'language'} — provider rejected the optional field.`);
      lastError = null;
      break;
    } catch (err) {
      if (err.cancelled) throw err;
      lastError = err;
      const rejectable = err.status === 400 || err.status === 422;
      if (!rejectable || i === optionalSets.length - 1) throw err;
      onLog(`${provider.label} rejected optional request fields (HTTP ${err.status}); retrying with fewer options…`);
    }
  }
  if (lastError) throw lastError;

  const text = String(payload?.text ?? '').trim();
  return { text, segments: normalizeSegments(payload, startSeconds), model: payload?.model || model };
}

/**
 * Transcribe every part, optionally with bounded parallelism, preserving order.
 * Returns { text, segments, parts: [{index, chars, seconds}] }.
 */
async function transcribeParts({
  providerId, model, apiKey, segments, language, diarize = false,
  concurrency = 2, signal, onLog = () => {}, onProgress = () => {}
}) {
  const results = new Array(segments.length);
  let done = 0;
  let cursor = 0;
  let failure = null;

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, segments.length)) }, async () => {
    while (true) {
      if (failure) return;
      if (signal && signal.aborted) return;
      const i = cursor;
      cursor += 1;
      if (i >= segments.length) return;
      const seg = segments[i];
      try {
        onProgress({ stage: 'transcribe', index: i, total: segments.length, state: 'start' });
        onLog(`Transcribing part ${i + 1}/${segments.length} (${(seg.bytes / 1048576).toFixed(1)} MB)…`);
        const t0 = Date.now();
        const res = await transcribePart({ providerId, model, apiKey, file: seg.file, startSeconds: seg.startSeconds, language, diarize, signal, onLog });
        results[i] = res;
        done += 1;
        onLog(`Part ${i + 1} done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${res.text.length} chars.`);
        onProgress({ stage: 'transcribe', index: i, total: segments.length, state: 'done', done });
      } catch (err) {
        if (!failure) failure = err;
        return;
      }
    }
  });

  await Promise.all(workers);
  if (failure) throw failure;

  const text = results.map((r) => r?.text || '').filter(Boolean).join('\n\n');
  const allSegments = results.flatMap((r) => r?.segments || []);
  return { text, segments: allSegments, parts: results.map((r, i) => ({ index: i, chars: r?.text?.length || 0 })) };
}

module.exports = { transcribeParts, transcribePart };
