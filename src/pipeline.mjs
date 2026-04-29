// ─── Universal DiffSinger Inference Pipeline ─────────────
// Works with any DiffSinger voicebank structure.
// Reads configs dynamically — no hardcoded model assumptions.

import * as ort from 'onnxruntime-node';
import { readFileSync } from 'fs';
import {
  i64, i64s, f32, f32s, bool1d,
  midiToHz, hzToMidi, frameMs, repeatEmbed, writeWav,
} from './utils.mjs';
import { loadSpeakerEmbed } from './voicebank.mjs';

const HEAD_FRAMES = 8;
const TAIL_FRAMES = 8;

// ─── Vowel set for word division ────────────────────────
const VOWELS = new Set([
  'a','i','e','o','u','N','SP','AP','A','E','Y',
  'ux','ae','aw','ax','ay','er','ey','ow','oy','uh','uw',
]);

function isVowel(phoneme) {
  // Multilingual phonemes like "ja/a" → check the part after /
  const part = phoneme.includes('/') ? phoneme.split('/')[1] : phoneme;
  return VOWELS.has(part);
}

// ─── Build word divisions ───────────────────────────────
function buildWordDiv(phonemes) {
  const vowelIdx = phonemes.map((p, i) => isVowel(p) ? i : -1).filter(i => i >= 0);
  if (vowelIdx.length === 0) return { wordDiv: [phonemes.length], vowelIndices: [phonemes.length - 1] };

  const wd = [vowelIdx[0] + 1];
  for (let i = 1; i < vowelIdx.length; i++) wd.push(vowelIdx[i] - vowelIdx[i - 1]);
  // trailing non-vowel phonemes
  const trailing = phonemes.length - 1 - vowelIdx[vowelIdx.length - 1];
  if (trailing > 0) wd.push(trailing);

  return { wordDiv: wd, vowelIndices: vowelIdx };
}

// ─── Compute word durations from phoneme durations ──────
function wordDurFromPhDur(phDur, wordDiv) {
  let idx = 0;
  return wordDiv.map(w => {
    let sum = 0;
    for (let j = 0; j < w; j++) sum += phDur[idx++];
    return sum;
  });
}

// ─── Run linguistic encoder ─────────────────────────────
async function runLinguistic(lingSession, tokens, wordDiv, wordDur, options = {}) {
  const feeds = {
    tokens: i64(tokens),
    word_div: i64(wordDiv),
    word_dur: i64(wordDur),
  };

  // Check if model supports languages
  if (lingSession.inputNames.includes('languages') && options.languages) {
    feeds.languages = i64(options.languages);
  }
  // Some models also accept ph_dur directly (phoneme mode)
  if (lingSession.inputNames.includes('ph_dur') && options.phDur) {
    feeds.ph_dur = i64(options.phDur);
  }

  const out = await lingSession.run(feeds);
  return { encoder_out: out.encoder_out, x_masks: out.x_masks };
}

// ─── Run duration predictor ─────────────────────────────
async function runDuration(session, encoderOut, xMasks, phMidi, spkEmbed, languages) {
  const nTokens = phMidi.length;
  const feeds = {
    encoder_out: encoderOut,
    x_masks: xMasks,
    ph_midi: i64(phMidi),
  };
  if (spkEmbed && session.inputNames.includes('spk_embed')) {
    feeds.spk_embed = new ort.Tensor('float32',
      repeatEmbed(spkEmbed, nTokens), [1, nTokens, spkEmbed.length]);
  }
  if (languages && session.inputNames.includes('languages')) {
    feeds.languages = i64(languages);
  }
  const out = await session.run(feeds);
  const raw = new Float32Array(out.ph_dur_pred.data.buffer, out.ph_dur_pred.data.byteOffset, nTokens);
  return Array.from(raw).map((v, i) => {
    // phonemes at boundaries (SP) can be 0, others min 1
    if (i === 0 || i === nTokens - 1) return Math.max(0, Math.round(v));
    return Math.max(1, Math.round(v));
  });
}

