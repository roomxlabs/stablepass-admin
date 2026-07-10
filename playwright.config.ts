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
    command: "npm run dev -- -p 3002",
    url: "http://127.0.0.1:3002/signin",
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:8787",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "fake-anon-key",
    },
  },
});
