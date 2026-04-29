// ─── Time conversion: Tick ↔ Millisecond ↔ Frame ─────────

/** Ticks per beat (MIDI standard) */
export const TICKS_PER_BEAT = 480;

/**
 * Convert ticks to milliseconds given a BPM.
 * Supports constant tempo only (MVP).
 * @param {number} tick — position in ticks
 * @param {number} bpm — beats per minute
 * @returns {number} milliseconds
 */
export function tickToMs(tick, bpm) {
  return (tick / TICKS_PER_BEAT) * (60_000 / bpm);
}

/** Convert milliseconds to ticks */
export function msToTick(ms, bpm) {
  return (ms / (60_000 / bpm)) * TICKS_PER_BEAT;
}

/**
 * Frame duration in milliseconds.
 * @param {number} hopSize — hop size in samples (default 512)
 * @param {number} sampleRate — sample rate in Hz (default 44100)
 */
export function frameMs(hopSize = 512, sampleRate = 44100) {
  return 1000 * hopSize / sampleRate;
}

/** Convert milliseconds to frame index */
export function msToFrames(ms, hopSize = 512, sampleRate = 44100) {
  return Math.round(ms / frameMs(hopSize, sampleRate));
}

/** Convert tick to frame index */
export function tickToFrame(tick, bpm, hopSize = 512, sampleRate = 44100) {
  return msToFrames(tickToMs(tick, bpm), hopSize, sampleRate);
}

/** Convert ticks to frame duration (preserves cumulative accuracy) */
export function durationFrames(startMs, endMs, hopSize = 512, sampleRate = 44100) {
  const fms = frameMs(hopSize, sampleRate);
  return Math.round(endMs / fms) - Math.round(startMs / fms);
}

/**
 * Convert a beat position to tick count.
 * @param {number} bars — number of bars
 * @param {number} beats — beats within bar
 * @param {number} subdivisions — subdivisions (e.g. 4 = sixteenth)
 * @param {number} timeSigNum — time signature numerator (beats per bar)
 * @returns {number} ticks
 */
export function beatToTick(bars, beats = 0, subdivisions = 0, timeSigNum = 4) {
  const ticksPerBar = TICKS_PER_BEAT * timeSigNum;
  return (bars - 1) * ticksPerBar
    + beats * TICKS_PER_BEAT
    + Math.round(subdivisions * (TICKS_PER_BEAT / 4));
}

/**
 * Sample a user-drawn curve (array of control points) onto the frame grid.
 *
 * IMPORTANT: F0 curves are in MIDI-space (semitones).
 * Use this for all user curves before passing to pipeline.
 *
 * @param {{tick: number, value: number}[]} points — sorted control points
 * @param {number} totalFrames — total output frames
 * @param {number} startMs — msec corresponding to frame 0
 * @param {number} bpm — tempo in BPM
 * @param {number} defaultValue — used if curve has no points
 * @param {number} headFrames — padding frames at start (default 8)
 * @param {number} tailFrames — padding frames at end (default 8)
 * @param {number} hopSize — vocoder hop size
 * @param {number} sampleRate — sample rate
 * @returns {Float32Array} sampled values, length = totalFrames
 */
export function sampleCurveOnFrameGrid(
  points, totalFrames, startMs, bpm,
  defaultValue = 0, headFrames = 8, tailFrames = 8,
  hopSize = 512, sampleRate = 44100,
) {
  const result = new Float32Array(totalFrames).fill(defaultValue);
  if (!points || points.length === 0) return result;

  const fms = frameMs(hopSize, sampleRate);

  // Fill head padding with first point's value
  const headVal = interpolateAtTick(points, msToTick(startMs, bpm));
  result.fill(headVal, 0, headFrames);

  // Fill body
  const bodyStartFrame = headFrames;
  const bodyEndFrame = totalFrames - tailFrames;
  for (let f = bodyStartFrame; f < bodyEndFrame; f++) {
    const posMs = startMs + f * fms;
    const tick = msToTick(posMs, bpm);
    result[f] = interpolateAtTick(points, tick);
  }

  // Fill tail padding with last point's value
  const tailMs = startMs + (totalFrames - tailFrames) * fms;
  const tailVal = interpolateAtTick(points, msToTick(tailMs, bpm));
  result.fill(tailVal, totalFrames - tailFrames, totalFrames);

  return result;
}

/**
 * Linear interpolation at a given tick position.
 * Points must be sorted by tick.
 */
function interpolateAtTick(points, tick) {
  if (points.length === 0) return 0;
  if (tick <= points[0].tick) return points[0].value;
  if (tick >= points[points.length - 1].tick) return points[points.length - 1].value;

  for (let i = 1; i < points.length; i++) {
    if (tick <= points[i].tick) {
      const prev = points[i - 1];
      const curr = points[i];
      const t = (tick - prev.tick) / (curr.tick - prev.tick);
      return prev.value + t * (curr.value - prev.value);
    }
  }
  return points[points.length - 1].value;
}

// ─── Tempo map (MVP: single-tempo) ────────────────────────
/**
 * Simple tempo map. In MVP it holds a single BPM.
 * Extend with multiple tempo events for tempo changes.
 */
export class TempoMap {
  /** @param {number} bpm */
  constructor(bpm = 120) {
    this.events = [{ tick: 0, bpm }];
  }

  get bpm() { return this.events[0].bpm; }

  // Future: multiple tempo events
  tickToMs(tick) {
    // MVP: single tempo
    return (tick / TICKS_PER_BEAT) * (60_000 / this.bpm);
  }

  msToTick(ms) {
    return (ms / (60_000 / this.bpm)) * TICKS_PER_BEAT;
  }
}

/** Standard DiffSinger head/tail frame counts */
export const HEAD_FRAMES = 8;
export const TAIL_FRAMES = 8;