// ─── Run pitch predictor ─────────────────────────────────
async function runPitch(session, encoderOut, phDur, noteMidi, noteRest, noteDurFrames, spkEmbed, config) {
  const totalFrames = phDur.reduce((a, b) => a + b, 0);
  const feeds = {
    encoder_out: encoderOut,
    ph_dur: i64(phDur),
    note_midi: f32(noteMidi.map(Number)),
    note_dur: i64(noteDurFrames),
    pitch: f32(new Float32Array(totalFrames).fill(60)),
    retake: bool1d(new Uint8Array(totalFrames).fill(1)),
    steps: i64s(15),
  };
  if (session.inputNames.includes('speedup')) {
    feeds.speedup = i64s(50);
  }
  if (config.use_expr && session.inputNames.includes('expr')) {
    feeds.expr = f32(new Float32Array(totalFrames).fill(1.0));
  }
  if (config.use_note_rest && session.inputNames.includes('note_rest')) {
    feeds.note_rest = bool1d(noteRest.map(r => r ? 1 : 0));
  }
  if (spkEmbed && session.inputNames.includes('spk_embed')) {
    feeds.spk_embed = new ort.Tensor('float32',
      repeatEmbed(spkEmbed, totalFrames), [1, totalFrames, spkEmbed.length]);
  }
  const out = await session.run(feeds);
  return new Float32Array(out.pitch_pred.data.buffer, out.pitch_pred.data.byteOffset, totalFrames);
}

// ─── Run variance predictor ─────────────────────────────
async function runVariance(session, encoderOut, phDur, pitchSemitones, spkEmbed, config) {
  const totalFrames = phDur.reduce((a, b) => a + b, 0);
  const predicts = [
    config.predict_energy, config.predict_breathiness,
    config.predict_voicing, config.predict_tension,
  ].filter(Boolean);
  const numVar = predicts.length || 1;

  const feeds = {
    encoder_out: encoderOut,
    ph_dur: i64(phDur),
    pitch: f32(pitchSemitones),
    steps: i64s(10),
  };
  if (session.inputNames.includes('speedup')) {
    feeds.speedup = i64s(100);
  }
  if (session.inputNames.includes('tension')) {
    feeds.tension = f32(new Float32Array(totalFrames).fill(0));
  }
  if (session.inputNames.includes('energy')) {
    feeds.energy = f32(new Float32Array(totalFrames).fill(0));
  }
  if (session.inputNames.includes('breathiness')) {
    feeds.breathiness = f32(new Float32Array(totalFrames).fill(0));
  }
  if (session.inputNames.includes('voicing')) {
    feeds.voicing = f32(new Float32Array(totalFrames).fill(0));
  }
  if (session.inputNames.includes('retake')) {
    feeds.retake = new ort.Tensor('bool',
      new Uint8Array(totalFrames * numVar).fill(1), [1, totalFrames, numVar]);
  }
  if (spkEmbed && session.inputNames.includes('spk_embed')) {
    feeds.spk_embed = new ort.Tensor('float32',
      repeatEmbed(spkEmbed, totalFrames), [1, totalFrames, spkEmbed.length]);
  }

  const out = await session.run(feeds);
  const results = {};
  if (out.energy_pred) results.energy = new Float32Array(out.energy_pred.data.buffer, out.energy_pred.data.byteOffset, totalFrames);
  if (out.breathiness_pred) results.breathiness = new Float32Array(out.breathiness_pred.data.buffer, out.breathiness_pred.data.byteOffset, totalFrames);
  if (out.voicing_pred) results.voicing = new Float32Array(out.voicing_pred.data.buffer, out.voicing_pred.data.byteOffset, totalFrames);
  if (out.tension_pred) results.tension = new Float32Array(out.tension_pred.data.buffer, out.tension_pred.data.byteOffset, totalFrames);
  return results;
}

