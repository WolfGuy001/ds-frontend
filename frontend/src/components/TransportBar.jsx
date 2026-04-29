// ─── Transport Bar — top bar with BPM, tools, render status ─
export default function TransportBar({ bpm, setBpm, renderStatus, renderProgress, renderStage }) {
  return (
    <div className="topbar">
      <div className="topbar-left">
        <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.02em' }}>SynthDiff</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
          {bpm} BPM
        </span>
      </div>

      {/* BPM + render status */}
      <div className="topbar-right" style={{ gap: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--fg-dim)' }}>
          BPM
          <input
            type="number"
            className="field mono"
            value={bpm}
            onChange={e => setBpm(Math.max(20, Math.min(300, +e.target.value || 120)))}
            style={{ width: 52 }}
          />
        </label>

        {renderStatus === 'rendering' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 160 }}>
            <span style={{ fontSize: 10, color: 'var(--fg-dim)' }}>{renderStage}</span>
            <div className="progress-bar" style={{ width: '100%' }}>
              <div className="progress-fill" style={{ width: renderProgress + '%' }} />
            </div>
          </div>
        )}

        {renderStatus === 'done' && (
          <span style={{ fontSize: 11, color: 'var(--success)' }}>✓ Rendered</span>
        )}

        {renderStatus === 'error' && (
          <span style={{ fontSize: 11, color: 'var(--danger)' }}>Render failed</span>
        )}
      </div>
    </div>
  );
}
