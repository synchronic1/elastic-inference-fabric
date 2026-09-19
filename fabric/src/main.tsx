import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './access.css';
import './topology.css';
import './theme.css';
// React Flow's own stylesheet lives here rather than in BenchDiagram.tsx: the
// test runner loads that module, and it has no CSS loader.
import '@xyflow/react/dist/style.css';
// Last, so the bench's own rules win over React Flow's base styles.
import './bench.css';
import './node-identity.css';
import './copilot.css';
import './ambiguous.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
