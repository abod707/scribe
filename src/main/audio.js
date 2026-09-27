'use strict';
/**
 * Audio prep: one ffmpeg pass normalises to 16 kHz mono MP3 and cuts it into segments
 * small enough for the provider's upload cap. Whisper/Voxtral downsample to 16 kHz mono
 * anyway, so this costs no accuracy and makes uploads 5-10x smaller.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let cachedFfmpeg = null;

function ffmpegPath() {
  if (cachedFfmpeg) return cachedFfmpeg;
  let p;
  try {
    // eslint-disable-next-line global-require
    p = require('ffmpeg-static');
  } catch {
    p = null;
  }
  if (!p) throw new Error('ffmpeg binary not found. Run "npm install" (ffmpeg-static) or put ffmpeg on PATH.');
  // Packaged apps keep executables outside the asar archive.
  p = p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  if (!fs.existsSync(p)) throw new Error(`ffmpeg binary missing at ${p}`);
  cachedFfmpeg = p;
  return p;
}

function runFfmpeg(args, { signal, onStderr = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      onStderr(s);
    });
    const onAbort = () => child.kill('SIGKILL');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) {
        const e = new Error('Cancelled');
        e.cancelled = true;
        return reject(e);
      }
      if (code === 0) return resolve({ stdout, stderr });
      return reject(new Error(`ffmpeg failed (exit ${code}): ${stderr.split('\n').slice(-6).join(' ').slice(0, 400)}`));
    });
  });
}

/** Duration in seconds via ffmpeg's own banner (no ffprobe dependency). */
async function probeDuration(file, { signal } = {}) {
  try {
    await runFfmpeg(['-nostdin', '-hide_banner', '-i', file], { signal });
  } catch (err) {
    const m = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(err.message + '');
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    throw new Error(`Could not read media info for ${path.basename(file)}: ${err.message}`);
  }
  return 0;
}

function humanDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * Normalise + split. Returns { dir, segments: [{ file, index, startSeconds }], duration }.
 * `startSeconds` is exact when the source duration is known (segments are cut on the same grid).
 */
async function prepareAudio(inputFile, { chunkSeconds = 900, workDir, signal, onLog = () => {} } = {}) {
  const dir = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-'));
  fs.mkdirSync(dir, { recursive: true });
  const duration = await probeDuration(inputFile, { signal });
  const pattern = path.join(dir, 'part-%03d.mp3');
  onLog(`Extracting 16 kHz mono audio (${humanDuration(duration)}) and cutting into ${Math.round(chunkSeconds / 60)}-minute parts…`);
  await runFfmpeg([
    '-nostdin', '-hide_banner', '-y',
    '-i', inputFile,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k',
    '-f', 'segment', '-segment_time', String(chunkSeconds), '-reset_timestamps', '1',
    pattern
  ], { signal });

  const files = fs.readdirSync(dir).filter((f) => f.startsWith('part-') && f.endsWith('.mp3')).sort();
  if (!files.length) throw new Error('ffmpeg produced no audio segments — is this a media file?');
  const segments = files.map((f, i) => ({
    file: path.join(dir, f),
    index: i,
    startSeconds: i * chunkSeconds,
    bytes: fs.statSync(path.join(dir, f)).size
  }));
  const totalBytes = segments.reduce((a, s) => a + s.bytes, 0);
  onLog(`${segments.length} part(s), ${(totalBytes / 1048576).toFixed(1)} MB total.`);
  return { dir, segments, duration };
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

module.exports = { prepareAudio, probeDuration, humanDuration, cleanup, ffmpegPath, runFfmpeg };
