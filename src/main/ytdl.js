'use strict';
/**
 * YouTube / podcast URLs via yt-dlp. The binary is fetched on demand (a few MB) the first
 * time you paste a link, into the app's data folder — that keeps the installer small.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { ffmpegPath } = require('./audio');

function binName() {
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

function binDir(userDataDir) {
  return path.join(userDataDir, 'bin');
}

function ytDlpPath(userDataDir) {
  return path.join(binDir(userDataDir), binName());
}

function download(url, dest, { onLog = () => {} } = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects while downloading yt-dlp.'));
    https.get(url, { headers: { 'User-Agent': 'scribe-app' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, { onLog }, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`yt-dlp download failed with HTTP ${res.statusCode}`));
      }
      const tmp = `${dest}.part`;
      const file = fs.createWriteStream(tmp);
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          fs.renameSync(tmp, dest);
          try { fs.chmodSync(dest, 0o755); } catch { /* windows */ }
          onLog(`yt-dlp installed (${(fs.statSync(dest).size / 1048576).toFixed(1)} MB).`);
          resolve(dest);
        });
      });
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureYtDlp(userDataDir, { onLog = () => {} } = {}) {
  const dest = ytDlpPath(userDataDir);
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(binDir(userDataDir), { recursive: true });
  onLog('First URL job: downloading yt-dlp…');
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${binName()}`;
  await download(url, dest, { onLog });
  return dest;
}

/** Downloads best audio for `url` into outDir; returns the media file path. */
async function downloadMedia(url, outDir, userDataDir, { signal, onLog = () => {} } = {}) {
  const bin = await ensureYtDlp(userDataDir, { onLog });
  fs.mkdirSync(outDir, { recursive: true });
  const args = [
    '--no-playlist', '--no-part', '--newline',
    '-f', 'bestaudio/best',
    '-x', '--audio-format', 'mp3', '--audio-quality', '5',
    '--ffmpeg-location', path.dirname(ffmpegPath()),
    '-o', path.join(outDir, '%(title).120B [%(id)s].%(ext)s'),
    url
  ];
  onLog(`Downloading audio from ${url}…`);
  await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let tail = '';
    child.stdout.on('data', (d) => { tail = (tail + d.toString()).slice(-4000); });
    child.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-4000); });
    const onAbort = () => child.kill();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) return resolve();
      reject(new Error(`yt-dlp failed (exit ${code}): ${tail.split('\n').slice(-4).join(' ').slice(0, 400)}`));
    });
    child.on('error', reject);
  });
  const files = fs.readdirSync(outDir)
    .filter((f) => /\.(mp3|m4a|webm|opus|wav|ogg|mp4|mkv)$/i.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(outDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!files.length) throw new Error('yt-dlp reported success but produced no media file.');
  const file = path.join(outDir, files[0].f);
  onLog(`Downloaded: ${files[0].f} (${(fs.statSync(file).size / 1048576).toFixed(1)} MB)`);
  return file;
}

module.exports = { ensureYtDlp, downloadMedia, ytDlpPath };
