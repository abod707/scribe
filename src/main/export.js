'use strict';
/** Output writers: Markdown, plain text, SRT subtitles, machine-readable JSON. */

const fs = require('fs');
const path = require('path');
const { humanDuration } = require('./audio');

function srtTime(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(sec)},${p(ms, 3)}`;
}

function toSrt(segments) {
  if (!segments || !segments.length) return '';
  return segments
    .map((seg, i) => `${i + 1}\n${srtTime(seg.start)} --> ${srtTime(seg.end)}\n${seg.text}${seg.speaker ? ` [${seg.speaker}]` : ''}\n`)
    .join('\n');
}

function toTimestampedText(segments) {
  return (segments || []).map((s) => `[${humanDuration(s.start)}] ${s.speaker ? `(${s.speaker}) ` : ''}${s.text}`).join('\n');
}

function toMarkdown({ source, duration, transcript, segments, summary, meta }) {
  const lines = [];
  lines.push(`# ${source}`);
  lines.push('');
  lines.push(`- Duration: ${humanDuration(duration || 0)}`);
  lines.push(`- Transcribed with: ${meta.asrModel}`);
  lines.push(`- Summarised with: ${meta.chatModel}`);
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push('');
  if (summary) {
    lines.push('# Summary');
    lines.push('');
    lines.push(summary.trim());
    lines.push('');
  }
  lines.push('# Transcript');
  lines.push('');
  lines.push(segments && segments.length ? toTimestampedText(segments) : transcript);
  lines.push('');
  return lines.join('\n');
}

/** Writes every format into outDir. Returns the list of paths written. */
function writeOutputs(outDir, result) {
  fs.mkdirSync(outDir, { recursive: true });
  const base = result.slug || 'transcript';
  const written = [];
  const put = (name, content) => {
    const p = path.join(outDir, name);
    fs.writeFileSync(p, content, 'utf8');
    written.push(p);
  };
  if (result.summary) put(`${base}.summary.md`, `# Summary — ${result.source}\n\n${result.summary.trim()}\n`);
  put(`${base}.transcript.md`, toMarkdown(result));
  put(`${base}.transcript.txt`, result.segments?.length ? toTimestampedText(result.segments) : result.transcript);
  if (result.segments?.length) put(`${base}.srt`, toSrt(result.segments));
  put(`${base}.json`, JSON.stringify({
    source: result.source,
    duration: result.duration,
    models: result.meta,
    summary: result.summary || '',
    transcript: result.transcript,
    segments: result.segments || []
  }, null, 2));
  return written;
}

function slugify(name) {
  return String(name || 'transcript')
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[^a-zA-Z0-9\u0600-\u06FF _-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'transcript';
}

module.exports = { writeOutputs, toSrt, toMarkdown, toTimestampedText, slugify, srtTime };
