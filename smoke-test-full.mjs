import * as ort from 'onnxruntime-node';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// ─── paths ────────────────────────────────────────────────
const VB = 'onnx-models/Netriko_Nakayama_AI_v100';
const PATH = {
  linguistic:    join(VB, 'dsmain/linguistic.onnx'),
  dur:           join(VB, 'dsdur/dur.onnx'),
  pitch:         join(VB, 'dspitch/pitch.onnx'),
  variance:      join(VB, 'dsvariance/variance.onnx'),
  acoustic:      join(VB, 'dsmain/acoustic.onnx'),
  vocoder:       join(VB, 'dsvocoder/netriko_hifigan.onnx'),
  phonemes:      join(VB, 'dsmain/phonemes.txt'),
  embVar:        join(VB, 'dsmain/embeds/variance/standard.emb'),
  embAc:         join(VB, 'dsmain/embeds/acoustic/standard.emb'),
};

const SAMPLE_RATE = 44100;
const HOP_SIZE = 512;
const HIDDEN_SIZE = 256;
const HEAD_FRAMES = 8;
const TAIL_FRAMES = 8;

// ─── helpers ──────────────────────────────────────────────
function loadPhonemeMap(filepath) {
  const lines = readFileSync(filepath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  return new Map(lines.map((p, i) => [p, i]));
}

function loadEmbed(filepath) {
  const buf = readFileSync(filepath);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function midiToHz(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

const i64 = data => new ort.Tensor('int64', new BigInt64Array(data.map(BigInt)), [1, data.length]);
const i64s = v => new ort.Tensor('int64', new BigInt64Array([BigInt(v)]), [1]);
const f32 = arr => new ort.Tensor('float32', new Float32Array(arr), [1, arr.length]);
const f32s = v => new ort.Tensor('float32', new Float32Array([v]), [1]);
const f32_3d = (data, dim2) => new ort.Tensor('float32', new Float32Array(data), [1, data.length / dim2, dim2]);
const bool1d = arr => new ort.Tensor('bool', new Uint8Array(arr), [1, arr.length]);
const bool3d = (data, dim2, dim3) => new ort.Tensor('bool', new Uint8Array(data), [1, data.length / (dim2 * dim3), dim2, dim3]);

function repeatEmbed(embed, nFrames) {
  const out = new Float32Array(nFrames * embed.length);
  for (let f = 0; f < nFrames; f++) out.set(embed, f * embed.length);
  return out;
}

function repeatEmbedPerToken(embed, nTokens) {
  // same as repeatEmbed, just named for clarity
  return repeatEmbed(embed, nTokens);
}

function writeWav(filepath, samples) {
  const bits = 16, ch = 1, sr = SAMPLE_RATE;
  const dataSize = samples.length * (bits / 8);
  const buf = Buffer.alloc(44 + dataSize);
  let off = 0;
  buf.write('RIFF', off); off += 4;
  buf.writeUInt32LE(44 + dataSize - 8, off); off += 4;
  buf.write('WAVE', off); off += 4;
  buf.write('fmt ', off); off += 4;
  buf.writeUInt32LE(16, off); off += 4;
  buf.writeUInt16LE(1, off); off += 2;
  buf.writeUInt16LE(ch, off); off += 2;
  buf.writeUInt32LE(sr, off); off += 4;
  buf.writeUInt32LE(sr * ch * bits / 8, off); off += 4;
  buf.writeUInt16LE(ch * bits / 8, off); off += 2;
  buf.writeUInt16LE(bits, off); off += 2;
  buf.write('data', off); off += 4;
  buf.writeUInt32LE(dataSize, off); off += 4;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7FFF), off + i * 2);
  }
  writeFileSync(filepath, buf);
}

