// ─── Project → InferenceJob converter ────────────────────
// Converts a UI project structure into a renderable phrase for the pipeline.
// Implements the data model from APP_SPEC.md §4 and phrase logic from §8.

import { tickToMs, durationFrames, frameMs, HEAD_FRAMES, TAIL_FRAMES, TICKS_PER_BEAT } from './time.mjs';
import { loadG2PForVoicebank } from './g2p.mjs';

// ─── Data types (inline — no TypeScript) ──────────────────

/**
 * @typedef {object} Note
 * @property {string} id
 * @property {number} tickStart — position in ticks
 * @property {number} tickLength — duration in ticks
 * @property {number} pitch — MIDI note number (60 = C4)
 * @property {string} lyric — display syllable
 * @property {string} [phoneticHint] — manual phoneme override
 * @property {string} [language] — per-note language (for multilingual)
 */

/**
 * @typedef {object} Curves
 * @property {boolean} useF0 — if true, f0 curve overrides pitch prediction
 * @property {number[]} [f0] — user-defined F0 curve samples
 * @property {number[]} [energy]
 * @property {number[]} [breathiness]
 * @property {number[]} [voicing]
 * @property {number[]} [tension]
 * @property {number[]} [gender]
 * @property {number[]} [velocity]
 * @property {number[]} [expression]
 */

// ─── Phrase builder ───────────────────────────────────────

/**
 * Build a renderable phrase from a list of notes.
 * Handles G2P, SP padding, word division, and MIDI assignment.
 *
 * @param {Note[]} notes — sorted by tickStart
 * @param {object} voicebank — loaded voicebank
 * @param {object} opts
 * @param {number} opts.bpm — tempo
 * @param {string} opts.language — default language for G2P
 * @param {Curves} opts.curves — user curves
 * @returns {object} phrase job ready for renderPhrase()
 */
export function buildPhraseJob(notes, voicebank, opts = {}) {
  const { bpm = 120, language = 'ja', curves = {} } = opts;
  const g2p = loadG2PForVoicebank(voicebank, language);
  const hopSize = voicebank.config.hop_size || 512;
  const sampleRate = voicebank.config.sample_rate || 44100;
  const fms = frameMs(hopSize, sampleRate);

  // ── 1. G2P: convert lyrics to phonemes ──
  const phonemeData = []; // per-phoneme info
  const notePhonemes = []; // phoneme arrays per note

  for (const note of notes) {
    let phonemes;
    if (g2p) {
      phonemes = g2p.resolveNote(note, language);
    } else if (note.phoneticHint) {
      phonemes = note.phoneticHint.split(/\s+/).filter(Boolean);
    } else {
      // Fallback: try to split lyric into characters (for Japanese)
      phonemes = [...note.lyric].filter(c => c.trim());
      if (phonemes.length === 0) phonemes = ['SP'];
    }
    notePhonemes.push(phonemes);
  }

  // ── 2. Compute durations in ms, convert to frames ──
  const phraseStartMs = tickToMs(notes[0].tickStart, bpm);
  let currentMs = phraseStartMs;

  const allPhonemes = [];
  const allPhMidi = [];
  const allPositions = []; // start ms per phoneme

  for (let ni = 0; ni < notes.length; ni++) {
    const note = notes[ni];
    const noteStartMs = tickToMs(note.tickStart, bpm);
    const noteEndMs = tickToMs(note.tickStart + note.tickLength, bpm);
    const phonemes = notePhonemes[ni];

    if (phonemes.length === 0) continue;

    // Evenly distribute note duration across phonemes
    const noteDurMs = noteEndMs - noteStartMs;
    const perPhonemeMs = noteDurMs / phonemes.length;

    for (let pi = 0; pi < phonemes.length; pi++) {
      const phStartMs = noteStartMs + pi * perPhonemeMs;
      const phEndMs = noteStartMs + (pi + 1) * perPhonemeMs;

      allPhonemes.push(phonemes[pi]);
      allPhMidi.push(Math.round(note.pitch));
      allPositions.push({ startMs: phStartMs, endMs: phEndMs, noteIndex: ni });
    }
  }

  // ── 3. Insert SP padding ──
  // Head SP: 8 frames before first phoneme
  // Tail SP: 8 frames after last phoneme
  const headMs = HEAD_FRAMES * fms;
  const tailMs = TAIL_FRAMES * fms;

  // Shift all positions forward by head padding
  const phraseMsOffset = allPositions.length > 0 ? allPositions[0].startMs - headMs : phraseStartMs;
  const totalBodyMs = allPositions.length > 0
    ? allPositions[allPositions.length - 1].endMs - allPositions[0].startMs
    : 0;
  const totalMs = headMs + totalBodyMs + tailMs;

  // ── 4. Build phoneme list WITHOUT padding (pipeline adds SP) ──
  const phonemes = allPhonemes;
  const phMidi = allPhMidi;

  // Look up token IDs
  const phMap = voicebank.phonemeMap;
  const tokenIds = phonemes.map(p => {
    const id = phMap.get(p);
    if (id === undefined) {
      const parts = p.split('/');
      const fallback = phMap.get(parts[parts.length - 1]);
      if (fallback !== undefined) return fallback;
      console.warn(`    Warning: unknown phoneme "${p}", using SP`);
      return phMap.get('SP') ?? 0;
    }
    return id;
  });

  // ── 5. Initial ph_dur estimate (with head/tail frames) ──
  // Pipeline will refine via duration predictor
  const phDur = [HEAD_FRAMES];
  for (let i = 0; i < allPositions.length; i++) {
    const fc = durationFrames(allPositions[i].startMs, allPositions[i].endMs, hopSize, sampleRate);
    phDur.push(Math.max(1, fc));
  }
  phDur.push(TAIL_FRAMES);

  const totalFrames = phDur.reduce((a, b) => a + b, 0);

  // ── 6. Build output ──
  return {
    phonemes,
    tokenIds,
    phMidi,
    phDur,

    notes: notes.map(n => ({ midi: n.pitch, label: n.lyric })),
    noteMs: notes.map(n => tickToMs(n.tickLength, bpm)),

    meta: {
      totalFrames,
      totalMs,
      phraseStartMs: phraseMsOffset,
      bpm,
      language,
    },

    // User curves (sampled later by pipeline or here)
    curves: {
      f0: curves.f0 || null,
      energy: curves.energy || null,
      breathiness: curves.breathiness || null,
      tension: curves.tension || null,
      gender: curves.gender || null,
      velocity: curves.velocity || null,
      expression: curves.expression || null,
      voicing: curves.voicing || null,
    },
  };
}

/**
 * Split notes into phrases (gap > 500ms = new phrase).
 * Follows APP_SPEC.md §8.4.
 */
export function splitIntoPhrases(notes, bpm = 120, thresholdMs = 500) {
  if (notes.length === 0) return [];

  const sorted = [...notes].sort((a, b) => a.tickStart - b.tickStart);
  const phrases = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = current[current.length - 1];
    const prevEndMs = tickToMs(prev.tickStart + prev.tickLength, bpm);
    const currStartMs = tickToMs(sorted[i].tickStart, bpm);

    if (currStartMs - prevEndMs > thresholdMs) {
      phrases.push(current);
      current = [sorted[i]];
    } else {
      current.push(sorted[i]);
    }
  }
  if (current.length > 0) phrases.push(current);

  return phrases;
}
