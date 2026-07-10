import type { Server } from "node:http";

export default async function globalTeardown() {
  const server = (globalThis as typeof globalThis & { __mockSupabaseServer?: Server })
    .__mockSupabaseServer;
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
