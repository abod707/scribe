'use strict';
/**
 * Provider registry. Everything here is free-tier friendly:
 *  - Groq: OpenAI-compatible /audio/transcriptions (whisper-large-v3[-turbo]) and /chat/completions.
 *  - Mistral: /audio/transcriptions (Voxtral) and /chat/completions, free "Experiment" plan.
 * Base URLs are overridable so the pipeline can be tested against a local mock server.
 */

const PROVIDERS = {
  groq: {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    keyPrefix: 'gsk_',
    note: 'Free tier: Whisper Large v3 / Turbo, 25 MB per upload, generous daily caps.',
    // Groq rejects uploads over 25 MB on the free tier.
    maxUploadBytes: 24 * 1024 * 1024,
    chunkSeconds: 900,
    minRequestIntervalMs: 1100,
    asrModels: [
      { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo — fastest (recommended)' },
      { id: 'whisper-large-v3', label: 'Whisper Large v3 — most accurate' }
    ],
    chatModels: [
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B — best summaries (recommended)' },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B — lighter, higher daily cap' },
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile' }
    ]
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    keyPrefix: '',
    note: 'Free "Experiment" plan: 1 req/sec per key. Voxtral takes long recordings in one request.',
    maxUploadBytes: 190 * 1024 * 1024,
    chunkSeconds: 3600,
    minRequestIntervalMs: 1100,
    asrModels: [
      { id: 'voxtral-mini-latest', label: 'Voxtral Mini Transcribe — diarization + timestamps (recommended)' },
      { id: 'voxtral-mini-transcribe-2602', label: 'Voxtral Mini Transcribe 2602' }
    ],
    chatModels: [
      { id: 'mistral-small-latest', label: 'Mistral Small — recommended' },
      { id: 'mistral-large-latest', label: 'Mistral Large — slower, sharper' },
      { id: 'ministral-8b-latest', label: 'Ministral 8B — lightest' }
    ]
  }
};

/** Accepts "groq:whisper-large-v3-turbo" and returns {provider, model}. */
function parseModelRef(ref, fallbackProvider) {
  if (!ref) throw new Error('No model selected');
  const idx = ref.indexOf(':');
  if (idx === -1) return { provider: fallbackProvider || 'groq', model: ref };
  return { provider: ref.slice(0, idx), model: ref.slice(idx + 1) };
}

function getProvider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown provider "${id}"`);
  return p;
}

function modelLabel(ref) {
  try {
    const { provider, model } = parseModelRef(ref);
    const list = [...PROVIDERS[provider].asrModels, ...PROVIDERS[provider].chatModels];
    const hit = list.find((m) => m.id === model);
    return `${PROVIDERS[provider].label} · ${hit ? hit.label.split(' — ')[0] : model}`;
  } catch {
    return ref;
  }
}

/** Default model choices per provider, used when a key is present but nothing was picked. */
const DEFAULTS = {
  asr: { groq: 'whisper-large-v3-turbo', mistral: 'voxtral-mini-latest' },
  chat: { groq: 'openai/gpt-oss-120b', mistral: 'mistral-small-latest' }
};

module.exports = { PROVIDERS, getProvider, parseModelRef, modelLabel, DEFAULTS };
