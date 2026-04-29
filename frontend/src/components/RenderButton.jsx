// ─── Render Button — with full debug logging ────────────
import { useState } from 'react';

export default function RenderButton({
  notes, bpm,
  setRenderStatus, setRenderProgress, setRenderStage,
  setAudioUrl, setCurves, curves,
}) {
  const [disabled, setDisabled] = useState(false);
  const [lastError, setLastError] = useState('');

  const handleRender = async () => {
    if (notes.length === 0) return;
    setDisabled(true);
    setRenderStatus('rendering');
    setRenderProgress(0);
    setRenderStage('Preparing...');
    setLastError('');

    try {
      const payload = { notes, bpm, voicebank: 'Netriko_Nakayama_AI_v100', speaker: 'standard' };
      console.log('[Render] Sending:', JSON.stringify(payload).slice(0, 200));

      setRenderStage('Sending to engine...');
      const resp = await fetch('/api/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      console.log('[Render] Response:', resp.status, resp.statusText, resp.headers.get('content-type'));

      if (!resp.ok) {
        let errBody = '';
        try { errBody = await resp.text(); } catch {}
        console.error('[Render] Error body:', errBody);
        throw new Error(`Server returned ${resp.status}: ${errBody}`);
      }

      setRenderProgress(90);
      setRenderStage('Receiving audio...');

      const wavBlob = await resp.blob();
      console.log('[Render] Got blob:', wavBlob.size, 'bytes, type:', wavBlob.type);

      if (wavBlob.size < 100) {
        const text = await wavBlob.text();
        console.error('[Render] Small response (error JSON?):', text);
        throw new Error(text || 'Empty audio response');
      }

      const url = URL.createObjectURL(wavBlob);
      console.log('[Render] Blob URL:', url);

      setAudioUrl(url);
      setRenderProgress(100);
      setRenderStatus('done');
      setRenderStage('Complete');

      const audio = new Audio(url);
      audio.onerror = (e) => console.error('[Render] Audio playback error:', e);
      audio.play().then(() => console.log('[Render] Playing')).catch(e => console.error('[Render] Play rejected:', e));

    } catch (err) {
      console.error('[Render] FAILED:', err);
      setRenderStatus('error');
      setRenderStage(err.message || String(err));
      setLastError(err.stack || err.message);
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

      {lastError && (
        <div style={{
          fontSize: 9, color: 'var(--danger)', wordBreak: 'break-all',
          background: 'rgba(255,0,0,0.08)', padding: 6, borderRadius: 6,
          maxHeight: 80, overflow: 'auto',
        }}>
          {lastError.split('\n').slice(0, 3).join('\n')}
        </div>
      )}

      <div style={{ fontSize: 10, color: 'var(--fg-mute)', textAlign: 'center' }}>
        {notes.length} notes, {bpm} BPM
      </div>
    </div>
  );
}
