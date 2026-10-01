/* eslint-disable @typescript-eslint/no-require-imports */
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /header\.spec\.cjs/,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['line']],
  outputDir: 'test-results/header-playwright',
  use: {
    baseURL: process.env.HEADER_BASE_URL || 'http://127.0.0.1:4321',
    browserName: 'chromium',
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
    colorScheme: 'light',
    locale: 'en-KE',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { viewport: { width: 1024, height: 768 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: process.env.HEADER_BASE_URL
    ? undefined
    : {
        command:
          'pnpm exec wrangler dev --config dist/server/wrangler.json --ip 127.0.0.1 --port 4321',
        url: 'http://127.0.0.1:4321',
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
