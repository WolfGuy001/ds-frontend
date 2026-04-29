// ─── Quick test for new modules ──────────────────────────
import { G2P, loadG2PForVoicebank } from './src/g2p.mjs';
import { tickToMs, msToFrames, sampleCurveOnFrameGrid, beatToTick, TICKS_PER_BEAT, TempoMap, HEAD_FRAMES, TAIL_FRAMES } from './src/time.mjs';
import { buildPhraseJob, splitIntoPhrases } from './src/project.mjs';
import { loadVoicebank } from './src/voicebank.mjs';
import { existsSync } from 'fs';
import { join } from 'path';

const MODELS_DIR = 'onnx-models';

async function main() {
  console.log('=== Testing G2P, Time, Project modules ===\n');

  // ── 1. G2P test ──
  console.log('[1] G2P — Netriko dsdict.yaml');
  const netrikoDict = join(MODELS_DIR, 'Netriko_Nakayama_AI_v100', 'dsdict.yaml');
  if (existsSync(netrikoDict)) {
    const g2p = new G2P(netrikoDict);
    g2p.load();
    console.log(`  Entries: ${g2p.entries.size}, Symbols: ${g2p.symbols.size}`);

    const tests = ['か', 'さ', 'に', 'あ', 'SP', 'R', '息'];
    for (const lyric of tests) {
      const ph = g2p.query(lyric);
      console.log(`  "${lyric}" → [${ph?.join(', ') ?? 'null'}]`);
    }
    console.log(`  isVowel('a'): ${g2p.isVowel('a')}, isVowel('k'): ${g2p.isVowel('k')}, isVowel('SP'): ${g2p.isVowel('SP')}`);
  } else {
    console.log('  SKIP — no dsdict.yaml found (need to restore configs)');
  }

  // ── 2. G2P — multilingual (Raine Reizo) ──
  console.log('\n[2] G2P — Raine Reizo (multilingual)');
  const raineDict = join(MODELS_DIR, '雷音冷蔵・Raine Reizo 2.01', 'dsdur', 'dsdict.yaml');
  if (existsSync(raineDict)) {
    const g2pJa = new G2P(raineDict, 'ja');
    g2pJa.load();
    console.log(`  Entries: ${g2pJa.entries.size}`);

    const tests = ['さ', 'く', 'ら', 'a', 'ka'];
    for (const lyric of tests) {
      const ph = g2pJa.query(lyric);
      console.log(`  "${lyric}" → [${ph?.join(', ') ?? 'null'}]`);
    }
  } else {
    console.log('  SKIP — no dsdict.yaml');
  }

  // ── 3. Time converters ──
  console.log('\n[3] Time converters');
  const bpm = 120;
  console.log(`  tickToMs(480, bpm=120) = ${tickToMs(480, 120).toFixed(1)} ms  (quarter note)`);
  console.log(`  tickToMs(1920, bpm=120) = ${tickToMs(1920, 120).toFixed(1)} ms  (whole note)`);
  console.log(`  msToFrames(500, 512, 44100) = ${msToFrames(500)} frames`);
  console.log(`  beatToTick(2, 0, 0) = ${beatToTick(2, 0, 0)} ticks  (bar 2, beat 0)`);

  // ── 4. Curve sampling ──
  console.log('\n[4] Curve sampling');
  const points = [
    { tick: 0, value: 60 },
    { tick: 960, value: 72 },
    { tick: 1920, value: 60 },
  ];
  const sampled = sampleCurveOnFrameGrid(points, 10, 0, 120, 0, 2, 2);
  console.log(`  3 points, 10 frames (head=2, tail=2): [${Array.from(sampled).map(v => v.toFixed(1)).join(', ')}]`);

  // ── 5. Project → Phrase ──
  console.log('\n[5] Project → Phrase (Netriko)');
  try {
    const vb = await loadVoicebank(join(MODELS_DIR, 'Netriko_Nakayama_AI_v100'));

    const notes = [
      { id: '1', tickStart: 0, tickLength: 480, pitch: 67, lyric: 'さ' },
      { id: '2', tickStart: 480, tickLength: 480, pitch: 69, lyric: 'く' },
      { id: '3', tickStart: 960, tickLength: 480, pitch: 67, lyric: 'ら' },
    ];

    const phrase = buildPhraseJob(notes, vb, { bpm: 120, language: 'ja' });
    console.log(`  Phonemes: [${phrase.phonemes}]`);
    console.log(`  Token IDs: [${phrase.tokenIds}]`);
    console.log(`  ph_dur: [${phrase.phDur}]`);
    console.log(`  totalFrames: ${phrase.meta.totalFrames}`);
    console.log(`  Notes: ${phrase.notes.length}`);

    // ── 6. Phrase splitting ──
    console.log('\n[6] Phrase splitting');
    const gapNotes = [
      { id: '1', tickStart: 0, tickLength: 480, pitch: 67, lyric: 'さ' },
      { id: '2', tickStart: 960, tickLength: 480, pitch: 67, lyric: 'く' }, // gap = 480 ticks = 500ms
      { id: '3', tickStart: 2400, tickLength: 480, pitch: 69, lyric: 'ら' }, // big gap
    ];
    const phrases = splitIntoPhrases(gapNotes, 120, 500);
    console.log(`  Input: 3 notes with gaps → ${phrases.length} phrases`);
    phrases.forEach((p, i) => console.log(`    Phrase ${i + 1}: ${p.length} notes`));

  } catch (e) {
    console.error(`  SKIP — ${e.message}`);
  }

  console.log('\n=== All module tests complete ===');
}

main().catch(console.error);
