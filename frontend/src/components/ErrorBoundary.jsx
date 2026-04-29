import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info);
    this.setState({ info });
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: '#0c0d0e', color: 'var(--fg)',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: 40, gap: 16,
        }}>
          <div style={{ fontSize: 24, color: 'var(--danger)' }}>⚠ Error</div>
          <div className="mono" style={{
            fontSize: 12, color: 'var(--fg-dim)',
            background: 'rgba(255,255,255,0.04)', padding: 16, borderRadius: 8,
            maxWidth: 600, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          }}>
            {this.state.error?.message || String(this.state.error)}
          </div>
          {this.state.info?.componentStack && (
            <details style={{ fontSize: 10, color: 'var(--fg-mute)', maxWidth: 600 }}>
              <summary>Stack</summary>
              <pre style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{this.state.info.componentStack}</pre>
            </details>
          )}
          <button
            onClick={() => window.location.reload()}
            className="btn btn-primary"
            style={{ marginTop: 16 }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
