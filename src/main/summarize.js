'use strict';
/**
 * Summarisation: map-reduce over the transcript so hour-long recordings fit inside
 * free-tier token ceilings, with a structured Markdown result.
 */

const { postWithRetry } = require('./http');

const STYLES = {
  general: {
    label: 'General notes',
    focus: 'Cover what was actually said: the main thread, the supporting detail, and anything a reader would want to quote.'
  },
  meeting: {
    label: 'Meeting',
    focus: 'Focus on decisions made, who owns what, deadlines, blockers, and open questions.'
  },
  lecture: {
    label: 'Lecture / class',
    focus: 'Focus on definitions, the sequence of concepts, worked examples, and anything an exam would ask about.'
  },
  interview: {
    label: 'Interview / podcast',
    focus: 'Focus on the guest\'s claims, stories, disagreements, and memorable lines with attribution.'
  },
  research: {
    label: 'Research / call notes',
    focus: 'Focus on methodology, findings, numbers, caveats, and next experiments.'
  }
};

const LANGUAGE_NAMES = {
  same: 'the language of the transcript',
  en: 'English',
  ar: 'Arabic',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  hi: 'Hindi',
  ur: 'Urdu',
  tr: 'Turkish',
  zh: 'Chinese',
  ja: 'Japanese'
};

const MAP_SYSTEM = 'You extract dense, faithful notes from raw transcripts. You never invent facts, names, or numbers. You keep the transcript\'s own terminology.';

function mapPrompt(partText, index, total, style) {
  return [
    `This is part ${index + 1} of ${total} of an automatically generated transcript (so expect recognition errors).`,
    style ? `Angle of interest: ${style}` : '',
    'Write compact bullet notes covering every substantive point, in order.',
    'Keep concrete names, numbers, dates, definitions, decisions and short verbatim quotes (mark them with quotes).',
    'Skip filler, greetings and repeated boilerplate. No preamble, no closing remarks.'
  ].filter(Boolean).join('\n');
}

function reducePrompt(notes, { style, language, translateToEnglish }) {
  const styleDef = STYLES[style] || STYLES.general;
  const lang = translateToEnglish ? 'English' : (LANGUAGE_NAMES[language] || LANGUAGE_NAMES.same);
  return [
    `Below are notes extracted from consecutive parts of one recording. Write a single coherent summary in ${lang}.`,
    `Style: ${styleDef.label}. ${styleDef.focus}`,
    '',
    'Output exactly this Markdown structure and nothing else:',
    '## TL;DR',
    '3-5 sentences a busy person can read in 20 seconds.',
    '',
    '## Key points',
    '- 5-12 bullets, most important first. Include the numbers and names that matter.',
    '',
    '## Actions & decisions',
    '- Bullets of decisions, owners, deadlines, and open questions. Write "None stated" if the recording has none.',
    '',
    '## Notable quotes',
    '- Up to 4 short verbatim quotes worth keeping, each with a one-line context note. Write "None" if nothing stands out.',
    '',
    'Do not add commentary about the task, the transcript quality, or yourself.',
    '',
    '--- NOTES ---',
    notes
  ].join('\n');
}

async function chatComplete({ providerId, model, apiKey, messages, temperature = 0.2, maxTokens = 2000, signal, onLog = () => {}, attempts = 4 }) {
  const payload = await postWithRetry({
    providerId,
    path: '/chat/completions',
    apiKey,
    signal,
    onLog,
    attempts,
    makeBody: () => ({
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      headers: { 'Content-Type': 'application/json' }
    })
  });
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`No summary returned (${providerId}:${model}). ${JSON.stringify(payload).slice(0, 200)}`);
  }
  return String(content).trim();
}

/** Split on paragraph/line boundaries into windows of roughly `size` characters. */
function windowText(text, size = 9000) {
  const blocks = text.split(/\n{2,}|(?<=\.)\s+(?=[A-Z])/g);
  const windows = [];
  let current = '';
  for (const block of blocks) {
    if (!block) continue;
    if (current.length + block.length + 1 > size && current) {
      windows.push(current.trim());
      current = block;
    } else {
      current += (current ? '\n' : '') + block;
    }
  }
  if (current.trim()) windows.push(current.trim());
  if (!windows.length) windows.push(text);
  return windows;
}

/**
 * Map-reduce summary. Returns { markdown, notes, passes }.
 * A single window skips the map stage (one call, cheaper and tighter).
 */
async function summarizeTranscript({
  transcript, providerId, model, apiKey, style = 'general', language = 'same',
  translateToEnglish = false, windowSize = 9000, signal, onLog = () => {}, onProgress = () => {}
}) {
  if (!transcript || transcript.trim().length < 40) {
    throw new Error('Transcript is too short to summarise.');
  }
  const windows = windowText(transcript, windowSize);
  onLog(`Summarising ${windows.length} transcript window(s) with ${providerId}:${model}…`);

  let notes;
  let passes = 0;
  if (windows.length === 1) {
    notes = transcript;
  } else {
    const parts = [];
    for (let i = 0; i < windows.length; i += 1) {
      onProgress({ stage: 'summarize', index: i, total: windows.length, state: 'start' });
      const partNotes = await chatComplete({
        providerId, model, apiKey, signal, onLog,
        messages: [
          { role: 'system', content: MAP_SYSTEM },
          { role: 'user', content: `${mapPrompt(windows[i], i, windows.length, (STYLES[style] || STYLES.general).focus)}\n\n--- TRANSCRIPT PART ---\n${windows[i]}` }
        ],
        temperature: 0.1,
        maxTokens: 1200
      });
      passes += 1;
      parts.push(partNotes);
      onLog(`Notes for window ${i + 1}/${windows.length} ready.`);
      onProgress({ stage: 'summarize', index: i, total: windows.length, state: 'done' });
    }
    notes = parts.join('\n\n');
  }

  onProgress({ stage: 'summarize', index: 0, total: 1, state: 'start' });
  const markdown = await chatComplete({
    providerId, model, apiKey, signal, onLog,
    messages: [
      { role: 'system', content: 'You are a meticulous editor who turns notes into tight, useful summaries.' },
      { role: 'user', content: reducePrompt(notes, { style, language, translateToEnglish }) }
    ],
    temperature: 0.25,
    maxTokens: 2500
  });
  passes += 1;
  onProgress({ stage: 'summarize', index: 0, total: 1, state: 'done' });

  return { markdown, notes, passes, windows: windows.length };
}

module.exports = { summarizeTranscript, chatComplete, windowText, STYLES, LANGUAGE_NAMES };
