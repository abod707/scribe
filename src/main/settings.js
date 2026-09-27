'use strict';
/**
 * Settings store. API keys are encrypted at rest with Electron safeStorage (DPAPI on Windows)
 * and never leave the machine except as an Authorization header to the provider you picked.
 * On non-Electron runs (tests) it falls back to a plain JSON file.
 */

const fs = require('fs');
const path = require('path');

let electron = null;
try {
  // eslint-disable-next-line global-require
  electron = require('electron');
} catch {
  electron = null;
}

const DEFAULTS = {
  asrModel: 'groq:whisper-large-v3-turbo',
  chatModel: 'groq:openai/gpt-oss-120b',
  outputLanguage: 'same',
  summaryStyle: 'general',
  chunkMinutes: 15,
  concurrency: 2,
  keepAudio: false,
  outputDir: '',
  translateToEnglish: false,
  keys: {} // providerId -> { value: <encrypted-or-plain>, enc: boolean }
};

function settingsPath(customPath) {
  if (customPath) return customPath;
  if (typeof electron?.app?.getPath !== 'function') return path.join(process.cwd(), '.scribe-settings.json');
  return path.join(electron.app.getPath('userData'), 'settings.json');
}

class Settings {
  constructor(customPath) {
    this.file = settingsPath(customPath);
    this.data = { ...DEFAULTS, keys: {} };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...DEFAULTS, ...raw, keys: { ...(raw.keys || {}) } };
    } catch {
      /* first run */
    }
    // Environment variables are a convenient fallback and always win if no key was saved.
    for (const id of ['groq', 'mistral']) {
      if (!this.getKey(id)) {
        const env = process.env[`${id.toUpperCase()}_API_KEY`];
        if (env) this.data.keys[id] = { value: env, enc: false };
      }
    }
  }

  save() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  encrypt(plain) {
    if (electron?.safeStorage?.isEncryptionAvailable?.()) {
      return { value: electron.safeStorage.encryptString(plain).toString('base64'), enc: true };
    }
    return { value: plain, enc: false };
  }

  decrypt(entry) {
    if (!entry) return '';
    if (!entry.enc) return entry.value || '';
    try {
      return electron.safeStorage.decryptString(Buffer.from(entry.value, 'base64'));
    } catch {
      return '';
    }
  }

  getKey(providerId) {
    return this.decrypt(this.data.keys[providerId]);
  }

  setKey(providerId, plain) {
    if (!plain) delete this.data.keys[providerId];
    else this.data.keys[providerId] = this.encrypt(plain.trim());
    this.save();
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  /** Safe view for the renderer: no secrets, just enough to render the UI. */
  snapshot() {
    const keys = {};
    for (const id of ['groq', 'mistral']) {
      const k = this.getKey(id);
      keys[id] = { present: Boolean(k), hint: k ? `${k.slice(0, 4)}…${k.slice(-4)}` : '' };
    }
    const { keys: _omit, ...rest } = this.data;
    return { ...rest, keys };
  }
}

module.exports = { Settings, DEFAULTS };
