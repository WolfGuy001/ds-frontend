// ─── Piano Roll — main editing surface ───────────────────
import { useState, useRef, useEffect, useCallback } from 'react';

const KEY_H = 18;
const PX_PER_BEAT = 64;
const BEATS_PER_BAR = 4;
const NOTE_MIN = 48; // C3
const NOTE_MAX = 84; // C6
const TOTAL_KEYS = NOTE_MAX - NOTE_MIN + 1;
const KEYBOARD_W = 56;
const RULER_H = 28;

function midiToName(m) {
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  return names[m % 12] + Math.floor(m / 12 - 1);
}
function isBlack(m) { return [1,3,6,8,10].includes(m % 12); }

export default function PianoRoll({
  notes, curves, activeCurveId, bpm,
  tool, setTool, selectedNoteIds, setSelectedNoteIds,
  addNote, deleteNotes, updateNote, moveNote, resizeNote,
  audioUrl,
}) {
  const containerRef = useRef(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [zoom, setZoom] = useState(64);
  const [dragState, setDragState] = useState(null);
  const [editingNoteId, setEditingNoteId] = useState(null);

  const pxPerBeat = zoom;
  const pxPerTick = pxPerBeat / 480;

  // Auto-scroll to show all notes
  const totalBeats = notes.length > 0
    ? Math.ceil((Math.max(...notes.map(n => n.tickStart + n.tickLength)) / 480)) + 4
    : 16;
  const totalBars = Math.ceil(totalBeats / BEATS_PER_BAR);
  const contentWidth = totalBeats * pxPerBeat;
  const contentHeight = TOTAL_KEYS * KEY_H;

  // y-pos for a MIDI pitch
  const pitchToY = (p) => (NOTE_MAX - p) * KEY_H;
  const yToPitch = (y) => Math.round(NOTE_MAX - y / KEY_H);

  // tick pos from x
  const xToTick = (x) => Math.round((x + scrollLeft - KEYBOARD_W) / pxPerTick);
  const tickToX = (t) => t * pxPerTick + KEYBOARD_W - scrollLeft;

  // ─── Mouse handlers ─────────────────────────────────────
  const handleMouseDown = (e) => {
    if (e.target.closest('.note-el') || e.target.closest('.f0-handle')) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + scrollLeft - KEYBOARD_W;
    const y = e.clientY - rect.top + scrollTop - RULER_H;

    if (tool === 'pencil') {
      const tick = Math.max(0, Math.round(x / pxPerTick));
      const pitch = yToPitch(y + scrollTop);
      if (pitch >= NOTE_MIN && pitch <= NOTE_MAX) {
        const id = addNote(tick, pitch);
        setSelectedNoteIds(new Set([id]));
      }
    } else if (tool === 'erase') {
      // handled by note click
    } else if (tool === 'scissors') {
      const tick = Math.max(0, Math.round(x / pxPerTick));
      // Find note at this position and split
      for (const note of notes) {
        if (tick > note.tickStart && tick < note.tickStart + note.tickLength) {
          const splitTick = tick;
          const origEnd = note.tickStart + note.tickLength;
          updateNote(note.id, { tickLength: splitTick - note.tickStart });
          addNote(splitTick, note.pitch, origEnd - splitTick);
          break;
        }
      }
    }
  };

  const handleWheel = (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      setZoom(z => Math.max(16, Math.min(256, z + (e.deltaY > 0 ? -8 : 8))));
    } else {
      setScrollLeft(s => Math.max(0, s + e.deltaX + e.deltaY));
      setScrollTop(s => Math.max(0, Math.min(contentHeight - 400, s + e.deltaY)));
    }
  };

  // ─── Note drag logic ────────────────────────────────────
  const startNoteDrag = (e, noteId) => {
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startTick = notes.find(n => n.id === noteId).tickStart;
    const startPitch = notes.find(n => n.id === noteId).pitch;

    if (tool === 'erase') {
      deleteNotes(new Set([noteId]));
      return;
    }

    // Toggle selection
    if (!e.shiftKey) {
      setSelectedNoteIds(new Set([noteId]));
    } else {
      setSelectedNoteIds(s => {
        const ns = new Set(s);
        ns.has(noteId) ? ns.delete(noteId) : ns.add(noteId);
        return ns;
      });
    }

    setDragState({ noteId, startX, startY, startTick, startPitch });

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const dTick = Math.round(dx / pxPerTick);
      const dPitch = -Math.round(dy / KEY_H);
      if (dTick !== 0 || dPitch !== 0) {
        moveNote(noteId, dTick, dPitch);
        setDragState(s => ({ ...s, startX: ev.clientX, startY: ev.clientY, startTick: startTick + dTick, startPitch: startPitch + dPitch }));
      }
    };

    const onUp = () => {
      setDragState(null);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startResize = (e, noteId) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dTick = Math.round(dx / pxPerTick);
      const note = notes.find(n => n.id === noteId);
      if (note) {
        resizeNote(noteId, Math.max(60, note.tickLength + dTick));
      }
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleDblClick = (noteId) => {
    setEditingNoteId(noteId);
  };

  const handleLyricChange = (noteId, lyric) => {
    updateNote(noteId, { lyric });
  };

  const handleLyricBlur = () => {
    setEditingNoteId(null);
  };

  const handleLyricKeyDown = (e, noteId) => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      setEditingNoteId(null);
      // Move to next note
      const idx = notes.findIndex(n => n.id === noteId);
      if (idx < notes.length - 1) {
        setEditingNoteId(notes[idx + 1].id);
      }
    }
    if (e.key === 'Escape') {
      setEditingNoteId(null);
    }
  };

  // ─── Render ──────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onWheel={handleWheel}
      style={{
        flex: 1, position: 'relative', overflow: 'hidden',
        background: 'var(--bg-grid)',
      }}
    >
      {/* Ruler */}
      <div style={{
        position: 'absolute', top: 0, left: KEYBOARD_W, right: 0,
        height: RULER_H, background: '#1a1b1d',
        borderBottom: '1px solid var(--line-2)', zIndex: 3,
        overflow: 'hidden',
      }}>
        <div style={{ position: 'relative', height: '100%', transform: `translateX(${-scrollLeft}px)` }}>
          {Array.from({ length: totalBars + 1 }, (_, bar) => (
            <div
              key={`bar-${bar}`}
              className="mono"
              style={{
                position: 'absolute', left: bar * BEATS_PER_BAR * pxPerBeat,
                top: 6, fontSize: 10, color: 'var(--fg-dim)',
              }}
            >
              {bar + 1}
            </div>
          ))}
          {Array.from({ length: Math.floor(totalBeats) + 1 }, (_, beat) => (
            <div
              key={`beat-${beat}`}
              style={{
                position: 'absolute',
                left: beat * pxPerBeat,
                top: 20,
                width: 1,
                height: 8,
                background: beat % BEATS_PER_BAR === 0 ? 'var(--grid-bar)' : 'var(--grid-beat)',
              }}
            />
          ))}
        </div>
      </div>

      {/* Keyboard */}
      <div style={{
        position: 'absolute', left: 0, top: RULER_H, width: KEYBOARD_W, bottom: 0,
        overflow: 'hidden', borderRight: '1px solid var(--line-2)',
        background: '#1a1b1d', zIndex: 2,
      }}>
        <div style={{ position: 'relative', height: contentHeight, transform: `translateY(${-scrollTop}px)` }}>
          {Array.from({ length: TOTAL_KEYS }, (_, i) => {
            const m = NOTE_MAX - i;
            const black = isBlack(m);
            const isC = m % 12 === 0;
            return (
              <div key={m} style={{
                position: 'absolute', top: i * KEY_H, left: 0,
                width: KEYBOARD_W, height: KEY_H,
                background: black ? 'var(--black-key)' : 'var(--white-key)',
                borderBottom: '1px solid rgba(0,0,0,0.4)',
                display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
                paddingRight: 6,
                fontSize: 9, color: black ? '#555' : '#888',
                fontFamily: 'JetBrains Mono, monospace',
              }}>
                {(isC || m === NOTE_MAX) ? midiToName(m) : ''}
              </div>
            );
          })}
        </div>
      </div>

      {/* Grid + Notes canvas */}
      <div style={{
        position: 'absolute', left: KEYBOARD_W, top: RULER_H, right: 0, bottom: 0,
        overflow: 'hidden',
      }}>
        <div style={{
          position: 'relative',
          width: contentWidth,
          height: contentHeight,
          transform: `translate(${-scrollLeft}px, ${-scrollTop}px)`,
        }}>
          {/* Grid lines — horizontal */}
          {Array.from({ length: TOTAL_KEYS }, (_, i) => (
            <div key={`h-${i}`} style={{
              position: 'absolute', top: i * KEY_H, left: 0, right: 0,
              height: 1,
              background: (NOTE_MAX - i) % 12 === 0 ? 'var(--grid-row)' : 'transparent',
            }} />
          ))}

          {/* Grid lines — vertical (bars) */}
          {Array.from({ length: totalBars + 1 }, (_, bar) => (
            <div key={`vbar-${bar}`} style={{
              position: 'absolute', top: 0, bottom: 0,
              left: bar * BEATS_PER_BAR * pxPerBeat, width: 1,
              background: 'var(--grid-bar)',
            }} />
          ))}

          {/* Grid lines — vertical (beats) */}
          {Array.from({ length: Math.floor(totalBeats) + 1 }, (_, beat) => (
            <div key={`vbeat-${beat}`} style={{
              position: 'absolute', top: 0, bottom: 0,
              left: beat * pxPerBeat, width: 1,
              background: beat % BEATS_PER_BAR === 0 ? 'var(--grid-bar)' : 'var(--grid-beat)',
            }} />
          ))}

          {/* Notes */}
          {notes.map(note => {
            const x = note.tickStart * pxPerTick;
            const y = pitchToY(note.pitch);
            const w = note.tickLength * pxPerTick;
            const h = KEY_H;
            const sel = selectedNoteIds.has(note.id);

            return (
              <div
                key={note.id}
                className={'note-el' + (sel ? ' selected' : '')}
                onMouseDown={e => startNoteDrag(e, note.id)}
                onDoubleClick={() => handleDblClick(note.id)}
                style={{
                  left: x, top: y, width: w, height: h,
                }}
              >
                {editingNoteId === note.id ? (
                  <input
                    className="lyric-input"
                    value={note.lyric}
                    onChange={e => handleLyricChange(note.id, e.target.value)}
                    onBlur={handleLyricBlur}
                    onKeyDown={e => handleLyricKeyDown(e, note.id)}
                    autoFocus
                    style={{
                      background: 'transparent', border: 'none', outline: 'none',
                      color: 'rgba(0,0,0,0.9)', font: 'inherit',
                      width: '100%', padding: 0,
                    }}
                  />
                ) : (
                  <span style={{
                    fontSize: 11, color: 'rgba(0,0,0,0.8)',
                    fontWeight: 500, userSelect: 'none',
                    overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {note.lyric}
                  </span>
                )}
                {sel && (
                  <div
                    className="resize"
                    onMouseDown={e => startResize(e, note.id)}
                  />
                )}
              </div>
            );
          })}

          {/* Audio playback indicator */}
          {audioUrl && (
            <audio controls style={{
              position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)',
              zIndex: 100, width: 300, height: 32,
            }}>
              <source src={audioUrl} type="audio/wav" />
            </audio>
          )}
        </div>
      </div>
    </div>
  );
}
