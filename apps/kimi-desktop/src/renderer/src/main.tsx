import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { initAppearancePreferences } from './lib/appearancePreferencesBrowser';
import { ConnectionProvider } from './lib/connection';
import { initTheme } from './lib/theme';
import './styles/app.css';

// Apply the persisted theme before React mounts to avoid a flash.
initTheme();
initAppearancePreferences();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 0, refetchOnWindowFocus: false },
  },
});

createRoot(document.querySelector('#root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider>
        <App />
      </ConnectionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
