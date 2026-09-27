'use strict';
/**
 * Live meeting mode: the renderer captures mic + (optionally) meeting audio, and sends
 * short self-contained WebM/Opus chunks. This module transcribes them in order against
 * the configured ASR provider, emits rolling text to the UI, and on stop assembles the
 * full transcript on disk. No bot, no extra keys — same provider + key as file mode.
 */

const fs = require('fs');
const path = require('path');
const { transcribePart } = require('./transcribe');

const CHUNK_SECONDS = 15;

class LiveSession {
  constructor({ onEvent }) {
    this.onEvent = onEvent || (() => {});
    this.dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'scribe-live-'));
    this.chunkIndex = 0;          // next chunk id to record
    this.transcribing = 0;        // highest chunk id sent for transcription + 1
    this.queue = Promise.resolve();
    this.results = new Map();     // chunkIndex -> { text, segments }
    this.startedAt = 0;
    this.finished = false;
    this.aborted = false;
    this.errors = 0;
  }

  emit(payload) {
    this.onEvent({ ...payload, elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0 });
  }

  start() {
    this.startedAt = Date.now();
    this.emit({ type: 'live', kind: 'started' });
  }

  /**
   * Accept one recorded chunk (Uint8Array of a self-contained webm) and queue its
   * transcription. Chunks are transcribed strictly in order so the transcript reads
   * sequentially; a failing chunk is skipped with a log line, not fatal.
   */
  pushChunk(bytes) {
    if (this.finished || this.aborted || !bytes?.length) return;
    const index = this.transcribing;
    this.transcribing += 1;
    const file = path.join(this.dir, `chunk-${String(index).padStart(4, '0')}.webm`);
    try {
      fs.writeFileSync(file, Buffer.from(bytes));
    } catch (err) {
      this.emit({ type: 'live', kind: 'log', message: `Could not buffer chunk ${index + 1}: ${err.message}` });
      return;
    }
    this.emit({ type: 'live', kind: 'chunk', index });
    this.queue = this.queue.then(() => this.transcribeChunk(index, file));
  }

  async transcribeChunk(index, file) {
    if (this.aborted) return;
    const { providerId, model, apiKey, language } = this.spec;
    const startSeconds = index * CHUNK_SECONDS;
    try {
      const res = await transcribePart({
        providerId,
        model,
        apiKey,
        file,
        startSeconds,
        language,
        mimeType: 'audio/webm',
        onLog: (m) => this.emit({ type: 'live', kind: 'log', message: m })
      });
      this.results.set(index, res);
      this.emit({ type: 'live', kind: 'segments', index, text: res.text, segments: res.segments });
    } catch (err) {
      if (err.cancelled || this.aborted) return;
      this.errors += 1;
      this.emit({ type: 'live', kind: 'log', message: `Chunk ${index + 1} transcription failed (skipped): ${String(err.message).slice(0, 200)}` });
    } finally {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    }
  }

  /** Configure which provider/model/key transcribes chunks (called before start). */
  configure(spec) {
    this.spec = spec;
  }

  elapsedSeconds() {
    return this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
  }

  transcript() {
    const ordered = [...this.results.keys()].sort((a, b) => a - b);
    const text = ordered.map((i) => this.results.get(i).text).filter(Boolean).join('\n');
    const segments = ordered.flatMap((i) => this.results.get(i).segments || []);
    return { text, segments };
  }

  /** Stop accepting chunks and wait for the queue to drain. */
  async stop() {
    this.finished = true;
    await this.queue;
    const { text, segments } = this.transcript();
    const elapsed = this.elapsedSeconds();
    this.emit({ type: 'live', kind: 'stopped', text, segments, elapsedMs: elapsed * 1000 });
    return { text, segments, elapsed, chunks: this.transcribing, errors: this.errors };
  }

  cancel() {
    this.aborted = true;
    this.finished = true;
  }

  cleanup() {
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Timestamped markdown/txt of a live transcript, for saving. */
function toTimestampedText(segments, fallbackText) {
  if (!segments.length) return fallbackText || '';
  const fmt = (s) => {
    const t = Math.max(0, Math.floor(s));
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
  };
  return segments.map((s) => `[${fmt(s.start)}] ${s.text}`).join('\n');
}

module.exports = { LiveSession, toTimestampedText, CHUNK_SECONDS };
