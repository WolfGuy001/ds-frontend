// ─── CLI Render Script ───────────────────────────────────
// Usage: node render-project.mjs <project.json> [out.wav] [voicebank] [speaker]
// Used by frontend server and standalone CLI.

import { loadVoicebank } from './src/voicebank.mjs';
import { renderPhrase } from './src/pipeline.mjs';
import { buildPhraseJob } from './src/project.mjs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { writeWav } from './src/utils.mjs';

const [,, projPath, outPath, vbName, speakerName] = process.argv;

if (!projPath || !existsSync(projPath)) {
  console.error('Usage: node render-project.mjs <project.json> [out.wav] [voicebank] [speaker]');
  process.exit(1);
}

const proj = JSON.parse(readFileSync(projPath, 'utf8'));
const voicebankDir = join('onnx-models', vbName || 'Netriko_Nakayama_AI_v100');
const out = outPath || projPath.replace('.json', '.wav');

try {
  const vb = await loadVoicebank(voicebankDir);

  const phrase = buildPhraseJob(proj.notes, vb, {
    bpm: proj.bpm || 120,
    language: proj.language || 'ja',
  });

  console.log(`Rendering ${phrase.phonemes.length} phonemes...`);

  const waveform = await renderPhrase(vb, phrase, {
    speaker: speakerName || proj.speaker || 'standard',
  });

  writeWav(out, waveform, vb.config.sample_rate || 44100);
  console.log(`Done: ${out} (${(waveform.length / 44100).toFixed(1)}s)`);
} catch (err) {
  console.error('Render error:', err.message);
  process.exit(1);
}
