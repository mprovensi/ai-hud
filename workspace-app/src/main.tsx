import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

const wsSplash = document.getElementById('wsSplash');
if (wsSplash) {
  requestAnimationFrame(() => {
    wsSplash.classList.add('hide');
    window.setTimeout(() => wsSplash.remove(), 280);
  });
}
