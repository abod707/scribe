'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const { Settings } = require('./settings');
const { PROVIDERS, getProvider } = require('./providers');
const { runJob } = require('./pipeline');
const { windowText, summarizeTranscript } = require('./summarize');
const { writeOutputs, toSrt } = require('./export');
const { LiveSession, toTimestampedText } = require('./live');
const { parseModelRef } = require('./providers');

app.setName('Scribe');
if (!app.requestSingleInstanceLock()) app.quit();

let settings = null;
let mainWindow = null;
let currentJob = null; // { controller, cancelled }

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#0e1116',
    show: false,
    autoHideMenuBar: true,
    title: 'Scribe',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

function send(event) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('job:event', event);
}

app.whenReady().then(() => {
  settings = new Settings();

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    userDataDir: app.getPath('userData'),
    encryptionAvailable: Boolean(require('electron').safeStorage?.isEncryptionAvailable?.())
  }));

  ipcMain.handle('settings:get', () => ({
    settings: settings.snapshot(),
    providers: Object.values(PROVIDERS).map((p) => ({
      id: p.id, label: p.label, keyUrl: p.keyUrl, note: p.note,
      keyPrefix: p.keyPrefix,
      asrModels: p.asrModels, chatModels: p.chatModels,
      maxUploadMb: Math.round(p.maxUploadBytes / 1048576)
    }))
  }));

  ipcMain.handle('settings:set', (_e, { key, value }) => {
    settings.set(key, value);
    return settings.snapshot();
  });

  ipcMain.handle('settings:setKey', (_e, { provider, value }) => {
    settings.setKey(provider, value);
    return settings.snapshot();
  });

  ipcMain.handle('settings:testKey', async (_e, { provider: providerId }) => {
    const key = settings.getKey(providerId);
    if (!key) return { ok: false, message: 'No key saved yet.' };
    const provider = getProvider(providerId);
    try {
      const res = await fetch(`${provider.baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, message: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      const data = await res.json();
      const ids = (data?.data || []).map((m) => m.id);
      const wanted = [...provider.asrModels, ...provider.chatModels].map((m) => m.id).filter((id) => ids.includes(id));
      return { ok: true, message: `Key works. ${ids.length} models visible; matched: ${wanted.length ? wanted.join(', ') : 'none of the models this app uses — check your plan'}.` };
    } catch (err) {
      return { ok: false, message: `Request failed: ${err.message}` };
    }
  });

  ipcMain.handle('dialog:files', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Add audio or video',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Media', extensions: ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aac', 'wma', 'mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'ts'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('dialog:outputDir', async () => {
    const res = await dialog.showOpenDialog(mainWindow, { title: 'Choose output folder', properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? '' : res.filePaths[0];
  });

  ipcMain.handle('shell:openPath', async (_e, p) => shell.openPath(p));
  ipcMain.handle('shell:showItemInFolder', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(text || ''); return true; });

  ipcMain.handle('job:start', async (_e, payload) => {
    if (currentJob) return { ok: false, message: 'A job is already running.' };
    const controller = new AbortController();
    currentJob = { controller, cancelled: false, files: [] };
    try {
      const result = await runJob(
        {
          files: payload.files || [],
          url: payload.url || '',
          summarize: payload.summarize !== false,
          language: payload.language || 'auto',
          diarize: Boolean(payload.diarize),
          outputDir: payload.outputDir || '',
          userDataDir: app.getPath('userData'),
          defaultOutputDir: path.join(app.getPath('downloads'), 'Scribe'),
          onEvent: send
        },
        settings,
        { signal: controller.signal }
      );
      return { ok: true, result };
    } catch (err) {
      const cancelled = Boolean(err.cancelled) || controller.signal.aborted;
      if (!cancelled) send({ type: 'error', message: err.message });
      return { ok: false, cancelled, message: cancelled ? 'Cancelled.' : err.message };
    } finally {
      currentJob = null;
      send({ type: 'idle' });
    }
  });

  ipcMain.handle('job:cancel', () => {
    if (currentJob) {
      currentJob.cancelled = true;
      currentJob.controller.abort();
    }
    return true;
  });

  ipcMain.handle('export:save', async (_e, { kind, source, transcript, summary, segments }) => {
    const ext = kind === 'srt' ? 'srt' : kind === 'summary' ? 'md' : kind === 'json' ? 'json' : 'md';
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save as',
      defaultPath: `${String(source || 'transcript').replace(/\.[a-z0-9]{2,4}$/i, '')}.${kind === 'summary' ? 'summary.' : ''}${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    });
    if (res.canceled || !res.filePath) return '';
    let content = '';
    if (kind === 'srt') content = toSrt(segments);
    else if (kind === 'summary') content = summary || '';
    else if (kind === 'json') content = JSON.stringify({ source, transcript, summary, segments }, null, 2);
    else content = transcript || '';
    fs.writeFileSync(res.filePath, content, 'utf8');
    return res.filePath;
  });

/* ---------- live meeting mode ---------- */

let liveSession = null;

function sendLive(event) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('live:event', event);
}

