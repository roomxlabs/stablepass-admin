import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    viewport: { width: 1280, height: 900 },
    baseURL: "http://127.0.0.1:3002",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
  ],
  webServer: {
    // Production build, NOT `next dev` — this is what .rx/gotchas.md
    // ("Screenshots: `next start`, not `next dev`") has always prescribed; the
    // config had drifted from it. Under the dev server the client bundle never
    // finished hydrating in CI-like runs, so every `"use client"` screen
    // rendered its SSR markup but stayed inert: compose's horse picker never
    // opened and its caption counter never moved off 0/240, failing
    // compose.spec.ts. Building first costs ~1min and makes the suite
    // deterministic — and it screenshots what users actually get.
    command: "npm run build && npm run start -- -p 3002",
    url: "http://127.0.0.1:3002/signin",
    reuseExistingServer: false,
    // Generous: covers the production build plus server start.
    timeout: 300000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:8787",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "fake-anon-key",
    },
  },
});
