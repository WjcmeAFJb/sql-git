import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for the demo-opfs2 integration suite.
 *
 * OPFS is per-origin, not per-context, so tests can't run in parallel
 * against the same dev server without racing on storage. We serialise
 * (`workers: 1`) and wipe OPFS + sessionStorage between tests (see the
 * shared fixture in `e2e/helpers.ts`).
 *
 * On CI we start a fresh dev server; locally we reuse whatever's already
 * on :5173 so iterating is fast.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
    },
  },
  reporter: process.env.CI ? [["list"]] : [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 1400, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    // Force a deterministic reduced-motion / color-scheme so screenshots
    // don't shift between local and CI runs.
    colorScheme: "dark",
    reducedMotion: "reduce",
  },
  webServer: {
    command: "pnpm dev",
    port: 5173,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