// ─── Run acoustic model ──────────────────────────────────
async function runAcoustic(session, tokens, phDur, f0Hz, variances, spkEmbed, voicebank) {
  const totalFrames = phDur.reduce((a, b) => a + b, 0);
  const cfg = voicebank.config;

  const feeds = {
    tokens: i64(tokens),
    durations: i64(phDur),
    f0: f32(f0Hz),
  };

  if (voicebank.useLangId && session.inputNames.includes('languages') && voicebank.languages) {
    // Default to Japanese (ja) or first language
    const langId = voicebank.languages.get('ja') || [...voicebank.languages.values()][0] || 0;
    const langs = new Array(tokens.length).fill(langId);
    feeds.languages = i64(langs);
  }

  if (session.inputNames.includes('tension') && variances.tension) {
    feeds.tension = f32(variances.tension);
  }
  if (session.inputNames.includes('energy') && variances.energy) {
    feeds.energy = f32(variances.energy);
  }
  if (session.inputNames.includes('breathiness') && variances.breathiness) {
    feeds.breathiness = f32(variances.breathiness);
  }
  if (session.inputNames.includes('voicing') && variances.voicing) {
    feeds.voicing = f32(variances.voicing);
  }
  if (session.inputNames.includes('gender')) {
    feeds.gender = f32(new Float32Array(totalFrames).fill(0));
  }
  if (session.inputNames.includes('velocity')) {
    feeds.velocity = f32(new Float32Array(totalFrames).fill(1.0));
  }
  if (spkEmbed && session.inputNames.includes('spk_embed')) {
    feeds.spk_embed = new ort.Tensor('float32',
      repeatEmbed(spkEmbed, totalFrames), [1, totalFrames, spkEmbed.length]);
  }
  if (session.inputNames.includes('steps')) {
    feeds.steps = i64s(15);
  }
  if (session.inputNames.includes('speedup')) {
    // Old-style: 1000 total steps, speedup = 1000 / desired_effective_steps
    // e.g. speedup=50 means every 50th step, effective 20 steps
    feeds.speedup = i64s(50);
  }
  if (session.inputNames.includes('depth')) {
    feeds.depth = f32s(1.0);
  }

  const out = await session.run(feeds);
  const melTensor = out.mel || out.spectrogram || out.mel_out || Object.values(out)[0];
  return melTensor;
}

// ─── Run vocoder ─────────────────────────────────────────
async function runVocoder(session, mel, f0Hz) {
  const totalFrames = mel.dims[1];
  const feeds = { mel };
  if (session.inputNames.includes('f0')) {
    feeds.f0 = f32(f0Hz);
  }
  const out = await session.run(feeds);
  const wavTensor = out.waveform || out.wav || out.audio || Object.values(out)[0];
  return new Float32Array(wavTensor.data.buffer, wavTensor.data.byteOffset, wavTensor.data.length);
}

// ══════════════════════════════════════════════════════════
// Main Pipeline
// ══════════════════════════════════════════════════════════

/**
 * Render a phrase through the full DiffSinger pipeline.
 *
 * @param {object} voicebank — from loadVoicebank()
 * @param {object} phrase — { phonemes: string[], tokenIds: number[], notes: [{midi, label}], noteMs: number[] }
 * @param {object} opts — { speaker?, steps?, outWav? }
 * @returns {Float32Array} waveform samples
 */
