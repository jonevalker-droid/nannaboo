import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Dashboard from './dashboard/Dashboard.jsx';
import Console from './console/Console.jsx';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// /dashboard = admin/promoter ops dashboard (aggregated only),
// /console = security console (identified, audited); everything else = guest PWA.
const path = window.location.pathname;
const surface = path.startsWith('/console') ? <Console />
  : path.startsWith('/dashboard') ? <Dashboard />
  : <App />;

createRoot(document.getElementById('root')).render(
  <StrictMode>{surface}</StrictMode>
);
