// ─── Render Button — triggers inference via bridge server ─
import { useState } from 'react';

export default function RenderButton({
  notes, bpm,
  setRenderStatus, setRenderProgress, setRenderStage,
  setAudioUrl, setCurves, curves,
}) {
  const [disabled, setDisabled] = useState(false);

  const handleRender = async () => {
    if (notes.length === 0) return;
    setDisabled(true);
    setRenderStatus('rendering');
    setRenderProgress(0);
    setRenderStage('Preparing...');

    try {
      // Update progress periodically (simulate since actual progress comes from pipeline stdout)
      const progressInterval = setInterval(() => {
        setRenderProgress(p => Math.min(p + 5, 90));
      }, 300);

      setRenderStage('Sending to engine...');
      const resp = await fetch('/api/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes,
          bpm,
          voicebank: 'Netriko_Nakayama_AI_v100',
          speaker: 'standard',
        }),
      });

      clearInterval(progressInterval);

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(err.error || 'Render failed');
      }

      setRenderStage('Processing audio...');
      setRenderProgress(95);

      const wavBlob = await resp.blob();
      const url = URL.createObjectURL(wavBlob);

      // Revoke old URL
      if (audioUrl) URL.revokeObjectURL(audioUrl);

      setAudioUrl(url);
      setRenderProgress(100);
      setRenderStatus('done');
      setRenderStage('Complete');

      // Play audio
      const audio = new Audio(url);
      audio.play().catch(() => {});

    } catch (err) {
      console.error('Render failed:', err);
      setRenderStatus('error');
      setRenderStage(err.message || 'Unknown error');
    } finally {
      setDisabled(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <button
        className="btn btn-primary"
        onClick={handleRender}
        disabled={disabled}
        style={{ width: '100%', justifyContent: 'center', fontSize: 13 }}
      >
        {disabled ? 'Rendering...' : '▶ Render'}
      </button>

      <div style={{ fontSize: 10, color: 'var(--fg-mute)', textAlign: 'center' }}>
        {notes.length} notes, {bpm} BPM
      </div>
    </div>
  );
}
