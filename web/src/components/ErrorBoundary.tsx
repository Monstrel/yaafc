import { Component, type ReactNode } from 'react'
import { clearStoredData, downloadStoredData } from '../lib/store'

interface State {
  error: Error | null
}

/**
 * Catches a crash anywhere in the app. What's stored is read again on every load, so a crash it
 * causes would come back after a reload: this offers to save that data and start over.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  startOver = () => {
    if (!confirm('Delete every plan, saved recipe and setting kept in this browser, and start over?')) return
    clearStoredData()
    location.reload()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="app">
        <div className="panel crash">
          <h2>Something went wrong</h2>
          <p>The calculator hit an error it couldn&apos;t recover from:</p>
          <pre>{error.message || String(error)}</pre>
          <p>
            Reload to try again. If the error keeps coming back, download your data first, then start over. You
            can import the download later, once the problem is fixed.
          </p>
          <div className="crash-actions">
            <button type="button" className="primary" onClick={() => location.reload()}>
              Reload
            </button>
            <button type="button" onClick={downloadStoredData}>
              Download my data
            </button>
            <button type="button" className="danger" onClick={this.startOver}>
              Start over
            </button>
          </div>
        </div>
      </div>
    )
  }
}