// ─── main pipeline ────────────────────────────────────────
async function main() {
  console.log('=== SynthDiff Full Pipeline Smoke Test ===\n');

  // ── 0. Load shared resources ──
  console.log('[0/8] Loading shared resources...');
  const phMap = loadPhonemeMap(PATH.phonemes);
  console.log(`  Phonemes: ${phMap.size} entries`);
  const embVar = loadEmbed(PATH.embVar);
  const embAc = loadEmbed(PATH.embAc);
  console.log(`  Speaker embeds: variance=${embVar.length}, acoustic=${embAc.length}`);

  // ── 1. G2P + data prep ──
  console.log('\n[1/8] G2P — か に (ka ni)');
  // か → [kx, a]  (dsdict.yaml line 132)
  // に → [nj, i]  (dsdict.yaml line 223)
  const phonemesRaw = ['kx', 'a', 'nj', 'i'];
  const phonemes = ['SP', ...phonemesRaw, 'SP'];  // pad
  const nTokens = phonemes.length;  // 6

  const tokenIds = phonemes.map(p => phMap.get(p));
  console.log(`  Phonemes: [${phonemes}]`);
  console.log(`  Token IDs: [${tokenIds}]`);
  if (tokenIds.includes(undefined)) throw new Error('Unknown phoneme!');

  // word divisions: a "word" in DiffSinger = group ending with a vowel
  // SP is vowel-type (from dsdict.yaml symbols), so boundaries at: SP@0, a@2, i@4, SP@5
  const vowels = new Set(['a','i','e','o','u','N','SP','AP','A','E','Y','ux','ae','aw','ax','ay','er','ey','ow','oy','uh','uw']);
  const vowelIndices = phonemes.map((p, i) => vowels.has(p) ? i : -1).filter(i => i >= 0);
  console.log(`  Vowel indices: [${vowelIndices}]`);

  // Build word_div: sum MUST equal nTokens
  const word_div = [];
  word_div.push(vowelIndices[0] + 1);                          // phonemes including first vowel
  for (let vi = 1; vi < vowelIndices.length; vi++) {
    word_div.push(vowelIndices[vi] - vowelIndices[vi - 1]);     // phonemes between vowels
  }
  // Remaining phonemes AFTER last vowel (if any)
  const trailing = nTokens - 1 - vowelIndices[vowelIndices.length - 1];
  if (trailing > 0) word_div.push(trailing);
  console.log(`  word_div: [${word_div}]  (sum=${word_div.reduce((a,b)=>a+b,0)}, nTokens=${nTokens})`);

  // Notes
  const notes = [
    { midi: 67, label: 'か' },  // G4
    { midi: 69, label: 'に' },  // A4
  ];
  const noteMidi = notes.map(n => n.midi);           // [67, 69]
  const noteRest = notes.map(() => false);           // [false, false]

  // Initial word_dur estimate (must match word_div length)
  // word[0]=SP(head)=8, word[1]=kx+a~=22, word[2]=nj+i~=22, word[3]=SP(tail)=8
  const wordDurEst = [HEAD_FRAMES, 22, 22, TAIL_FRAMES];
  console.log(`  word_dur estimate: [${wordDurEst}] (total: ${wordDurEst.reduce((a,b)=>a+b,0)} frames)`);

  // ph_midi for dur.onnx (MIDI per phoneme)
  const phMidi = [notes[0].midi, notes[0].midi, notes[0].midi, notes[1].midi, notes[1].midi, notes[1].midi];
  // SP(head)=67, kx=67, a=67, nj=69, i=69, SP(tail)=69
  console.log(`  ph_midi: [${phMidi}]`);

  // ── 2. Linguistic Encoder (word mode, for duration + variance) ──
  console.log('\n[2/8] Linguistic Encoder — WORD mode (for duration predictor)');
  const lingSession = await ort.InferenceSession.create(PATH.linguistic);
  console.log(`  ling inputs: [${lingSession.inputNames.join(', ')}]`);
  console.log(`  ling outputs: [${lingSession.outputNames.join(', ')}]`);

  const lingWordFeeds = {
    tokens: i64(tokenIds),
    word_div: i64(word_div),
    word_dur: i64(wordDurEst),
  };
  const lingWordOut = await lingSession.run(lingWordFeeds);
  const encoderOutWord = lingWordOut.encoder_out;  // (1, n_tokens, hiddenSize)
  const xMasks = lingWordOut.x_masks;               // (1, n_tokens)
  console.log(`  encoder_out (word): shape [${encoderOutWord.dims}]`);

  // ── 3. Duration Predictor ──
  console.log('\n[3/8] Duration Predictor');
  const durSession = await ort.InferenceSession.create(PATH.dur);
  console.log(`  dur inputs: [${durSession.inputNames.join(', ')}]`);

  const durFeeds = {
    encoder_out: encoderOutWord,
    x_masks: xMasks,
    ph_midi: i64(phMidi),
  };
  if (durSession.inputNames.includes('spk_embed')) {
    const spkPerToken = new Float32Array(nTokens * HIDDEN_SIZE);
    for (let t = 0; t < nTokens; t++) spkPerToken.set(embVar, t * HIDDEN_SIZE);
    durFeeds.spk_embed = new ort.Tensor('float32', spkPerToken, [1, nTokens, HIDDEN_SIZE]);
  }
  const durOut = await durSession.run(durFeeds);
  const phDurPredRaw = new Float32Array(durOut.ph_dur_pred.data.buffer, durOut.ph_dur_pred.data.byteOffset, nTokens);

  // Round to int frames, enforce head/tail=8, min=1 for non-SP
  // Use Array.from to get a regular array (Float32Array.map returns typed array)
  const phDur = Array.from(phDurPredRaw, (v, i) => {
    if (phonemes[i] === 'SP') return Math.max(0, Math.round(v));
    return Math.max(1, Math.round(v));
  });
  // Force head/tail to 8
  phDur[0] = HEAD_FRAMES;
  phDur[phDur.length - 1] = TAIL_FRAMES;
  const totalFrames = phDur.reduce((a, b) => a + b, 0);
  console.log(`  ph_dur (raw): [${phDurPredRaw.map(v => v.toFixed(1)).join(', ')}]`);
  console.log(`  ph_dur (rounded): [${phDur}]`);
  console.log(`  Total frames: ${totalFrames}`);

  // ── 4. Linguistic Encoder (re-run with predicted durations, for pitch) ──
  console.log('\n[4/8] Linguistic Encoder — re-run with predicted ph_dur (for pitch)');
  // Compute word_dur from predicted phoneme durations
  let idx = 0;
  const wordDurFromPred = word_div.map(w => {
    let sum = 0;
    for (let j = 0; j < w; j++) sum += phDur[idx++];
    return sum;
  });
  console.log(`  word_dur (from predicted ph_dur): [${wordDurFromPred}]`);

  const lingPhFeeds = {
    tokens: i64(tokenIds),
    word_div: i64(word_div),
    word_dur: i64(wordDurFromPred),
  };
  const lingPhOut = await lingSession.run(lingPhFeeds);
  const encoderOutPh = lingPhOut.encoder_out;  // (1, n_tokens, hiddenSize)
  console.log(`  encoder_out (phoneme): shape [${encoderOutPh.dims}]`);

  // ── 5. Pitch Predictor ──
  console.log('\n[5/8] Pitch Predictor (diffusion, 15 steps)');
  const pitchSession = await ort.InferenceSession.create(PATH.pitch);
  console.log(`  pitch inputs: [${pitchSession.inputNames.join(', ')}]`);

  // note_dur from ph_dur: include head SP in note1, tail SP in note2
  // note1 covers phDur[0..2], note2 covers phDur[3..5]
  const noteDurFrames = [phDur[0] + phDur[1] + phDur[2], phDur[3] + phDur[4] + phDur[5]];
  console.log(`  Note frames: note1=${noteDurFrames[0]}, note2=${noteDurFrames[1]}`);

  const pitchInit = new Float32Array(totalFrames).fill(60);      // C4
  const retake = new Uint8Array(totalFrames).fill(1);            // all true
  const expr = new Float32Array(totalFrames).fill(1.0);          // full expressiveness

  const pitchFeeds = {
    encoder_out: encoderOutPh,
    ph_dur: i64(phDur),
    note_midi: f32(noteMidi),
    note_dur: i64(noteDurFrames),
    pitch: f32(pitchInit),
    retake: bool1d(retake),
    steps: i64s(15),
  };
  if (pitchSession.inputNames.includes('expr')) {
    pitchFeeds.expr = f32(expr);
  }
  if (pitchSession.inputNames.includes('note_rest')) {
    pitchFeeds.note_rest = bool1d(noteRest.map(r => r ? 1 : 0));
  }
  if (pitchSession.inputNames.includes('spk_embed')) {
    pitchFeeds.spk_embed = f32_3d(repeatEmbed(embVar, totalFrames), HIDDEN_SIZE);
  }

  // verify inputs
  const pitchProvided = new Set(Object.keys(pitchFeeds));
  const pitchMissing = pitchSession.inputNames.filter(n => !pitchProvided.has(n));
  if (pitchMissing.length) console.warn(`  WARNING: pitch missing inputs: ${pitchMissing}`);

  console.log(`  Running pitch diffusion (${totalFrames} frames)...`);
  const tPitch = Date.now();
  const pitchOut = await pitchSession.run(pitchFeeds);
  console.log(`  Pitch done in ${((Date.now() - tPitch) / 1000).toFixed(1)}s`);

  const pitchPred = new Float32Array(pitchOut.pitch_pred.data.buffer, pitchOut.pitch_pred.data.byteOffset, totalFrames);
  console.log(`  F0 range: ${pitchPred.map(v => v.toFixed(1)).slice(0, 5).join(', ')}... (semitones, first 5)`);

  // ── 6. Variance Predictor (tension only) ──
  console.log('\n[6/8] Variance Predictor (tension only, 10 steps)');
  const varSession = await ort.InferenceSession.create(PATH.variance);
  console.log(`  variance inputs: [${varSession.inputNames.join(', ')}]`);

  // retake for variance: (1, n_frames, numVariances=1)
  const retakeVar = new Uint8Array(totalFrames).fill(1);

  const varFeeds = {
    encoder_out: lingPhOut.encoder_out,   // re-run with accurate word_dur
    ph_dur: i64(phDur),
    pitch: f32(pitchPred),         // F0 semitones from pitch step
    tension: f32(new Float32Array(totalFrames).fill(0)),
    steps: i64s(10),
  };
  if (varSession.inputNames.includes('retake')) {
    varFeeds.retake = new ort.Tensor('bool', retakeVar, [1, totalFrames, 1]);
  }
  if (varSession.inputNames.includes('spk_embed')) {
    varFeeds.spk_embed = f32_3d(repeatEmbed(embVar, totalFrames), HIDDEN_SIZE);
  }

  const varProvided = new Set(Object.keys(varFeeds));
  const varMissing = varSession.inputNames.filter(n => !varProvided.has(n));
  if (varMissing.length) console.warn(`  WARNING: variance missing inputs: ${varMissing}`);

  console.log(`  Running variance diffusion (${totalFrames} frames)...`);
  const tVar = Date.now();
  const varOut = await varSession.run(varFeeds);
  console.log(`  Variance done in ${((Date.now() - tVar) / 1000).toFixed(1)}s`);

  // tension_pred is the output (only predict_tension=true)
  const tensionPred = new Float32Array(varOut.tension_pred.data.buffer, varOut.tension_pred.data.byteOffset, totalFrames);
  console.log(`  Tension range: ${tensionPred.map(v=>v.toFixed(3)).slice(0,5)}... (first 5)`);

  // ── 7. Acoustic Model ──
  console.log('\n[7/8] Acoustic Model (diffusion, 15 steps)');
  const acSession = await ort.InferenceSession.create(PATH.acoustic);
  console.log(`  acoustic inputs: [${acSession.inputNames.join(', ')}]`);

  // Convert F0 semitones → Hz
  const f0Hz = pitchPred.map(s => midiToHz(s));

  const acFeeds = {
    tokens: i64(tokenIds),
    durations: i64(phDur),
    f0: f32(f0Hz),
  };
  if (acSession.inputNames.includes('tension')) {
    acFeeds.tension = f32(tensionPred);
  }
  if (acSession.inputNames.includes('gender')) {
    acFeeds.gender = f32(new Float32Array(totalFrames).fill(0));
  }
  if (acSession.inputNames.includes('velocity')) {
    acFeeds.velocity = f32(new Float32Array(totalFrames).fill(1.0));
  }
  if (acSession.inputNames.includes('spk_embed')) {
    acFeeds.spk_embed = f32_3d(repeatEmbed(embAc, totalFrames), HIDDEN_SIZE);
  }
  if (acSession.inputNames.includes('steps')) {
    acFeeds.steps = i64s(15);
  }
  if (acSession.inputNames.includes('depth')) {
    acFeeds.depth = f32s(1.0);
  }

  const acProvided = new Set(Object.keys(acFeeds));
  const acMissing = acSession.inputNames.filter(n => !acProvided.has(n));
  if (acMissing.length) console.warn(`  WARNING: acoustic missing inputs: ${acMissing}`);

  console.log(`  Running acoustic diffusion (${totalFrames} frames)...`);
  const tAc = Date.now();
  const acOut = await acSession.run(acFeeds);
  console.log(`  Acoustic done in ${((Date.now() - tAc) / 1000).toFixed(1)}s`);

  const melTensor = acOut.mel;
  const melShape = melTensor.dims;  // [1, totalFrames, 128]
  console.log(`  Mel output: shape [${melShape}]`);

  // ── 8. Vocoder ──
  console.log('\n[8/8] Vocoder');
  const vocSession = await ort.InferenceSession.create(PATH.vocoder);
  console.log(`  vocoder inputs: [${vocSession.inputNames.join(', ')}]`);

  const vocFeeds = { mel: melTensor, f0: f32(f0Hz) };
  const tVoc = Date.now();
  const vocOut = await vocSession.run(vocFeeds);
  console.log(`  Vocoder done in ${((Date.now() - tVoc) / 1000).toFixed(1)}s`);

  const waveTensor = vocOut.waveform;
  const waveform = new Float32Array(waveTensor.data.buffer, waveTensor.data.byteOffset, waveTensor.data.length);
  console.log(`  Waveform: ${waveform.length} samples (${(waveform.length / SAMPLE_RATE).toFixed(2)}s)`);

  // ── Save ──
  const outPath = 'output-full.wav';
  writeWav(outPath, waveform);
  console.log(`  Saved: ${outPath}`);

  console.log('\n=== FULL PIPELINE SMOKE TEST PASSED ===');
  console.log(`Total frames: ${totalFrames}`);
  console.log(`Duration: ${(waveform.length / SAMPLE_RATE).toFixed(2)}s`);
}

main().catch(err => { console.error('\n=== SMOKE TEST FAILED ==='); console.error(err); process.exit(1); });
