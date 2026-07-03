import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Dashboard from './dashboard/Dashboard.jsx';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// /dashboard is the staff ops console; everything else is the guest PWA.
const isDashboard = window.location.pathname.startsWith('/dashboard');

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isDashboard ? <Dashboard /> : <App />}
  </StrictMode>
);
