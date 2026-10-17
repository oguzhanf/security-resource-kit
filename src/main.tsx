import { Component, StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error: Error) {
    console.error('Training interface failed:', error.name);
  }

  render() {
    if (this.state.failed) return <main className="fatal-error">
      <h1>The training interface could not start.</h1>
      <p>Reload the page. If the problem persists, contact the site operator without sharing credentials or sensitive data.</p>
      <button onClick={() => window.location.reload()}>Reload</button>
    </main>;
    return this.props.children;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing.');
createRoot(root).render(<StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>);
