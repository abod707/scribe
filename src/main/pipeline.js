'use strict';
/**
 * Job orchestration: source (file or URL) -> audio parts -> transcript -> summary -> files.
 * Emits events so the UI can show real progress, and is cancellable at any point.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareAudio, cleanup, humanDuration } = require('./audio');
const { transcribeParts } = require('./transcribe');
const { summarizeTranscript } = require('./summarize');
const { writeOutputs, slugify } = require('./export');
const { parseModelRef, DEFAULTS, getProvider } = require('./providers');
const { downloadMedia } = require('./ytdl');

function resolveModels(settings) {
  const asrRef = settings.get('asrModel');
  const chatRef = settings.get('chatModel');
  const asr = parseModelRef(asrRef);
  const chat = parseModelRef(chatRef);
  return {
    asrRef, chatRef,
    asrProvider: asr.provider, asrModel: asr.model || DEFAULTS.asr[asr.provider],
    chatProvider: chat.provider, chatModel: chat.model || DEFAULTS.chat[chat.provider]
  };
}

function missingKeyError(providerId) {
  return new Error(`No ${getProvider(providerId).label} API key saved. Add a free key in Settings (it takes a minute and needs no card).`);
}

/**
 * @param {object} opts
 * @param {string[]} [opts.files]     local media paths
 * @param {string}   [opts.url]       YouTube/podcast URL
 * @param {boolean}  [opts.summarize] run the summary stage
 * @param {string}   [opts.language]  'auto' or ISO code
 * @param {string}   [opts.outputDir] where to write results (defaults to next to the source / Downloads)
 * @param {(e:object)=>void} opts.onEvent
 */
async function runJob(opts, settings, { signal } = {}) {
  const { files = [], url, summarize = true, onEvent = () => {} } = opts;
  const emit = (type, payload = {}) => onEvent({ type, at: Date.now(), ...payload });
  const log = (message) => emit('log', { message });
  const progress = (p) => emit('progress', p);

  const models = resolveModels(settings);
  const asrKey = settings.getKey(models.asrProvider);
  const chatKey = summarize ? settings.getKey(models.chatProvider) : null;
  if (!asrKey) throw missingKeyError(models.asrProvider);
  if (summarize && !chatKey) throw missingKeyError(models.chatProvider);

  const outputs = [];
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-job-'));
  const concurrency = Math.max(1, Number(settings.get('concurrency')) || 2);

  try {
    // ---- 1. source ---------------------------------------------------------
    const sources = [];
    if (files && files.length) sources.push(...files);
    if (url) {
      emit('stage', { stage: 'download' });
      const dlDir = path.join(workRoot, 'download');
      const media = await downloadMedia(url, dlDir, opts.userDataDir, { signal, onLog: log });
      sources.push(media);
    }
    if (!sources.length) throw new Error('Nothing to transcribe — add a file or paste a URL.');

    for (const source of sources) {
      emit('stage', { stage: 'prepare', source });
      const chunkSeconds = Math.max(60, Number(settings.get('chunkMinutes')) * 60 || getProvider(models.asrProvider).chunkSeconds);
      const prepared = await prepareAudio(source, { chunkSeconds, signal, onLog: log });
      // Respect the provider cap even if the user asked for giant segments.
      const cap = getProvider(models.asrProvider).maxUploadBytes;
      const oversized = prepared.segments.find((s) => s.bytes > cap);
      if (oversized) {
        throw new Error(
          `Part ${oversized.index + 1} is ${(oversized.bytes / 1048576).toFixed(1)} MB, over ${getProvider(models.asrProvider).label}'s ` +
          `${(cap / 1048576).toFixed(0)} MB limit. Set a shorter "Segment length" in Settings.`
        );
      }

      emit('stage', { stage: 'transcribe', source });
      const t0 = Date.now();
      const asr = await transcribeParts({
        providerId: models.asrProvider,
        model: models.asrModel,
        apiKey: asrKey,
        segments: prepared.segments,
        language: opts.language || 'auto',
        diarize: models.asrProvider === 'mistral' && Boolean(opts.diarize),
        concurrency,
        signal,
        onLog: log,
        onProgress: progress
      });
      const transcribeSeconds = (Date.now() - t0) / 1000;
      log(`Transcript ready: ${asr.text.length} characters in ${transcribeSeconds.toFixed(1)}s.`);
      emit('transcript', { source, text: asr.text, segments: asr.segments, duration: prepared.duration });

      // ---- 2. summary ------------------------------------------------------
      let summary = '';
      if (summarize) {
        emit('stage', { stage: 'summarize', source });
        const s0 = Date.now();
        const res = await summarizeTranscript({
          transcript: asr.text,
          providerId: models.chatProvider,
          model: models.chatModel,
          apiKey: chatKey,
          style: settings.get('summaryStyle') || 'general',
          language: settings.get('outputLanguage') || 'same',
          translateToEnglish: Boolean(settings.get('translateToEnglish')),
          signal,
          onLog: log,
          onProgress: progress
        });
        summary = res.markdown;
        log(`Summary ready in ${((Date.now() - s0) / 1000).toFixed(1)}s (${res.windows} window(s), ${res.passes} call(s)).`);
        emit('summary', { source, markdown: summary });
      }

      // ---- 3. write --------------------------------------------------------
      const result = {
        source,
        slug: slugify(path.basename(source)),
        duration: prepared.duration,
        transcript: asr.text,
        segments: asr.segments,
        summary,
        meta: {
          asrModel: `${models.asrProvider}:${models.asrModel}`,
          chatModel: summarize ? `${models.chatProvider}:${models.chatModel}` : 'none',
          parts: prepared.segments.length,
          seconds: { transcribe: Math.round(transcribeSeconds) }
        }
      };

      const outputDir = opts.outputDir
        || settings.get('outputDir')
        || path.join(opts.defaultOutputDir || os.homedir(), slugify(path.basename(source)));
      const written = writeOutputs(outputDir, result);
      outputs.push({ source, outputDir, written, duration: prepared.duration, chars: asr.text.length });
      log(`Saved ${written.length} file(s) to ${outputDir}`);
      emit('done', { source, outputDir, written, summary, transcript: asr.text, segments: asr.segments, duration: prepared.duration });

      if (!settings.get('keepAudio')) cleanup(prepared.dir);
    }
    return { outputs };
  } finally {
    if (!settings.get('keepAudio')) cleanup(workRoot);
  }
}

module.exports = { runJob, resolveModels, humanDuration };
