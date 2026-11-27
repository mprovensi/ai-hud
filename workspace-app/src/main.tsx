import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

declare global {
  interface Window {
    __wsBootProgress?: (pct: number, text: string) => void;
    __wsBootDone?: () => void;
  }
}

window.__wsBootProgress?.(48, 'Inicializando aplicativo…');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
