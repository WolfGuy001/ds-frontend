import * as ort from 'onnxruntime-node';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const VB_DIR = 'onnx-models/Netriko_Nakayama_AI_v100';
const ACOUSTIC_PATH = join(VB_DIR, 'dsmain/acoustic.onnx');
const VOCODER_PATH = join(VB_DIR, 'dsvocoder/netriko_hifigan.onnx');
const PHONEMES_PATH = join(VB_DIR, 'dsmain/phonemes.txt');
const SPK_EMBED_PATH = join(VB_DIR, 'dsmain/embeds/acoustic/standard.emb');
const OUT_WAV = 'output.wav';

// ------------------- load phoneme id map -------------------
function loadPhonemeMap(filepath) {
  const lines = readFileSync(filepath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
  const map = new Map();
  lines.forEach((p, i) => map.set(p, i));
  return map;
}

// ------------------- load speaker embed -------------------
function loadSpeakerEmbed(filepath, hiddenSize = 256) {
  const buf = readFileSync(filepath);
  const expectedBytes = hiddenSize * 4;
  if (buf.byteLength !== expectedBytes) {
    console.error(`  Speaker embed size mismatch: got ${buf.byteLength}, expected ${expectedBytes}`);
  }
  return new Float32Array(buf.buffer, buf.byteOffset, Math.min(hiddenSize, buf.byteLength / 4));
}

// ------------------- wav writer -------------------
function writeWav(filepath, samples, sampleRate = 44100) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
  const headerSize = 44;
  const fileSize = headerSize + dataSize;

  const buffer = Buffer.alloc(fileSize);
  let offset = 0;

  // RIFF header
  buffer.write('RIFF', offset); offset += 4;
  buffer.writeUInt32LE(fileSize - 8, offset); offset += 4;
  buffer.write('WAVE', offset); offset += 4;

  // fmt chunk
  buffer.write('fmt ', offset); offset += 4;
  buffer.writeUInt32LE(16, offset); offset += 4; // chunk size
  buffer.writeUInt16LE(1, offset); offset += 2;  // PCM
  buffer.writeUInt16LE(numChannels, offset); offset += 2;
  buffer.writeUInt32LE(sampleRate, offset); offset += 4;
  buffer.writeUInt32LE(byteRate, offset); offset += 4;
  buffer.writeUInt16LE(blockAlign, offset); offset += 2;
  buffer.writeUInt16LE(bitsPerSample, offset); offset += 2;

  // data chunk
  buffer.write('data', offset); offset += 4;
  buffer.writeUInt32LE(dataSize, offset); offset += 4;

  // sample data (float32 → int16)
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    const int16 = s < 0 ? s * 0x8000 : s * 0x7FFF;
    buffer.writeInt16LE(Math.round(int16), offset);
    offset += 2;
  }

  writeFileSync(filepath, buffer);
  console.log(`  Wrote ${filepath} (${samples.length} samples, ${(samples.length / sampleRate).toFixed(2)}s)`);
}

// ------------------- helper: tensor creation -------------------
function i64(data) {
  const arr = data.map(BigInt);
  return new ort.Tensor('int64', new BigInt64Array(arr), [1, arr.length]);
}

function f32(arr) {
  return new ort.Tensor('float32', new Float32Array(arr), [1, arr.length]);
}

function f32_3d(data, dim2) {
  return new ort.Tensor('float32', new Float32Array(data), [1, data.length / dim2, dim2]);
}

function i64_scalar(val) {
  return new ort.Tensor('int64', new BigInt64Array([BigInt(val)]), [1]);
}

function f32_scalar(val) {
  return new ort.Tensor('float32', new Float32Array([val]), [1]);
}

// ==================================================================