function resolveAsr() {
  const { provider: providerId, model } = parseModelRef(settings.get('asrModel'));
  const apiKey = settings.getKey(providerId);
  if (!apiKey) throw new Error(`No ${providerId} API key saved — open Settings and add a free key first.`);
  return { providerId, model, apiKey };
}

ipcMain.handle('live:start', () => {
  if (liveSession && !liveSession.finished) return { ok: false, message: 'A live session is already running.' };
  try {
    const asr = resolveAsr();
    liveSession = new LiveSession({ onEvent: sendLive });
    liveSession.configure({
      providerId: asr.providerId,
      model: asr.model,
      apiKey: asr.apiKey,
      language: settings.get('outputLanguage') === 'same' ? undefined : settings.get('outputLanguage')
    });
    liveSession.start();
    return { ok: true, model: `${asr.providerId}:${asr.model}` };
  } catch (err) {
    sendLive({ type: 'live', kind: 'log', message: err.message });
    return { ok: false, message: err.message };
  }
});

ipcMain.handle('live:chunk', (_e, bytes) => {
  if (!liveSession || liveSession.finished) return false;
  liveSession.pushChunk(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  return true;
});

ipcMain.handle('live:stop', async () => {
  if (!liveSession) return { ok: false, message: 'No live session.' };
  const session = liveSession;
  try {
    const { text, segments, elapsed, chunks, errors } = await session.stop();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outDir = settings.get('outputDir') || path.join(app.getPath('downloads'), 'Scribe');
    fs.mkdirSync(outDir, { recursive: true });
    const base = path.join(outDir, `Live-${stamp}`);
    const txtPath = `${base}.txt`;
    fs.writeFileSync(txtPath, toTimestampedText(segments, text), 'utf8');
    if (settings.get('keepAudio')) {
      const keep = path.join(outDir, `Live-${stamp}-chunks`);
      fs.mkdirSync(keep, { recursive: true });
      for (const f of fs.readdirSync(session.dir)) fs.copyFileSync(path.join(session.dir, f), path.join(keep, f));
    }
    session.cleanup();
    return { ok: true, transcript: text, segments, elapsed, chunks, errors, txtPath, outputDir: outDir };
  } catch (err) {
    session.cleanup();
    liveSession = null;
    return { ok: false, message: err.message };
  } finally {
    if (liveSession === session) liveSession = null;
  }
});

ipcMain.handle('live:cancel', () => {
  if (liveSession) {
    liveSession.cancel();
    liveSession.cleanup();
    liveSession = null;
  }
  return true;
});

// Summarize a finished live transcript with the configured chat model (same map-reduce as files).
ipcMain.handle('live:summarize', async (_e, { transcript }) => {
  const { provider: providerId, model } = parseModelRef(settings.get('chatModel'));
  const apiKey = settings.getKey(providerId);
  if (!apiKey) return { ok: false, message: `No ${providerId} API key saved — open Settings and add a free key.` };
  try {
    const result = await summarizeTranscript({
      transcript,
      providerId,
      model,
      apiKey,
      style: settings.get('summaryStyle') || 'general',
      language: settings.get('outputLanguage') || 'same',
      translateToEnglish: Boolean(settings.get('translateToEnglish')),
      onLog: (m) => sendLive({ type: 'live', kind: 'log', message: m })
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outDir = settings.get('outputDir') || path.join(app.getPath('downloads'), 'Scribe');
    fs.mkdirSync(outDir, { recursive: true });
    const mdPath = path.join(outDir, `Live-${stamp}.summary.md`);
    fs.writeFileSync(mdPath, result.markdown, 'utf8');
    return { ok: true, markdown: result.markdown, mdPath };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

  createWindow();

  // Headless verification hook: render, screenshot, exit. Used by CI/dev smoke tests.
  if (process.env.SCRIBE_SMOKE) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const out = process.env.SCRIBE_SMOKE_OUT || path.join(process.cwd(), 'smoke.png');
        const shot = async (suffix, extraJs) => {
          if (extraJs) await mainWindow.webContents.executeJavaScript(extraJs, true);
          await new Promise((r) => setTimeout(r, 400));
          const image = await mainWindow.webContents.capturePage();
          const file = suffix ? out.replace(/\.png$/, `.${suffix}.png`) : out;
          fs.writeFileSync(file, image.toPNG());
          console.log(`SMOKE_SHOT ${file}`);
        };
        try {
          await shot('');
          await shot('activity', 'document.querySelector(\'[data-tab="log"]\').click(); document.querySelector("#url-input").value="https://www.youtube.com/watch?v=dQw4w9WgXcQ"; document.querySelector("#btn-url").click(); "ok"');
          await shot('live', 'document.querySelector(\'[data-tab="live"]\').click(); "ok"');
          await shot('settings', 'document.getElementById("settings-dialog").showModal(); "ok"');
          await shot('settings-bottom', 'const f=document.querySelector(".dialog-body"); f.scrollTop=f.scrollHeight; "ok"');
          console.log(`SMOKE_OK ${out}`);
        } catch (err) {
          console.log(`SMOKE_FAIL ${err.message}`);
        }
        app.exit(0);
      }, 2500);
    });
  }
});

app.on('second-instance', () => {
  if (mainWindow) mainWindow.focus();
});
app.on('window-all-closed', () => app.quit());

module.exports = { windowText };
