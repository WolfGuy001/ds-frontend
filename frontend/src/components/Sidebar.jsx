// ─── Sidebar — left panel: project list, voice model ─────
const TOOLS = [
  { id: 'select', icon: '⇱', label: 'Select', kbd: 'V' },
  { id: 'pencil', icon: '✎', label: 'Draw', kbd: 'B' },
  { id: 'erase', icon: '⌫', label: 'Erase', kbd: 'E' },
  { id: 'scissors', icon: '✂', label: 'Split', kbd: 'K' },
  { id: 'curve', icon: '∼', label: 'Curve', kbd: 'P' },
];

export default function Sidebar({ activeCurveId, setActiveCurveId, curves, updateCurveVisibility }) {
  return (
    <div className="sidebar">
      {/* Voice model selector */}
      <div style={{ padding: '14px 16px 6px', fontSize: 12, fontWeight: 600 }}>Voice Model</div>
      <div style={{ padding: '0 14px' }}>
        <select className="field" style={{ width: '100%', fontSize: 11 }} defaultValue="netriko">
          <option value="netriko">Netriko Nakayama</option>
        </select>
      </div>

      <div style={{ marginTop: 10, padding: '0 14px' }}>
        <div className="chip" style={{ fontSize: 10 }}>
          <span style={{ color: 'var(--accent)' }}>●</span> onnxruntime-node
        </div>
      </div>

      {/* Curve visibility toggles */}
      <div className="section-title">Curves</div>
      {Object.entries(curves).map(([id, c]) => (
        <div
          key={id}
          className="sidebar-item"
          style={{
            gap: 8,
            padding: '5px 12px',
            background: activeCurveId === id ? 'var(--accent-soft)' : undefined,
            color: activeCurveId === id ? 'var(--accent)' : undefined,
          }}
          onClick={() => setActiveCurveId(id)}
        >
          <span style={{
            width: 10, height: 10, borderRadius: '50%',
            background: c.visible ? c.color : 'transparent',
            border: `2px solid ${c.color}`,
            flexShrink: 0,
          }} />
          <span style={{ flex: 1, fontSize: 11 }}>
            {id.charAt(0).toUpperCase() + id.slice(1)}
          </span>
          <button
            onClick={e => { e.stopPropagation(); updateCurveVisibility(id, !c.visible); }}
            style={{
              color: c.visible ? 'var(--fg-dim)' : 'var(--fg-mute)',
              fontSize: 14, lineHeight: 1,
            }}
          >
            {c.visible ? '👁' : '—'}
          </button>
        </div>
      ))}
    </div>
  );
}