async function main() {
  console.log('=== SynthDiff Smoke Test (Iteration 0) ===\n');

  // 1. Load phoneme map
  console.log('[1/6] Loading phoneme map...');
  const phMap = loadPhonemeMap(PHONEMES_PATH);
  console.log(`  Loaded ${phMap.size} phonemes`);
  const SP = phMap.get('SP');
  const k = phMap.get('k');
  const a = phMap.get('a');
  const n = phMap.get('n');
  const i = phMap.get('i');
  console.log(`  IDs: SP=${SP}, k=${k}, a=${a}, n=${n}, i=${i}`);

  // 2. Load speaker embed
  console.log('[2/6] Loading speaker embed...');
  const spkEmbed = loadSpeakerEmbed(SPK_EMBED_PATH, 256);
  console.log(`  Loaded ${spkEmbed.length} float32 values`);

  // 3. Build tensors for acoustic model
  console.log('[3/6] Building acoustic model inputs...');

  // Hardcoded phrase (with SP padding): SP, k, a, n, i, SP
  const tokens = [SP, k, a, n, i, SP];
  const durations = [8, 5, 30, 5, 30, 8]; // frames
  const totalFrames = durations.reduce((s, v) => s + v, 0); // 86
  console.log(`  tokens: ${tokens}`);
  console.log(`  durations: ${durations} (total frames: ${totalFrames})`);

  // f0 in Hz = A4 = 440 Hz for all frames
  const f0Hz = new Float32Array(totalFrames).fill(440);

  // gender (key shift) — zeros = neutral
  const gender = new Float32Array(totalFrames).fill(0);

  // velocity — 1.0 = normal speed
  const velocity = new Float32Array(totalFrames).fill(1.0);

  // tension — zeros = neutral
  const tension = new Float32Array(totalFrames).fill(0);

  // spk_embed per frame: repeat the speaker embed totalFrames times
  const spkEmbedPerFrame = new Float32Array(totalFrames * 256);
  for (let f = 0; f < totalFrames; f++) {
    spkEmbedPerFrame.set(spkEmbed, f * 256);
  }

  // 4. Load acoustic model + inspect inputs
  console.log('[4/6] Loading acoustic model...');
  const acSession = await ort.InferenceSession.create(ACOUSTIC_PATH);
  const acInputs = new Set(acSession.inputNames);
  console.log(`  Acoustic model inputs: ${[...acInputs].join(', ')}`);
  console.log(`  Acoustic model outputs: ${acSession.outputNames.join(', ')}`);

  // Build input dict — only include what the model actually expects
  const acFeeds = {};

  if (acInputs.has('tokens')) {
    acFeeds.tokens = i64(tokens);
  }
  if (acInputs.has('durations')) {
    acFeeds.durations = i64(durations);
  }
  if (acInputs.has('f0')) {
    acFeeds.f0 = f32(f0Hz);
  }
  if (acInputs.has('gender')) {
    acFeeds.gender = f32(gender);
  }
  if (acInputs.has('velocity')) {
    acFeeds.velocity = f32(velocity);
  }
  if (acInputs.has('tension')) {
    acFeeds.tension = f32(tension);
  }
  if (acInputs.has('spk_embed')) {
    acFeeds.spk_embed = f32_3d(spkEmbedPerFrame, 256);
  }
  if (acInputs.has('steps')) {
    acFeeds.steps = i64_scalar(15); // fewer steps for speed
  }
  if (acInputs.has('depth')) {
    acFeeds.depth = f32_scalar(1.0);
  }

  // Verify no missing required inputs
  const provided = new Set(Object.keys(acFeeds));
  const missing = [...acInputs].filter(n => !provided.has(n));
  if (missing.length > 0) {
    console.error(`  ERROR: missing required inputs: ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log(`  Running acoustic model (${totalFrames} frames)...`);
  const t0 = Date.now();
  const acOut = await acSession.run(acFeeds);
  const elapsedAc = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  Acoustic done in ${elapsedAc}s`);

  const melTensor = acOut.mel || acOut.mel_out || acOut.spectrogram || Object.values(acOut)[0];
  if (!melTensor) {
    console.error('  ERROR: could not find mel output tensor');
    console.error(`  Available outputs: ${Object.keys(acOut).join(', ')}`);
    process.exit(1);
  }
  const mel = new Float32Array(melTensor.data.buffer, melTensor.data.byteOffset, melTensor.data.length);
  console.log(`  Mel output: shape [${melTensor.dims}], ${mel.length} values`);

  // 5. Load vocoder and run
  console.log('[5/6] Loading vocoder model...');
  const vocSession = await ort.InferenceSession.create(VOCODER_PATH);
  const vocInputs = new Set(vocSession.inputNames);
  console.log(`  Vocoder model inputs: ${[...vocInputs].join(', ')}`);

  const vocFeeds = {};
  if (vocInputs.has('mel')) {
    vocFeeds.mel = melTensor;
  }
  if (vocInputs.has('f0')) {
    vocFeeds.f0 = f32(f0Hz);
  }

  const missingVoc = [...vocInputs].filter(n => !Object.keys(vocFeeds).includes(n));
  if (missingVoc.length > 0) {
    console.warn(`  WARNING: missing vocoder inputs: ${missingVoc.join(', ')}`);
  }

  console.log(`  Running vocoder...`);
  const t1 = Date.now();
  const vocOut = await vocSession.run(vocFeeds);
  const elapsedVoc = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(`  Vocoder done in ${elapsedVoc}s`);

  const waveTensor = vocOut.waveform || vocOut.wav || vocOut.audio || Object.values(vocOut)[0];
  if (!waveTensor) {
    console.error('  ERROR: could not find waveform output');
    process.exit(1);
  }
  const waveform = new Float32Array(waveTensor.data.buffer, waveTensor.data.byteOffset, waveTensor.data.length);
  console.log(`  Waveform: shape [${waveTensor.dims}], ${waveform.length} samples`);

  // 6. Write WAV
  console.log('[6/6] Writing output WAV...');
  writeWav(OUT_WAV, waveform, 44100);

  console.log('\n=== SMOKE TEST PASSED ===');
  console.log(`Total time: ${(parseFloat(elapsedAc) + parseFloat(elapsedVoc)).toFixed(1)}s`);
  console.log(`Output: ${OUT_WAV}`);
}

main().catch(err => {
  console.error('\n=== SMOKE TEST FAILED ===');
  console.error(err);
  process.exit(1);
});
