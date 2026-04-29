// ─── Universal DiffSinger Smoke Test Runner ──────────────
// Tests all installed voicebanks with the same song phrase.
// Demonstrates the universal pipeline working across architectures.

import { loadVoicebank } from './src/voicebank.mjs';
import { renderPhrase } from './src/pipeline.mjs';
import { midiToHz, frameMs, writeWav } from './src/utils.mjs';
import { existsSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';

const MODELS_DIR = 'onnx-models';

// ─── Test phrase: "さくら さくら" (sakura sakura) ────────
// Melody: G4 A4 G4 — simple ascending-descending
// Each note ~280ms

const NOTES = [
  { midi: 67, label: 'さ' },
  { midi: 69, label: 'く' },
  { midi: 67, label: 'ら' },
  { midi: 67, label: 'さ' },
  { midi: 69, label: 'く' },
  { midi: 67, label: 'ら' },
];
const NOTE_MS = [280, 280, 280, 280, 280, 280];

// ─── Phoneme definitions per model ───────────────────────
// Each entry: { phonemes (no SP padding), phMidi (no padding) }
// Keyed by voicebank directory name

const PHRASE_DEFS = {
  // Netriko: flat symbols (no language prefix)
  'Netriko_Nakayama_AI_v100': (phMap) => {
    const p = s => phMap.get(s);
    return {
      phonemes: ['s','a', 'kx','ux', 'rx','a', 's','a', 'kx','ux', 'rx','a'],
      phMidi:   [ 67,67, 69, 69,   67, 67,  67,67, 69, 69,   67, 67],
    };
  },

  // Raine Reizo: ja/ prefix, json phoneme map
  '雷音冷蔵・Raine Reizo 2.01': (phMap) => {
    const get = s => phMap.get(`ja/${s}`) ?? phMap.get(s) ?? 0;
    return {
      phonemes: ['ja/s','ja/a', 'ja/k','ja/u', 'ja/r','ja/a',
                 'ja/s','ja/a', 'ja/k','ja/u', 'ja/r','ja/a'],
      phMidi:   [ 67,67,    69, 69,     67, 67,
                  67,67,    69, 69,     67, 67],
    };
  },

  // Allen_Crow & nessie: ja/ prefix
  'Allen_Crow_v170': (phMap) => {
    const get = s => phMap.get(`ja/${s}`) ?? phMap.get(s) ?? 0;
    return {
      phonemes: ['ja/s','ja/a', 'ja/k','ja/u', 'ja/r','ja/a',
                 'ja/s','ja/a', 'ja/k','ja/u', 'ja/r','ja/a'],
      phMidi:   [ 67,67,    69, 69,     67, 67,
                  67,67,    69, 69,     67, 67],
    };
  },
  'nessie': (phMap) => {
    const get = s => phMap.get(`ja/${s}`) ?? phMap.get(s) ?? 0;
    return {
      phonemes: ['ja/s','ja/a', 'ja/k','ja/u', 'ja/r','ja/a',
                 'ja/s','ja/a', 'ja/k','ja/u', 'ja/r','ja/a'],
      phMidi:   [ 67,67,    69, 69,     67, 67,
                  67,67,    69, 69,     67, 67],
    };
  },
};

// ─── Main ─────────────────────────────────────────────────
async function main() {
  // Discover voicebanks
  const entries = readdirSync(MODELS_DIR)
    .map(d => join(MODELS_DIR, d))
    .filter(d => {
      try { return statSync(d).isDirectory(); }
      catch { return false; }
    });

  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SynthDiff — Universal Smoke Test');
  console.log(`  Found ${entries.length} voicebanks`);
  console.log(`  Phrase: "${NOTES.map(n => n.label).join(' ')}" (${NOTES.length} notes)`);
  console.log(`  Melody: [${NOTES.map(n => n.midi).join(', ')}]`);
  console.log('═'.repeat(60));

  let passed = 0, failed = 0;

  for (const vpath of entries) {
    const name = basename(vpath);
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Voicebank: ${name}`);

    try {
      // ── Load ──
      const vb = await loadVoicebank(vpath);

      // ── Get phrase definition for this model ──
      let phDef;
      if (PHRASE_DEFS[name]) {
        phDef = PHRASE_DEFS[name](vb.phonemeMap);
      } else {
        // Generic fallback: try ja/ prefix for multilingual models
        const hasJa = vb.phonemeMap.has('ja/a') || vb.phonemeMap.has('ja/s');
        const prefix = hasJa ? 'ja/' : '';
        const get = s => vb.phonemeMap.get(prefix + s) ?? vb.phonemeMap.get(s) ?? 0;
        phDef = {
          phonemes: ['ja/s','ja/a', 'ja/k','ja/u', 'ja/r','ja/a',
                     'ja/s','ja/a', 'ja/k','ja/u', 'ja/r','ja/a'],
          phMidi:   [ 67,67,    69, 69,     67, 67,
                      67,67,    69, 69,     67, 67],
        };
      }

      // Look up token IDs — phonemes already in model-native format
      const tokenIds = phDef.phonemes.map(s => {
        const id = vb.phonemeMap.get(s);
        if (id === undefined) throw new Error(`Unknown phoneme: "${s}"`);
        return id;
      });

      console.log(`    Phonemes: [${phDef.phonemes}]`);
      console.log(`    Token IDs: [${tokenIds}]`);

      // ── Render ──
      const speaker = vb.speakers[0]?.name;
      const outPath = `output-${name.replace(/[^a-zA-Z0-9]/g, '_')}.wav`;

      const waveform = await renderPhrase(vb, {
        phonemes: phDef.phonemes,
        tokenIds,
        phMidi: phDef.phMidi,
        notes: NOTES,
        noteMs: NOTE_MS,
      }, {
        speaker,
        outWav: outPath,
      });

      passed++;
      console.log(`\n  ✓ PASSED — ${outPath} (${(waveform.length/44100).toFixed(1)}s)`);
    } catch (err) {
      failed++;
      console.error(`\n  ✗ FAILED: ${err.message}`);
      console.error(err.stack?.split('\n').slice(0, 3).join('\n'));
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed out of ${entries.length}`);
  console.log('═'.repeat(60));
}

main().catch(err => { console.error(err); process.exit(1); });