export async function renderPhrase(voicebank, phrase, opts = {}) {
  const speaker = opts.speaker || voicebank.speakers[0]?.name || 'standard';
  const outWav = opts.outWav || null;

  // ── Load embeds per pipeline ──
  const embAc = loadSpeakerEmbed(voicebank, speaker, 'acoustic');
  const embVar = loadSpeakerEmbed(voicebank, speaker, 'variance');
  const embDur = loadSpeakerEmbed(voicebank, speaker, 'dur');
  const embPitch = loadSpeakerEmbed(voicebank, speaker, 'pitch');

  // ── Prepare phoneme data ──
  const phonemes = ['SP', ...phrase.phonemes, 'SP'];
  // Use pre-computed token IDs, padded with SP
  const spId = voicebank.phonemeMap.get('SP') ?? 0;
  const paddedTokens = [spId, ...phrase.tokenIds, spId];
  // Variance tokens: if separate phoneme file, look up using same logic as caller
  const nTokens = phonemes.length;

  // Word divisions (based on phoneme surface forms)
  const { wordDiv, vowelIndices } = buildWordDiv(phonemes);
  console.log(`    Phonemes: [${phonemes}] (${nTokens} tokens)`);
  console.log(`    word_div: [${wordDiv}]`);

  // ph_midi for duration predictor
  const phMidi = phonemes.map((_, idx) => {
    // Map phoneme index to note
    for (let ni = phrase.notes.length - 1; ni >= 0; ni--) {
      const noteStart = (ni === 0 ? 0 : phrase.noteMs.slice(0, ni).reduce((a,b)=>a+b,0));
      const noteEnd = noteStart + phrase.noteMs[ni];
      // crude mapping: distribute evenly
      const frac = idx / (nTokens - 1);
      const totalMs = phrase.noteMs.reduce((a,b)=>a+b,0);
      const posMs = frac * totalMs;
      for (let nj = 0; nj < phrase.notes.length; nj++) {
        const nStart = phrase.noteMs.slice(0, nj).reduce((a,b)=>a+b,0);
        const nEnd = nStart + phrase.noteMs[nj];
        if (posMs >= nStart && posMs < nEnd) return Math.round(phrase.notes[nj].midi);
      }
      return Math.round(phrase.notes[phrase.notes.length - 1].midi);
    }
    return Math.round(phrase.notes[0]?.midi ?? 60);
  });
  console.log(`    ph_midi: [${phMidi}]`);

  // Initial word_dur (rough estimate from note durations)
  const fms = frameMs(voicebank.config.hop_size || 512, voicebank.config.sample_rate || 44100);
  const headMs = HEAD_FRAMES * fms;
  const tailMs = TAIL_FRAMES * fms;
  const totalNoteMs = phrase.noteMs.reduce((a, b) => a + b, 0);
  const totalMs = headMs + totalNoteMs + tailMs;
  const wordCount = wordDiv.length;
  const durPerWord = new Array(wordCount).fill(0).map((_, wi) => {
    if (wi === 0) return Math.round(headMs / fms);
    if (wi === wordCount - 1) return Math.round(tailMs / fms);
    // Distribute middle words evenly
    const midWords = wordCount - 2;
    if (midWords <= 0) return 0;
    return Math.round(totalNoteMs / fms / midWords);
  });
  console.log(`    word_dur (init): [${durPerWord}]`);

  // ═══ STEP 1: Load linguistic model ═══
  let lingPath = voicebank.linguisticPaths.dur || voicebank.linguisticPaths.pitch;
  if (!lingPath) throw new Error('No linguistic model found');
  console.log('  [1] Linguistic Encoder...');
  const lingSession = await ort.InferenceSession.create(lingPath);

  // ═══ STEP 2: Linguistic Encoder (word mode, initial) ═══
    const lingOut1 = await runLinguistic(lingSession, paddedTokens, wordDiv, durPerWord, {
    languages: voicebank.useLangId ? buildLangArray(phonemes, voicebank) : null,
  });
  console.log(`    encoder_out: [${lingOut1.encoder_out.dims}]`);

  let phDur = [HEAD_FRAMES,
    ...phrase.noteMs.map(ms => Math.round(ms / fms / 2)), // rough: 2 phonemes per note
    TAIL_FRAMES,
  ];
  // Flatten: one frame value per phoneme
  // Better approach: evenly distribute note frames across phonemes
  phDur = [HEAD_FRAMES];
  for (let ni = 0; ni < phrase.notes.length; ni++) {
    const noteFrames = Math.round(phrase.noteMs[ni] / fms);
    const phonPerNote = phrase.phonemes.filter((_, pi) => {
      // Simple assignment: each note has equal phonemes
      const startIdx = ni === 0 ? 0 : Math.round(phrase.phonemes.length / phrase.notes.length * ni);
      return false; // placeholder — we'll do a simpler assignment
    }).length || 1;
    // Actually, let me just do: 2 phonemes per note, first gets most frames
    const count = (ni === 0 ? 2 : (ni === phrase.notes.length - 1 ? 2 : 2));
    // FIX: just evenly distribute
    const perPh = Math.max(1, Math.round(noteFrames / count));
    for (let p = 0; p < count; p++) phDur.push(perPh);
  }
  phDur.push(TAIL_FRAMES);
  // Ensure phDur length matches nTokens
  while (phDur.length < nTokens) phDur.splice(1, 0, 1);
  while (phDur.length > nTokens) phDur.pop();

  let totalFrames = phDur.reduce((a, b) => a + b, 0);
  console.log(`    Initial ph_dur: [${phDur}] (${totalFrames} frames)`);

  // ═══ STEP 3: Duration Predictor ═══
  if (voicebank.subModelPaths.dur && voicebank.subConfigs.dur?.predict_dur) {
    console.log('  [2] Duration Predictor...');
    const durSession = await ort.InferenceSession.create(voicebank.subModelPaths.dur);
    console.log(`    dur inputs: [${durSession.inputNames}]`);
    const langArr = voicebank.useLangId ? buildLangArray(phonemes, voicebank) : null;
    phDur = await runDuration(durSession, lingOut1.encoder_out, lingOut1.x_masks, phMidi, embDur, langArr);
    phDur[0] = HEAD_FRAMES;
    phDur[phDur.length - 1] = TAIL_FRAMES;
    totalFrames = phDur.reduce((a, b) => a + b, 0);
    console.log(`    Predicted ph_dur: [${phDur}] (${totalFrames} frames)`);
  } else {
    console.log('  [2] Duration Predictor — SKIPPED (no dur model or predict_dur=false)');
  }

  // ═══ STEP 4: Re-run Linguistic Encoder with accurate durations ═══
  // Use separate linguistic models if available
  console.log('  [3] Linguistic Encoder (re-run with predicted durations)...');
  let lingOutPh, lingOutVar;
  const lingPaths = voicebank.linguisticPaths;

  // For pitch
  if (lingPaths.pitch && lingPaths.pitch !== lingPath) {
    const lingPitchSess = await ort.InferenceSession.create(lingPaths.pitch);
    const wdPh = wordDurFromPhDur(phDur, wordDiv);
    lingOutPh = (await runLinguistic(lingPitchSess, paddedTokens, wordDiv, wdPh, {
      languages: voicebank.useLangId ? buildLangArray(phonemes, voicebank) : null,
      phDur: voicebank.subConfigs.pitch?.predict_dur === false ? phDur : null, // phoneme mode
    })).encoder_out;
    // Check if this model uses ph_dur input (phoneme mode)
  } else {
    const wdPh = wordDurFromPhDur(phDur, wordDiv);
    const out = await runLinguistic(lingSession, paddedTokens, wordDiv, wdPh, {
      languages: voicebank.useLangId ? buildLangArray(phonemes, voicebank) : null,
    });
    lingOutPh = out.encoder_out;
  }

  // For variance
  if (lingPaths.variance && lingPaths.variance !== lingPath && lingPaths.variance !== lingPaths.pitch) {
    const lingVarSess = await ort.InferenceSession.create(lingPaths.variance);
    const wdV = wordDurFromPhDur(phDur, wordDiv);
    const varCfg = voicebank.subConfigs.variance || {};
    lingOutVar = (await runLinguistic(lingVarSess, paddedTokens, wordDiv, wdV, {
      languages: voicebank.useLangId ? buildLangArray(phonemes, voicebank) : null,
      phDur: varCfg.predict_dur === false ? phDur : null,
    })).encoder_out;
  } else {
    lingOutVar = lingOutPh || lingOut1.encoder_out;
  }

  console.log(`    encoder_out [${lingOutPh.dims}]`);

  // ═══ STEP 5: Pitch Predictor ═══
  let pitchSemitones;
  if (voicebank.subModelPaths.pitch) {
    console.log('  [4] Pitch Predictor (diffusion, 15 steps)...');
    const pitchSession = await ort.InferenceSession.create(voicebank.subModelPaths.pitch);
    const pitchCfg = voicebank.subConfigs.pitch || {};

    // Compute note_dur in frames, including head/tail SP.
    // IMPORTANT: sum must equal totalFrames exactly (no rounding errors).
    const noteFrameBody = totalFrames - HEAD_FRAMES - TAIL_FRAMES;
    const noteDurFrames = [];
    for (let ni = 0; ni < phrase.notes.length; ni++) {
      const frac = phrase.noteMs[ni] / totalNoteMs;
      noteDurFrames.push(Math.round(noteFrameBody * frac));
    }
    // Fix rounding to ensure sum matches
    let bodySum = noteDurFrames.reduce((a, b) => a + b, 0);
    let di = 0;
    while (bodySum !== noteFrameBody) {
      if (bodySum < noteFrameBody) { noteDurFrames[di % phrase.notes.length]++; bodySum++; }
      else { noteDurFrames[di % phrase.notes.length]--; bodySum--; }
      di++;
    }
    noteDurFrames[0] += HEAD_FRAMES;
    noteDurFrames[noteDurFrames.length - 1] += TAIL_FRAMES;
    console.log(`    note_dur: [${noteDurFrames}]`);

    const noteMidi = phrase.notes.map(n => n.midi);
    const noteRest = phrase.notes.map(() => false);

    pitchSemitones = await runPitch(
      pitchSession, lingOutPh, phDur,
      noteMidi, noteRest, noteDurFrames, embPitch, pitchCfg,
    );
    console.log(`    F0 range: ${Math.min(...pitchSemitones).toFixed(1)}–${Math.max(...pitchSemitones).toFixed(1)} semitones`);
  } else {
    // No pitch model — flat F0 from note MIDI
    console.log('  [4] Pitch Predictor — SKIPPED, using note MIDI');
    pitchSemitones = new Float32Array(totalFrames);
    let pos = 0;
    for (let ni = 0; ni < phrase.notes.length; ni++) {
      const dur = Math.round(phrase.noteMs[ni] / fms);
      for (let f = 0; f < dur && pos < totalFrames; f++, pos++) {
        pitchSemitones[pos] = phrase.notes[ni].midi;
      }
    }
    // Fill head/tail
    for (let f = 0; f < HEAD_FRAMES && f < totalFrames; f++) pitchSemitones[f] = phrase.notes[0].midi;
    for (let f = totalFrames - TAIL_FRAMES; f < totalFrames; f++) pitchSemitones[f] = phrase.notes[phrase.notes.length - 1].midi;
  }

  // ═══ STEP 6: Variance Predictor ═══
  let variances = {};
  if (voicebank.subModelPaths.variance) {
    const varCfg = voicebank.subConfigs.variance || {};
    const hasPred = varCfg.predict_energy || varCfg.predict_breathiness || varCfg.predict_voicing || varCfg.predict_tension;
    if (hasPred) {
      console.log('  [5] Variance Predictor (diffusion, 10 steps)...');
      const varSession = await ort.InferenceSession.create(voicebank.subModelPaths.variance);
      variances = await runVariance(varSession, lingOutVar, phDur, pitchSemitones, embVar, varCfg);
      for (const [k, v] of Object.entries(variances)) {
        if (v) console.log(`    ${k}: ${Math.min(...v).toFixed(3)}–${Math.max(...v).toFixed(3)}`);
      }
    } else {
      console.log('  [5] Variance Predictor — SKIPPED (nothing to predict)');
    }
  } else {
    console.log('  [5] Variance Predictor — SKIPPED (no variance model)');
  }

  // ═══ STEP 7: Acoustic Model ═══
  console.log('  [6] Acoustic Model (diffusion, 15 steps)...');
  const f0Hz = pitchSemitones.map(s => midiToHz(s));
  const acSession = await ort.InferenceSession.create(voicebank.acousticPath);
  const melTensor = await runAcoustic(acSession, paddedTokens, phDur, f0Hz, variances, embAc, voicebank);
  console.log(`    Mel: shape [${melTensor.dims}]`);

  // ═══ STEP 8: Vocoder ═══
  console.log('  [7] Vocoder...');
  const vocSession = await ort.InferenceSession.create(voicebank.vocoderPath);
  const waveform = await runVocoder(vocSession, melTensor, f0Hz);
  console.log(`    Waveform: ${waveform.length} samples (${(waveform.length / (voicebank.config.sample_rate || 44100)).toFixed(2)}s)`);

  if (outWav) {
    writeWav(outWav, waveform, voicebank.config.sample_rate || 44100);
    console.log(`    Saved: ${outWav}`);
  }

  return waveform;
}

// ─── Helper: Build language ID array ─────────────────────
function buildLangArray(phonemes, voicebank) {
  if (!voicebank.languages) return new Array(phonemes.length).fill(0);
  const defaultLang = voicebank.languages.get('ja') || [...voicebank.languages.values()][0] || 0;
  return phonemes.map(p => {
    if (p === 'SP' || p === 'AP') return 0;
    const parts = p.split('/');
    if (parts.length > 1 && voicebank.languages.has(parts[0])) {
      return voicebank.languages.get(parts[0]);
    }
    return defaultLang;
  });
}
