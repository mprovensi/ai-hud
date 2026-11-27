import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

declare global {
  interface Window {
    __wsBootProgress?: (pct: number, text: string, stepIdx?: number) => void;
    __wsBootDone?: () => void;
  }
}

window.__wsBootProgress?.(78, 'Inicializando aplicativo…', 2);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
