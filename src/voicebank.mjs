// ─── Universal Voicebank Loader ──────────────────────────
// Handles 3 architecture types:
//   A) Flat/older (Netriko): dsconfig.yaml at root, phonemes.txt, single linguistic.onnx
//   B) Mixed (Raine Reizo): dsconfig.yaml at root, phonemes.json, multi-linguistic
//   C) Modern (Allen_Crow, nessie): configs/dsconfig.yaml, files/*.onnx, separate linguistic-*.onnx

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { parse as parseYaml } from 'yaml';

// ─── Utils ───────────────────────────────────────────────
function readYamlOrNull(filepath) {
  try { return parseYaml(readFileSync(filepath, 'utf8')); }
  catch { return null; }
}

function readJsonOrNull(filepath) {
  try { return JSON.parse(readFileSync(filepath, 'utf8')); }
  catch { return null; }
}

function resolveAll(base, paths) {
  return paths.map(p => join(base, p));
}

// ─── Main loader ─────────────────────────────────────────
export async function loadVoicebank(basePath) {
  const name = basename(basePath);
  console.log(`\n  Loading voicebank: ${name}`);

  // ── 1. Find main dsconfig.yaml ──
  let configDir, config;
  const rootCfg = join(basePath, 'dsconfig.yaml');
  const modCfg = join(basePath, 'configs', 'dsconfig.yaml');

  if (existsSync(modCfg)) {
    configDir = join(basePath, 'configs');
    config = readYamlOrNull(modCfg);
    console.log('    Architectures: modern modular (configs/)');
  } else if (existsSync(rootCfg)) {
    configDir = basePath;
    config = readYamlOrNull(rootCfg);
    console.log('    Architectures: flat/root');
  } else {
    throw new Error(`dsconfig.yaml not found in ${basePath}`);
  }

  if (!config) throw new Error(`Failed to parse dsconfig.yaml in ${configDir}`);

  // ── 2. Resolve key paths relative to configDir ──
  const resolve = (p) => {
    if (!p) return null;
    // Handle both forward and backslash in yaml paths
    const segments = p.replace(/\\/g, '/').split('/');
    // If path starts with .. it's relative to configDir
    return join(configDir, ...segments);
  };

  // ── 3. Phoneme map ──
  const phonemeRelPath = config.phonemes;
  let phonemeMap;
  let variancePhonemeMap = null; // some models have separate phoneme files for variance

  if (phonemeRelPath) {
    const phPath = resolve(phonemeRelPath);
    if (!existsSync(phPath)) throw new Error(`Phoneme file not found: ${phPath}`);

    if (phPath.endsWith('.json')) {
      const obj = readJsonOrNull(phPath);
      phonemeMap = new Map(Object.entries(obj));
      console.log(`    Phonemes: JSON, ${phonemeMap.size} entries`);
    } else {
      // .txt format: each line = one phoneme, index = line number
      const lines = readFileSync(phPath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
      phonemeMap = new Map(lines.map((p, i) => [p, i]));
      console.log(`    Phonemes: TXT, ${phonemeMap.size} entries`);
    }

    // Check for variance-specific phoneme file
    const phDir = dirname(phPath);
    const phBase = basename(phPath, '.json') || basename(phPath, '.txt');
    const varPhPath = join(phDir, `${phBase}-variance.json`);
    if (existsSync(varPhPath)) {
      variancePhonemeMap = new Map(Object.entries(readJsonOrNull(varPhPath)));
      console.log(`    Variance phonemes: JSON, ${variancePhonemeMap.size} entries`);
    }
  } else {
    throw new Error('No phonemes field in dsconfig.yaml');
  }

  // ── 4. Languages ──
  let languages = null;
  if (config.languages) {
    const langPath = resolve(config.languages);
    if (existsSync(langPath)) {
      languages = new Map(Object.entries(readJsonOrNull(langPath)));
      console.log(`    Languages: ${languages.size} (${[...languages.keys()].join(', ')})`);
    }
  }

  // ── 5. Acoustic & Vocoder paths ──
  const acousticPath = resolve(config.acoustic);
  if (!acousticPath || !existsSync(acousticPath)) {
    throw new Error(`Acoustic model not found: ${acousticPath}`);
  }

  // Vocoder resolution
  let vocoderPath, vocoderConfig;
  const vocoderDir = config.vocoder ? resolve(config.vocoder) : null;
  if (vocoderDir && existsSync(vocoderDir)) {
    // vocoder field points to a directory containing vocoder.yaml
    const vcYaml = join(vocoderDir, 'vocoder.yaml');
    if (existsSync(vcYaml)) {
      vocoderConfig = readYamlOrNull(vcYaml);
      if (vocoderConfig?.model) {
        vocoderPath = join(vocoderDir, vocoderConfig.model);
      }
    }
    // Also check for .onnx directly in the dir
    if (!vocoderPath) {
      const onnxFiles = readdirSync(vocoderDir).filter(f => f.endsWith('.onnx'));
      if (onnxFiles.length > 0) vocoderPath = join(vocoderDir, onnxFiles[0]);
    }
  }
  // Some models have vocoder in a separate location (like tgm_hifigan/)
  if (!vocoderPath) {
    // Try tgm_hifigan/ pattern
    const tgmDir = join(basePath, 'tgm_hifigan');
    if (existsSync(tgmDir)) {
      const onnxFiles = readdirSync(tgmDir).filter(f => f.endsWith('.onnx'));
      if (onnxFiles.length > 0) vocoderPath = join(tgmDir, onnxFiles[0]);
    }
  }
  if (!vocoderPath || !existsSync(vocoderPath)) {
    throw new Error(`Vocoder model not found (resolved dir: ${vocoderDir})`);
  }
  console.log(`    Vocoder: ${basename(vocoderPath)}`);

  // ── 6. Hidden size ──
  const hiddenSize = config.hidden_size || config.hiddenSize || 256;

  // ── 7. Linguistic model paths ──
  const modelDir = dirname(acousticPath); // dir containing ONNX files

  // Try to find linguistic models in order:
  //   1. Named variants: linguistic-dur.onnx, linguistic-pitch.onnx, linguistic-variance.onnx
  //   2. Sub-config paths
  //   3. Single shared: linguistic.onnx
  function findLinguistic(suffix) {
    const named = join(modelDir, `linguistic-${suffix}.onnx`);
    if (existsSync(named)) return named;

    // Check sub-config
    const sd = subConfigs[suffix];
    if (sd?.linguistic) {
      const p = resolve(sd.linguistic);
      if (existsSync(p)) return p;
    }

    // Check sub-dir pattern (like dspitch/linguistic.onnx)
    const subDir = join(configDir, `ds${suffix}`);
    if (existsSync(subDir)) {
      const lingInSub = join(subDir, 'linguistic.onnx');
      if (existsSync(lingInSub)) return lingInSub;
    }

    // Default: shared linguistic.onnx
    const shared = join(modelDir, 'linguistic.onnx');
    if (existsSync(shared)) return shared;

    return null;
  }

  // ── 8. Sub-pipeline configs & model paths ──
  const subConfigs = {};
  const subModelPaths = {};

  for (const stage of ['dur', 'pitch', 'variance']) {
    // Try sub-config
    const subDir = join(configDir, `ds${stage}`);
    let subCfg = null;
    if (existsSync(subDir)) {
      const subYaml = join(subDir, 'dsconfig.yaml');
      if (existsSync(subYaml)) subCfg = readYamlOrNull(subYaml);
    }
    subConfigs[stage] = subCfg || {};

    // Find sub-model path
    let modelPath = null;
    if (subCfg?.[stage]) {
      // Config specifies the path (e.g., dur: dur.onnx)
      modelPath = join(subDir, subCfg[stage]);
    }
    if (!modelPath && subCfg?.acoustic) {
      // Some configs use 'acoustic' key for variance
      modelPath = join(subDir, subCfg.acoustic);
    }
    if (!modelPath || !existsSync(modelPath)) {
      // Try files/ directory pattern (modern)
      const inFiles = join(modelDir, `${stage}.onnx`);
      if (existsSync(inFiles)) modelPath = inFiles;
    }
    if (!modelPath || !existsSync(modelPath)) {
      // Try sub-dir pattern (old)
      const inSub = join(subDir, `${stage}.onnx`);
      if (existsSync(inSub)) modelPath = inSub;
    }
    subModelPaths[stage] = modelPath && existsSync(modelPath) ? modelPath : null;
  }

  const linguisticPaths = {
    dur: findLinguistic('dur'),
    pitch: findLinguistic('pitch'),
    variance: findLinguistic('variance'),
  };

  console.log(`    Models: acoustic ✓, dur=${subModelPaths.dur ? '✓' : '✗'}, pitch=${subModelPaths.pitch ? '✓' : '✗'}, variance=${subModelPaths.variance ? '✓' : '✗'}`);

  // ── 9. Speaker embeddings ──
  const speakerNames = (config.speakers || []).map(s => {
    // Speaker can be a path (dsmain/embeds/acoustic/standard) or a name
    if (typeof s === 'string') return s;
    if (typeof s === 'object') return s.name || s.id || JSON.stringify(s);
    return String(s);
  });

  // For each speaker, find embeds for each pipeline
  function findEmbed(speakerRef, pipeline) {
    // speakerRef could be: "dsmain/embeds/acoustic/standard" or "standard"
    const ref = typeof speakerRef === 'string' ? speakerRef : String(speakerRef);
    const name = basename(ref);

    // Try in order:
    // 1. Exact path relative to configDir (with .emb extension)
    const exact = resolve(ref);
    const exactEmb = exact + '.emb';
    if (existsSync(exactEmb)) return exactEmb;

    // 2. configDir/embeds/<name>.emb (modern pattern, separate per pipeline)
    const modernEmb = join(configDir, pipeline === 'acoustic' ? 'embeds' : `ds${pipeline}/embeds`, `${name}.emb`);
    if (existsSync(modernEmb)) return modernEmb;

    // 3. <modelDir>/embeds/<pipeline>/<name>.emb (Netriko pattern)
    const oldEmb = join(modelDir, 'embeds', pipeline, `${name}.emb`);
    if (existsSync(oldEmb)) return oldEmb;

    // 4. configDir/embeds/<name>.emb (modern shared pattern)
    const sharedEmb = join(configDir, 'embeds', `${name}.emb`);
    if (existsSync(sharedEmb)) return sharedEmb;

    return null;
  }

  const speakers = speakerNames.map(ref => {
    const name = basename(ref).replace('.emb', '');
    return {
      name,
      embedPaths: {
        acoustic: findEmbed(ref, 'acoustic'),
        dur: findEmbed(ref, 'dur') || findEmbed(ref, 'variance'),
        pitch: findEmbed(ref, 'pitch') || findEmbed(ref, 'variance'),
        variance: findEmbed(ref, 'variance'),
      },
    };
  });

  console.log(`    Speakers: ${speakers.length} [${speakers.map(s => s.name).join(', ')}]`);

  // ── 10. Build and return ──
  return {
    name,
    basePath,
    configDir,
    config,
    hiddenSize,

    // Phonemes
    phonemeMap,
    variancePhonemeMap,

    // Languages
    languages,
    useLangId: config.use_lang_id === true,

    // Models
    acousticPath,
    vocoderPath,
    vocoderConfig,
    linguisticPaths,
    subModelPaths,
    subConfigs,

    // Speakers
    speakers,
    speakerNames,
  };
}

/** Get speaker embed for a specific pipeline stage */
export function loadSpeakerEmbed(voicebank, speakerName, pipeline = 'acoustic') {
  const speaker = voicebank.speakers.find(s => s.name === speakerName);
  if (!speaker) {
    // Fall back to first speaker
    const first = voicebank.speakers[0];
    if (!first) throw new Error('No speakers found');
    console.warn(`    Warning: speaker "${speakerName}" not found, using "${first.name}"`);
    return loadEmbedFile(first.embedPaths[pipeline] || first.embedPaths.acoustic);
  }
  const path = speaker.embedPaths[pipeline] || speaker.embedPaths.acoustic;
  if (!path) throw new Error(`No embed path for speaker "${speakerName}" pipeline "${pipeline}"`);
  return loadEmbedFile(path);
}

function loadEmbedFile(filepath) {
  const buf = readFileSync(filepath);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
