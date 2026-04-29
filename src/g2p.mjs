// ─── G2P: Grapheme-to-Phoneme conversion ─────────────────
// Parses dsdict.yaml and provides lyric→phoneme mapping.
// Supports flat (Netriko) and multilingual (Raine, Allen_Crow, nessie) dictionaries.

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { parse as parseYaml } from 'yaml';

export class G2P {
  /**
   * @param {string} dictPath — path to dsdict.yaml
   * @param {string|null} language — 'ja' | 'en' | 'zh' | 'ko' | null (auto-detect)
   */
  constructor(dictPath, language = null) {
    this.dictPath = dictPath;
    this.language = language;
    this.entries = new Map();   // grapheme → string[]
    this.symbols = new Map();   // symbol → type ('vowel' | 'stop')
    this._loaded = false;
  }

  /** Load and parse the dictionary file */
  load() {
    if (this._loaded) return;
    const raw = parseYaml(readFileSync(this.dictPath, 'utf8'));
    if (!raw.entries) throw new Error(`No 'entries' in ${this.dictPath}`);

    // Entries: { grapheme: str, phonemes: str[] }
    for (const entry of raw.entries) {
      if (entry.grapheme !== undefined && entry.phonemes) {
        this.entries.set(entry.grapheme, entry.phonemes);
      }
    }

    // Symbols: { symbol: str, type: 'vowel'|'stop' }
    if (raw.symbols) {
      for (const sym of raw.symbols) {
        if (sym.symbol) this.symbols.set(sym.symbol, sym.type);
      }
    }

    // SP and AP are always vowels
    this.symbols.set('SP', 'vowel');
    this.symbols.set('AP', 'vowel');

    this._loaded = true;
  }

  /**
   * Convert a lyric (syllable) to phoneme array.
   * Supports:
   *   - direct lookup: "か" → ["kx", "a"]
   *   - phonetic hint: "k a" → ["k", "a"] (already phoneme form)
   *   - raw grapheme: "ka" → falls back to phoneme-lang format
   *
   * @param {string} lyric
   * @returns {string[]|null} phonemes or null if not found
   */
  query(lyric) {
    this.load();
    if (!lyric) return [];

    // Special markers
    if (lyric === '-' || lyric === ' ') return ['SP'];
    if (lyric === 'R') return ['SP'];
    if (lyric === '息' || lyric === 'br' || lyric === 'br ') return ['AP'];

    // Try direct lookup first
    const direct = this.entries.get(lyric);
    if (direct) return direct;

    // Try lowercase
    const lower = this.entries.get(lyric.toLowerCase());
    if (lower) return lower;

    // Try with language prefix (multilingual models)
    if (this.language) {
      const withPrefix = this.entries.get(`${this.language}/${lyric}`);
      if (withPrefix) return withPrefix;
    }

    // Check if lyric itself is a valid phoneme (phonetic hint)
    const parts = lyric.split(/\s+/);
    if (parts.every(p => this.isValidSymbol(p))) {
      return parts;
    }

    // Check with language prefix for each part
    if (this.language) {
      const prefixed = parts.map(p => `${this.language}/${p}`);
      if (prefixed.every(p => this.symbols.has(p) || this.symbols.has(p.split('/')[1]))) {
        return prefixed;
      }
    }

    return null;
  }

  /** Check if a symbol (raw or lang-prefixed) exists in the dictionary */
  isValidSymbol(symbol) {
    this.load();
    if (!symbol) return false;
    if (this.symbols.has(symbol)) return true;
    // Also check without language prefix
    const parts = symbol.includes('/') ? symbol.split('/') : [null, symbol];
    return this.symbols.has(parts[parts.length - 1]);
  }

  /** Check if phoneme is a vowel */
  isVowel(phoneme) {
    this.load();
    const part = phoneme.includes('/') ? phoneme.split('/')[1] : phoneme;
    return this.symbols.get(part) === 'vowel' || this.symbols.get(phoneme) === 'vowel';
  }

  /**
   * Get phonemes for a note, with smart fallback.
   * Order: phoneticHint > direct G2P query > raw phoneme parse > ['SP']
   */
  resolveNote(note, defaultLanguage = null) {
    const lang = this.language || defaultLanguage;

    // Phonetic hint (user explicitly provided phonemes)
    if (note.phoneticHint) {
      const parts = note.phoneticHint.split(/\s+/).filter(Boolean);
      const resolved = parts.map(p => {
        if (this.entries.has(p)) return this.entries.get(p);
        if (lang && this.entries.has(`${lang}/${p}`)) return this.entries.get(`${lang}/${p}`);
        return [p]; // use as-is
      }).flat();
      return resolved.length > 0 ? resolved : ['SP'];
    }

    // G2P query
    const phonemes = this.query(note.lyric);
    if (phonemes) return phonemes;

    // Fallback: silent pause
    return ['SP'];
  }
}

/**
 * Load G2P for a voicebank, trying multiple dictionary paths.
 * Returns the best available G2P instance.
 */
export function loadG2PForVoicebank(voicebank, language = null) {
  const { configDir } = voicebank;

  // Priority order for dictionary paths
  const candidates = [
    join(configDir, 'dsdict.yaml'),           // top-level
    join(configDir, 'dsdur', 'dsdict.yaml'),  // duration sub-config
    join(configDir, 'dspitch', 'dsdict.yaml'), // pitch sub-config
  ];

  // If language specified, try language-specific dictionaries
  if (language) {
    candidates.push(
      join(configDir, 'dsdur', `dsdict-${language}.yaml`),
      join(configDir, 'dspitch', `dsdict-${language}.yaml`),
    );
  }

  for (const path of candidates) {
    if (existsSync(path)) {
      return new G2P(path, language);
    }
  }

  // Fallback: search broadly
  return null;
}
