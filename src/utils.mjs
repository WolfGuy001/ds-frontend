// ─── Tensor helpers ──────────────────────────────────────
import * as ort from 'onnxruntime-node';
import { writeFileSync } from 'fs';

/** int64 tensor (1, N) */
export const i64 = data => new ort.Tensor('int64', new BigInt64Array(Array.from(data, BigInt)), [1, data.length]);

/** int64 scalar (1) */
export const i64s = v => new ort.Tensor('int64', new BigInt64Array([BigInt(v)]), [1]);

/** float32 tensor (1, N) */
export const f32 = arr => new ort.Tensor('float32', new Float32Array(arr), [1, arr.length]);

/** float32 scalar (1) */
export const f32s = v => new ort.Tensor('float32', new Float32Array([v]), [1]);

/** float32 3D: (1, D2, D3) */
export const f32_3d = (data, dim2, dim3) =>
  new ort.Tensor('float32', new Float32Array(data), [1, data.length / (dim2 * dim3), dim2, dim3]);

/** bool tensor (1, N) */
export const bool1d = arr => new ort.Tensor('bool', new Uint8Array(arr), [1, arr.length]);

// ─── Math ────────────────────────────────────────────────
export const midiToHz = m => 440 * Math.pow(2, (m - 69) / 12);
export const hzToMidi = h => 12 * Math.log2(h / 440) + 69;

export const frameMs = (hopSize = 512, sampleRate = 44100) =>
  1000 * hopSize / sampleRate;

// ─── Embed utilities ─────────────────────────────────────
export function repeatEmbed(embed, nFrames) {
  const out = new Float32Array(nFrames * embed.length);
  for (let f = 0; f < nFrames; f++) out.set(embed, f * embed.length);
  return out;
}

// ─── WAV writer ──────────────────────────────────────────
export function writeWav(filepath, samples, sampleRate = 44100) {
  const bits = 16, ch = 1;
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
  buf.writeUInt32LE(sampleRate, off); off += 4;
  buf.writeUInt32LE(sampleRate * ch * bits / 8, off); off += 4;
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
