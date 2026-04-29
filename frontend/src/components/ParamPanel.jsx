// ─── Right Panel — parameter info, inference settings, render btn ─
export default function ParamPanel({
  notes, curves, activeCurveId,
  setActiveCurveId, updateCurveVisibility,
  bpm, renderButton,
}) {
  return (
    <div className="right-panel">
      {/* Project info */}
      <div style={{ padding: '14px 16px 8px' }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Project</div>
        <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginTop: 2 }} className="mono">
          {notes.length} notes, {bpm} BPM
        </div>
      </div>

      <div style={{ padding: '4px 16px' }}>
        <div style={{ fontSize: 10, color: 'var(--fg-mute)', marginBottom: 4 }}>Duration</div>
        <div className="mono" style={{ fontSize: 12 }}>
          {notes.length > 0 ? (
            <>
              {(tickToSeconds(notes[notes.length - 1].tickStart + notes[notes.length - 1].tickLength, bpm)).toFixed(1)}s
              {' / '}
              {notes.length > 0 ? `${Math.ceil((notes[notes.length - 1].tickStart + notes[notes.length - 1].tickLength) / 480 / 4)} bars` : '0 bars'}
            </>
          ) : 'Empty'}
        </div>
      </div>

      {/* Curves list */}
      <div className="section-title">Parameters</div>
      {Object.entries(curves).map(([id, c]) => (
        <div key={id} style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '4px 16px', cursor: 'pointer',
          borderLeft: activeCurveId === id ? '2px solid var(--accent)' : '2px solid transparent',
        }} onClick={() => setActiveCurveId(id)}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: c.visible ? c.color : 'transparent',
            border: `2px solid ${c.color}`,
            flexShrink: 0,
          }} />
          <span style={{ flex: 1, fontSize: 11, color: 'var(--fg-dim)' }}>
            {id.charAt(0).toUpperCase() + id.slice(1)}
          </span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--fg-mute)' }}>
            {c.data ? `${c.data.length}f` : '—'}
          </span>
          <button
            onClick={e => { e.stopPropagation(); updateCurveVisibility(id, !c.visible); }}
            style={{ color: c.visible ? 'var(--fg-dim)' : 'var(--fg-mute)', fontSize: 12 }}>
            {c.visible ? '●' : '○'}
          </button>
        </div>
      ))}

      {/* Render section */}
      <div style={{ marginTop: 'auto', padding: '12px 16px', borderTop: '1px solid var(--line)' }}>
        {renderButton}
      </div>
    </div>
  );
}

function tickToSeconds(ticks, bpm) {
  return (ticks / 480) * (60 / bpm);
}
