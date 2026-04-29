// ─── Root App — state management & layout ────────────────
import { useState, useEffect, useRef, useCallback } from 'react';
import PianoRoll from './components/PianoRoll.jsx';
import Sidebar from './components/Sidebar.jsx';
import ParamPanel from './components/ParamPanel.jsx';
import TransportBar from './components/TransportBar.jsx';
import RenderButton from './components/RenderButton.jsx';

const TICKS_PER_BEAT = 480;
const DEFAULT_BPM = 120;

// Seed data — 16-note melody
const seedLyrics = 'ゆ め の は な を さ か せ て つ き に な が れ'.split(' ');
const seedPitches = [67,69,71,72,71,69,67,65,67,69,67,65,64,62,64,65];

let noteId = seedLyrics.length;
function createNotes() {
  return seedLyrics.map((l, i) => ({
    id: i + 1,
    tickStart: Math.round(i * 0.75 * 480),
    tickLength: Math.round(0.75 * 480),
    pitch: seedPitches[i],
    lyric: l,
  }));
}

export default function App() {
  const [notes, setNotes] = useState(createNotes);
  const [bpm, setBpm] = useState(DEFAULT_BPM);
  const [tool, setTool] = useState('select');
  const [selectedNoteIds, setSelectedNoteIds] = useState(new Set());
  const [activeCurveId, setActiveCurveId] = useState('f0');

  // Render state
  const [renderStatus, setRenderStatus] = useState('idle'); // idle | rendering | done | error
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderStage, setRenderStage] = useState('');
  const [audioUrl, setAudioUrl] = useState(null);

  // Curve data — per-frame arrays generated after render
  const [curves, setCurves] = useState({
    f0: { color: '#78dcff', visible: true, data: null },
    energy: { color: '#ffb454', visible: false, data: null },
    tension: { color: '#ff6b9e', visible: false, data: null },
    breathiness: { color: '#a0e6d6', visible: false, data: null },
    velocity: { color: '#c9a0ff', visible: false, data: null },
    gender: { color: '#7dd3c0', visible: false, data: null },
    expression: { color: '#9aa8ff', visible: false, data: null },
  });

  const updateCurveVisibility = (id, visible) => {
    setCurves(cs => ({ ...cs, [id]: { ...cs[id], visible } }));
  };

  const addNote = (tickStart, pitch, tickLength = Math.round(0.75 * 480)) => {
    const id = ++noteId;
    setNotes(ns => [...ns, { id, tickStart, pitch, tickLength, lyric: 'あ' }]);
    return id;
  };

  const deleteNotes = (ids) => {
    setNotes(ns => ns.filter(n => !ids.has(n.id)));
    setSelectedNoteIds(new Set());
  };

  const updateNote = (id, patch) => {
    setNotes(ns => ns.map(n => n.id === id ? { ...n, ...patch } : n));
  };

  const moveNote = (id, dTick, dPitch) => {
    setNotes(ns => ns.map(n => {
      if (n.id !== id) return n;
      return {
        ...n,
        tickStart: Math.max(0, n.tickStart + dTick),
        pitch: Math.max(0, Math.min(127, n.pitch + dPitch)),
      };
    }));
  };

  const resizeNote = (id, newLength) => {
    setNotes(ns => ns.map(n =>
      n.id === id ? { ...n, tickLength: Math.max(60, newLength) } : n
    ));
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT') return;
      switch (e.key) {
        case 'v': setTool('select'); break;
        case 'b': setTool('pencil'); break;
        case 'e': setTool('erase'); break;
        case 'k': setTool('scissors'); break;
        case 'p': setTool('curve'); break;
        case 'Delete':
        case 'Backspace':
          if (selectedNoteIds.size > 0) {
            deleteNotes(selectedNoteIds);
          }
          break;
        case 'Escape':
          setSelectedNoteIds(new Set());
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedNoteIds]);

  return (
    <div className="app-layout">
      <TransportBar
        bpm={bpm} setBpm={setBpm}
        renderStatus={renderStatus} renderProgress={renderProgress} renderStage={renderStage}
      />

      <div className="main-area">
        <Sidebar
          activeCurveId={activeCurveId}
          setActiveCurveId={setActiveCurveId}
          curves={curves}
          updateCurveVisibility={updateCurveVisibility}
        />

        <div className="center">
          <PianoRoll
            notes={notes}
            curves={curves}
            activeCurveId={activeCurveId}
            bpm={bpm}
            tool={tool}
            setTool={setTool}
            selectedNoteIds={selectedNoteIds}
            setSelectedNoteIds={setSelectedNoteIds}
            addNote={addNote}
            deleteNotes={deleteNotes}
            updateNote={updateNote}
            moveNote={moveNote}
            resizeNote={resizeNote}
            audioUrl={audioUrl}
          />
        </div>

        <ParamPanel
          notes={notes}
          curves={curves}
          activeCurveId={activeCurveId}
          setActiveCurveId={setActiveCurveId}
          updateCurveVisibility={updateCurveVisibility}
          bpm={bpm}
          renderButton={
            <RenderButton
              notes={notes}
              bpm={bpm}
              setRenderStatus={setRenderStatus}
              setRenderProgress={setRenderProgress}
              setRenderStage={setRenderStage}
              setAudioUrl={setAudioUrl}
              setCurves={setCurves}
              curves={curves}
            />
          }
        />
      </div>
    </div>
  );
}
