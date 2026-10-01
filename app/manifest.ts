import type { MetadataRoute } from "next";
import { ADMIN_APP_NAME, ADMIN_BACKGROUND_COLOR, ADMIN_THEME_COLOR } from "@/lib/pwa";

// ENG-1591 (A3c) — the admin is installable to a phone home screen.
//
// Deliberately NO service worker: iOS "Add to Home Screen" doesn't need one,
// and an offline cache in front of an operator dashboard would serve stale
// admin data (a post that already published, a subscriber already comped).
// The manifest + apple-touch-icon are all install needs.
//
// The icons are the ADMIN mark (navy ground, cream "S", gold dot, "ADMIN"),
// not the member app's green "S." — so the two are told apart at a glance on
// the same home screen.

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: ADMIN_APP_NAME,
    short_name: ADMIN_APP_NAME,
    description: "Stablepass internal operator dashboard.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: ADMIN_BACKGROUND_COLOR,
    theme_color: ADMIN_THEME_COLOR,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
