import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const localChrome = existsSync('/Applications/Google Chrome.app');
export default defineConfig({
  testDir: './tests/browser',
  use: {
    ...devices['iPhone 13'], defaultBrowserType: 'chromium',
    launchOptions: localChrome ? { channel: 'chrome' } : {},
    baseURL: 'http://127.0.0.1:4173',
  },
  webServer: {
    command: 'npx vite build --outDir .local/test-dist && npx vite preview --outDir .local/test-dist --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI,
    env: { VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_PUBLISHABLE_KEY: 'test-public-key' },
  },
});
