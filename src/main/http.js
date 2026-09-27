'use strict';
/**
 * Thin HTTP layer: rate limiting per provider, retries with backoff, friendly errors.
 * Uses global fetch/FormData/Blob (Node 18+ / Electron).
 */

const { getProvider } = require('./providers');

const lastRequestAt = new Map();

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError() {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  e.cancelled = true;
  return e;
}

/** Serialise requests per provider so we never trip the free-tier 1 req/sec ceiling. */
async function throttle(providerId, signal) {
  const min = getProvider(providerId).minRequestIntervalMs;
  const now = Date.now();
  const prev = lastRequestAt.get(providerId) || 0;
  const wait = Math.max(0, prev + min - now);
  lastRequestAt.set(providerId, now + wait);
  if (wait > 0) await sleep(wait, signal);
}

function describeHttpError(status, bodyText, providerLabel) {
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed?.error?.message || parsed?.message || parsed?.detail || '';
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {
    detail = (bodyText || '').slice(0, 300);
  }
  switch (status) {
    case 401:
    case 403:
      return `${providerLabel} rejected the API key (HTTP ${status}). ${detail}`;
    case 402:
      return `${providerLabel} says this account has no credit for that model (HTTP 402). ${detail}`;
    case 413:
      return `${providerLabel} says the upload is too large (HTTP 413). Lower "Segment length" in Settings. ${detail}`;
    case 429:
      return `${providerLabel} rate limit hit (HTTP 429). ${detail}`;
    default:
      return `${providerLabel} error HTTP ${status}. ${detail}`;
  }
}

/**
 * POST with retry. `makeBody()` returns { body, headers } so multipart parts are rebuilt per attempt.
 */
async function postWithRetry({ providerId, path, apiKey, makeBody, signal, onLog = () => {}, attempts = 4, extraHeaders = {} }) {
  const provider = getProvider(providerId);
  const url = `${provider.baseUrl}${path}`;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal && signal.aborted) throw abortError();
    await throttle(providerId, signal);
    let res;
    try {
      const { body, headers } = await makeBody();
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, ...headers, ...extraHeaders },
        body,
        signal
      });
    } catch (err) {
      if (err.cancelled || err.name === 'AbortError') throw abortError();
      lastErr = new Error(`Could not reach ${provider.label}: ${err.message}`);
      onLog(`${lastErr.message} (attempt ${attempt}/${attempts})`);
      if (attempt === attempts) throw lastErr;
      await sleep(Math.min(15000, 1500 * 2 ** (attempt - 1)), signal);
      continue;
    }

    if (res.ok) {
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return { text };
      }
    }

    const bodyText = await res.text();
    const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
    const message = describeHttpError(res.status, bodyText, provider.label);
    if (!retryable || attempt === attempts) {
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(30000, 1500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
    onLog(`${message} — retrying in ${(backoff / 1000).toFixed(1)}s (${attempt}/${attempts})`);
    lastErr = new Error(message);
    await sleep(backoff, signal);
  }
  throw lastErr || new Error('Request failed');
}

module.exports = { postWithRetry, sleep, abortError };
