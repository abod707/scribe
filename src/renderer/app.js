'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  providers: [],
  settings: {},
  info: {},
  sources: [],
  running: false,
  activeTab: 'summary',
  last: { summary: '', transcript: '', segments: [], outputDir: '', source: '' },
  live: { running: false, recorder: null, streams: [], timer: null, startedAt: 0, text: '', segments: [], transcriptPath: '', summarizing: false }
};

/* ---------- helpers ---------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Tiny Markdown renderer: headings, bullets, bold, italics, inline code, paragraphs. */
function renderMarkdown(md) {
  const lines = escapeHtml(md || '').split('\n');
  const out = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const inline = (s) => s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
      continue;
    }
    closeList();
    if (/^###\s+/.test(line)) out.push(`<h3>${inline(line.replace(/^###\s+/, ''))}</h3>`);
    else if (/^##\s+/.test(line)) out.push(`<h2>${inline(line.replace(/^##\s+/, ''))}</h2>`);
    else if (/^#\s+/.test(line)) out.push(`<h2>${inline(line.replace(/^#\s+/, ''))}</h2>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

function log(message, isError = false) {
  const pre = $('log');
  const time = new Date().toLocaleTimeString();
  const line = document.createElement('span');
  if (isError) line.className = 'err';
  line.textContent = `[${time}] ${message}\n`;
  pre.appendChild(line);
  pre.scrollTop = pre.scrollHeight;
}

function setStatus(text) { $('status').textContent = text; }
function setBar(pct) { $('bar-fill').style.width = `${Math.max(0, Math.min(100, pct))}%`; }

function switchTab(name) {
  state.activeTab = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${name}`));
}

/* ---------- sources ---------- */

function renderSources() {
  const ul = $('sources');
  ul.innerHTML = '';
  $('src-count').textContent = String(state.sources.length);
  if (!state.sources.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing queued yet. Files never leave your machine except as audio sent to the provider you choose.';
    ul.appendChild(li);
    return;
  }
  state.sources.forEach((src, i) => {
    const li = document.createElement('li');
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = src.kind === 'url' ? 'link' : 'file';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = src.name;
    name.title = src.path || src.url;
    const rm = document.createElement('button');
    rm.textContent = '✕';
    rm.className = 'ghost';
    rm.addEventListener('click', () => { state.sources.splice(i, 1); renderSources(); });
    li.append(kind, name, rm);
    ul.appendChild(li);
  });
}

function addFiles(paths) {
  for (const p of paths) {
    if (!state.sources.some((s) => s.path === p)) {
      state.sources.push({ kind: 'file', path: p, name: p.split(/[\\/]/).pop() });
    }
  }
  renderSources();
}

function addUrl(url) {
  const clean = url.trim();
  if (!clean) return;
  state.sources.push({ kind: 'url', url: clean, name: clean.replace(/^https?:\/\/(www\.)?/, '').slice(0, 70) });
  renderSources();
}

/* ---------- models / settings ---------- */

function renderChips() {
  const label = (ref) => {
    const [pid, model] = String(ref).split(':');
    const p = state.providers.find((x) => x.id === pid);
    if (!p) return ref;
    const m = [...p.asrModels, ...p.chatModels].find((x) => x.id === model);
    return `${p.label}: ${m ? m.label.split(' — ')[0] : model}`;
  };
  $('chip-asr').textContent = `ASR · ${label(state.settings.asrModel)}`;
  $('chip-chat').textContent = `Summary · ${label(state.settings.chatModel)}`;
}

function fillModelSelects() {
  const asr = $('set-asr');
  const chat = $('set-chat');
  for (const [el, key] of [[asr, 'asrModels'], [chat, 'chatModels']]) {
    el.innerHTML = '';
    for (const p of state.providers) {
      const group = document.createElement('optgroup');
      group.label = `${p.label} — free tier`;
      for (const m of p[key]) {
        const opt = document.createElement('option');
        opt.value = `${p.id}:${m.id}`;
        opt.textContent = m.label;
        group.appendChild(opt);
      }
      el.appendChild(group);
    }
  }
  asr.value = state.settings.asrModel;
  chat.value = state.settings.chatModel;
}

function applySettingsToUi() {
  const s = state.settings;
  $('set-chunk').value = s.chunkMinutes || 15;
  $('set-concurrency').value = s.concurrency || 2;
  $('set-outdir').value = s.outputDir || '';
  $('set-keep').checked = Boolean(s.keepAudio);
  $('opt-style').value = s.summaryStyle || 'general';
  $('opt-outlang').value = s.outputLanguage || 'same';
  $('opt-translate').checked = Boolean(s.translateToEnglish);
  for (const p of state.providers) {
    const hint = $(`hint-${p.id}`);
    if (!hint) continue;
    const k = s.keys?.[p.id];
    hint.textContent = k?.present
      ? `Saved (${k.hint}). ${p.note} Upload cap ${p.maxUploadMb} MB.`
      : `No key saved. ${p.note}`;
  }
  $('store-hint').textContent = state.info.encryptionAvailable
    ? 'Keys are encrypted with Windows DPAPI and stay on this machine.'
    : 'Warning: OS-level encryption is unavailable, so keys are stored as plain text in settings.json.';
  renderChips();
}

async function refreshSettings() {
  const data = await window.scribe.getSettings();
  state.settings = data.settings;
  state.providers = data.providers;
  applySettingsToUi();
}

/* ---------- job ---------- */

function progressPercent(e) {
  // Cheap progress model: transcribe is ~85% of the work, summary the rest.
  if (e.stage === 'download') return 4;
  if (e.stage === 'prepare') return 8;
  if (e.stage === 'transcribe') return 8 + 77 * ((e.done ?? e.index ?? 0) / Math.max(1, e.total || 1));
  if (e.stage === 'summarize') return 85 + 14 * (((e.index || 0) + (e.state === 'done' ? 1 : 0)) / Math.max(1, e.total || 1));
  return 50;
}

function handleEvent(e) {
  if (e.type === 'log') {
    log(e.message);
    return;
  }
  if (e.type === 'stage') {
    const text = { download: 'Downloading audio…', prepare: 'Preparing audio…', transcribe: 'Transcribing…', summarize: 'Summarizing…' }[e.stage];
    if (text) setStatus(text);
    return;
  }
  if (e.type === 'progress') {
    setBar(progressPercent(e));
    return;
  }
  if (e.type === 'transcript') {
    state.last.transcript = e.text;
    state.last.segments = e.segments || [];
    state.last.source = e.source;
    $('pane-transcript').innerHTML = `<div class="prose"><p class="dim">${e.text.length.toLocaleString()} characters, ${(e.segments || []).length} timestamped segments.</p><pre id="log-t" style="white-space:pre-wrap">${escapeHtml(e.text)}</pre></div>`;
    return;
  }
  if (e.type === 'summary') {
    state.last.summary = e.markdown;
    $('pane-summary').innerHTML = `<div class="prose">${renderMarkdown(e.markdown)}</div>`;
    switchTab('summary');
    return;
  }
  if (e.type === 'done') {
    state.last.outputDir = e.outputDir;
    setBar(100);
    setStatus(`Done — ${(e.duration / 60).toFixed(1)} min of audio in ${e.outputDir}`);
    switchTab(state.last.summary ? 'summary' : 'transcript');
    return;
  }
  if (e.type === 'error') {
    log(e.message, true);
    setStatus(`Failed: ${e.message.slice(0, 120)}`);
    setBar(0);
    return;
  }
  if (e.type === 'idle') {
    setRunning(false);
  }
}

function setRunning(on) {
  state.running = on;
  $('btn-run').disabled = on;
  $('btn-run').classList.toggle('hidden', on);
  $('btn-cancel').classList.toggle('hidden', !on);
  $('btn-add').disabled = on;
  $('btn-url').disabled = on;
}

async function run() {
  if (state.running) return;

  const urlSources = state.sources.filter((s) => s.kind === 'url');
  const fileSources = state.sources.filter((s) => s.kind === 'file').map((s) => s.path);
  const summarize = $('opt-summarize').checked;

  if (!fileSources.length && !urlSources.length) {
    log('Add at least one file or link first.', true);
    return;
  }
  const asrProvider = String(state.settings.asrModel).split(':')[0];
  if (!state.settings.keys?.[asrProvider]?.present) {
    log(`No ${asrProvider} API key saved — open Settings and paste a free one.`, true);
    $('settings-dialog').showModal();
    return;
  }

  setRunning(true);
  setBar(1);
  switchTab('log');
  log(`Starting job: ${fileSources.length} file(s), ${urlSources.length} link(s).`);

  const jobs = [
    ...fileSources.map((p) => ({ files: [p], url: '' })),
    // Links are processed one at a time (yt-dlp handles a single URL per run).
    ...urlSources.map((s) => ({ files: [], url: s.url }))
  ];

  try {
    for (const job of jobs) {
      // eslint-disable-next-line no-await-in-loop
      const res = await window.scribe.startJob({
        ...job,
        summarize,
        language: $('opt-language').value,
        diarize: $('opt-diarize').checked,
        outputDir: state.settings.outputDir || ''
      });
      if (!res.ok) {
        log(res.message, !res.cancelled);
        if (res.cancelled) break;
      }
    }
  } finally {
    setRunning(false);
  }
}

/* ---------- live meeting mode (renderer capture) ---------- */

const LIVE_CHUNK_MS = 15000;

function liveFmt(seconds) {
  const t = Math.max(0, Math.floor(seconds));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}

function liveStatus(text, recording = state.live.running) {
  const el = $('live-status');
  el.textContent = text;
  el.classList.toggle('rec', recording);
}

function appendLiveLine(startSeconds, text) {
  const out = $('live-out');
  const ph = out.querySelector('.placeholder');
  if (ph) ph.remove();
  const line = document.createElement('p');
  line.className = 'live-line';
  const stamp = document.createElement('span');
  stamp.className = 'live-stamp';
  stamp.textContent = `[${liveFmt(startSeconds)}] `;
  line.append(stamp, document.createTextNode(text));
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
}

function handleLiveEvent(e) {
  if (e.type !== 'live') return;
  if (e.kind === 'log') log(e.message);
  if (e.kind === 'segments') {
    for (const s of e.segments || []) appendLiveLine(s.start, s.text);
    if ((!e.segments || !e.segments.length) && e.text) appendLiveLine(e.index * 15, e.text);
    state.live.text = [...state.live.text ? [state.live.text] : [], e.text].filter(Boolean).join('\n');
    for (const s of e.segments || []) state.live.segments.push(s);
  }
}

async function captureStreams() {
  const wantMic = $('live-mic').checked;
  const wantSystem = $('live-system').checked;
  if (!wantMic && !wantSystem) throw new Error('Pick at least one audio source (mic or meeting audio).');
  const streams = [];
  if (wantSystem) {
    // Chromium's display capture is the only reliable way to loop back system/meeting audio.
    const disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    for (const t of disp.getVideoTracks()) t.stop(); // audio is what we want; drop the video track at once
    if (!disp.getAudioTracks().length) throw new Error('No audio was shared — re-run and tick “Share audio” in the picker (or use mic only).');
    streams.push(disp);
  }
  if (wantMic) {
    streams.push(await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }));
  }
  return streams;
}

function recordNextChunk(stream, onChunk) {
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64000 });
  const parts = [];
  rec.ondataavailable = (ev) => { if (ev.data.size) parts.push(ev.data); };
  rec.onstop = () => {
    const blob = new Blob(parts, { type: 'audio/webm' });
    if (blob.size > 800) onChunk(blob); // skip empty silence-only chunks
  };
  rec.start();
  return rec;
}

function setLiveUi(running) {
  state.live.running = running;
  $('btn-live-start').classList.toggle('hidden', running);
  $('btn-live-stop').classList.toggle('hidden', !running);
  $('btn-live-cancel').classList.toggle('hidden', !running);
  $('btn-live-summarize').classList.toggle('hidden', running || !state.live.text);
  for (const id of ['live-mic', 'live-system']) $(id).disabled = running;
}

async function startLive() {
  if (state.live.running || state.running) return;
  const asrProvider = String(state.settings.asrModel).split(':')[0];
  if (!state.settings.keys?.[asrProvider]?.present) {
    log(`No ${asrProvider} API key saved — open Settings and paste a free one first.`, true);
    $('settings-dialog').showModal();
    return;
  }
  let streams;
  try {
    streams = await captureStreams();
  } catch (err) {
    log(`Could not start capture: ${err.message}`, true);
    return;
  }
  const res = await window.scribe.liveStart();
  if (!res.ok) {
    for (const s of streams) for (const t of s.getTracks()) t.stop();
    log(`Live start failed: ${res.message}`, true);
    return;
  }
  log(`Live session started (${res.model}). Text appears as people talk; a small pause every 15 s is normal.`);
  state.live.text = '';
  state.live.segments = [];
  state.live.transcriptPath = '';
  state.live.streams = streams;
  $('live-out').innerHTML = '';
  $('pane-summary').innerHTML = '<div class="placeholder"><p>Summary shows up here after you stop a live session.</p></div>';
  switchTab('live');
  setLiveUi(true);
  liveStatus('Recording…', true);

  const ctx = new AudioContext();
  state.live.ctx = ctx;
  const dest = ctx.createMediaStreamDestination();
  for (const s of streams) ctx.createMediaStreamSource(s).connect(dest);

  const sendChunk = async (blob) => {
    try {
      await window.scribe.liveChunk(new Uint8Array(await blob.arrayBuffer()));
    } catch (err) {
      log(`Chunk upload failed: ${err.message}`, true);
    }
  };
  const next = () => {
    if (!state.live.running) return;
    if (state.live.recorder?.state === 'recording') return; // a recorder is already open
    state.live.recorder = recordNextChunk(dest.stream, (blob) => { sendChunk(blob).then(next); });
  };
  // First chunk goes out after LIVE_CHUNK_MS, then the recorder restarts (self-contained webm files).
  state.live.recorder = recordNextChunk(dest.stream, (blob) => { sendChunk(blob).then(next); });
  state.live.timer = setInterval(() => {
    if (!state.live.running) return;
    if (state.live.recorder?.state === 'recording') state.live.recorder.stop();
    else next();
    liveStatus(`Recording… ${liveFmt((Date.now() - state.live.startedAt) / 1000)}`, true);
  }, LIVE_CHUNK_MS);
  state.live.startedAt = Date.now();

  // If the user ends screen sharing from the browser bar, stop gracefully.
  for (const s of streams) {
    s.getAudioTracks().forEach((t) => { t.onended = () => { if (state.live.running) stopLive(); }; });
  }
}

async function stopLive(cancelled = false) {
  if (!state.live.running) return;
  if (state.live.timer) clearInterval(state.live.timer);
  state.live.timer = null;
  try { if (state.live.recorder?.state !== 'inactive') state.live.recorder.stop(); } catch { /* already stopped */ }
  // Give the final blob a moment to flush through ondataavailable/onstop.
  await new Promise((r) => setTimeout(r, 400));
  for (const s of state.live.streams) for (const t of s.getTracks()) t.stop();
  state.live.streams = [];
  try { await state.live.ctx?.close(); } catch { /* already closed */ }
  setLiveUi(false);

  if (cancelled) {
    await window.scribe.liveCancel();
    liveStatus('Cancelled.');
    log('Live session cancelled.');
    return;
  }
  liveStatus('Finishing up — transcribing the last chunk…', false);
  const res = await window.scribe.liveStop();
  if (!res.ok) {
    liveStatus(`Failed: ${res.message}`);
    log(`Live stop failed: ${res.message}`, true);
    return;
  }
  state.live.text = res.transcript;
  state.live.segments = res.segments || [];
  state.live.transcriptPath = res.txtPath;
  state.last.transcript = res.transcript;
  state.last.segments = res.segments || [];
  state.last.outputDir = res.outputDir;
  state.last.source = `Live session ${new Date().toLocaleString()}`;
  const stamp = liveFmt(res.elapsed);
  $('pane-transcript').innerHTML = `<div class="prose"><p class="dim">Live session — ${stamp}, ${res.chunks} chunks, ${(res.transcript || '').length.toLocaleString()} characters. Saved to ${escapeHtml(res.txtPath)}</p><pre style="white-space:pre-wrap">${escapeHtml(res.transcript || '(nothing captured)')}</pre></div>`;
  setLiveUi(false);
  liveStatus(`Saved — ${stamp} of audio → ${res.txtPath}`, false);
  log(`Live transcript saved: ${res.txtPath}${res.errors ? ` (${res.errors} chunk(s) failed and were skipped)` : ''}`);
  if (res.errors) $('btn-live-summarize').classList.toggle('hidden', !state.live.text);
}

async function summarizeLive() {
  if (!state.live.text || state.live.summarizing) return;
  state.live.summarizing = true;
  $('btn-live-summarize').disabled = true;
  liveStatus('Summarizing…', false);
  try {
    const res = await window.scribe.liveSummarize(state.live.text);
    if (!res.ok) {
      log(`Summary failed: ${res.message}`, true);
      liveStatus(`Summary failed: ${res.message}`, false);
      return;
    }
    state.last.summary = res.markdown;
    $('pane-summary').innerHTML = `<div class="prose">${renderMarkdown(res.markdown)}</div>`;
    log(`Summary saved: ${res.mdPath}`);
    switchTab('summary');
    liveStatus('Summary ready.', false);
  } finally {
    state.live.summarizing = false;
    $('btn-live-summarize').disabled = false;
  }
}

/* ---------- export ---------- */

async function saveAs() {
  const kind = state.activeTab === 'transcript' ? 'txt' : state.activeTab === 'summary' ? 'summary' : 'json';
  const p = await window.scribe.saveExport({
    kind,
    source: state.last.source,
    transcript: state.activeTab === 'live' ? state.live.text : state.last.transcript,
    summary: state.last.summary,
    segments: state.activeTab === 'live' ? state.live.segments : state.last.segments
  });
  if (p) log(`Saved ${p}`);
}

/* ---------- wiring ---------- */

async function init() {
  state.info = await window.scribe.info();
  await refreshSettings();
  fillModelSelects();
  renderSources();

  window.scribe.onEvent(handleEvent);

  $('btn-add').addEventListener('click', async () => addFiles(await window.scribe.pickFiles()));
  $('btn-url').addEventListener('click', () => { addUrl($('url-input').value); $('url-input').value = ''; });
  $('url-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { addUrl($('url-input').value); $('url-input').value = ''; }
  });
  $('btn-run').addEventListener('click', run);
  $('btn-cancel').addEventListener('click', () => { log('Cancelling…'); window.scribe.cancelJob(); });
  $('btn-live-start').addEventListener('click', startLive);
  $('btn-live-stop').addEventListener('click', () => stopLive(false));
  $('btn-live-cancel').addEventListener('click', () => stopLive(true));
  $('btn-live-summarize').addEventListener('click', summarizeLive);
  window.scribe.onLiveEvent(handleLiveEvent);
  $('btn-settings').addEventListener('click', () => $('settings-dialog').showModal());
  $('btn-close').addEventListener('click', () => $('settings-dialog').close());

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('btn-copy').addEventListener('click', async () => {
    const text = state.activeTab === 'transcript' ? state.last.transcript
      : state.activeTab === 'live' ? state.live.text
      : state.last.summary;
    if (!text) return log('Nothing to copy yet.', true);
    await window.scribe.copy(text);
    log('Copied to clipboard.');
  });
  $('btn-save').addEventListener('click', saveAs);
  $('btn-folder').addEventListener('click', () => {
    if (state.last.outputDir) window.scribe.openPath(state.last.outputDir);
    else log('No output folder yet.', true);
  });

  for (const id of ['groq', 'mistral']) {
    $(`save-${id}`).addEventListener('click', async () => {
      const value = $(`key-${id}`).value;
      if (!value) return;
      await window.scribe.setKey(id, value);
      $(`key-${id}`).value = '';
      await refreshSettings();
      log(`${id} key saved.`);
      const res = await window.scribe.testKey(id);
      log(`Key check — ${res.ok ? 'OK' : 'FAILED'}: ${res.message}`, !res.ok);
    });
    $(`test-${id}`).addEventListener('click', async () => {
      const res = await window.scribe.testKey(id);
      log(`Key check — ${res.ok ? 'OK' : 'FAILED'}: ${res.message}`, !res.ok);
    });
  }

  document.querySelectorAll('[data-open]').forEach((a) => a.addEventListener('click', (ev) => {
    ev.preventDefault();
    const p = state.providers.find((x) => x.id === a.dataset.open);
    if (p?.keyUrl) window.open(p.keyUrl, '_blank');
  }));

  $('set-asr').addEventListener('change', async (e) => { await window.scribe.setSetting('asrModel', e.target.value); await refreshSettings(); });
  $('set-chat').addEventListener('change', async (e) => { await window.scribe.setSetting('chatModel', e.target.value); await refreshSettings(); });
  $('set-chunk').addEventListener('change', async (e) => { await window.scribe.setSetting('chunkMinutes', Number(e.target.value) || 15); await refreshSettings(); });
  $('set-concurrency').addEventListener('change', async (e) => { await window.scribe.setSetting('concurrency', Math.max(1, Math.min(4, Number(e.target.value) || 2))); await refreshSettings(); });
  $('set-keep').addEventListener('change', async (e) => { await window.scribe.setSetting('keepAudio', e.target.checked); await refreshSettings(); });
  $('pick-outdir').addEventListener('click', async () => {
    const dir = await window.scribe.pickOutputDir();
    if (dir) { $('set-outdir').value = dir; await window.scribe.setSetting('outputDir', dir); }
  });
  $('set-outdir').addEventListener('change', async (e) => { await window.scribe.setSetting('outputDir', e.target.value); await refreshSettings(); });
  $('opt-style').addEventListener('change', async (e) => { await window.scribe.setSetting('summaryStyle', e.target.value); await refreshSettings(); });
  $('opt-outlang').addEventListener('change', async (e) => { await window.scribe.setSetting('outputLanguage', e.target.value); await refreshSettings(); });
  $('opt-translate').addEventListener('change', async (e) => { await window.scribe.setSetting('translateToEnglish', e.target.checked); });

  log(`Scribe ${state.info.version} ready. Add files or a link, then hit Transcribe.`);
}

init().catch((err) => log(`Startup failed: ${err.message}`, true));
