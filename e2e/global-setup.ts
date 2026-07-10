import startMockSupabase from "./mock-supabase.mjs";

// Starts the mock Supabase HTTP server before the Playwright webServer (and
// tests) run. The handle is stashed on globalThis so global-teardown can
// close it again.
export default async function globalSetup() {
  const server = await startMockSupabase();
  (globalThis as typeof globalThis & { __mockSupabaseServer?: unknown }).__mockSupabaseServer =
    server;
}
