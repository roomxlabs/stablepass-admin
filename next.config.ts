import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright drives the dev server on http://127.0.0.1:3002. Next 16 treats a
  // dev request whose origin isn't listed here as cross-origin and blocks the
  // dev resources it needs — including the HMR socket, whose failed handshake
  // aborts the client bootstrap, so NOTHING on the page hydrates and every
  // interactive e2e assertion fails. Dev-only; no effect on a production build.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
