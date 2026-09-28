// ENG-1591 — the installed admin's colours, from the tokens in app/globals.css.
// Shared by app/manifest.ts (Android/desktop install) and app/layout.tsx's
// `viewport.themeColor` (the browser/status-bar tint), so the two can't drift.
export const ADMIN_APP_NAME = "StablePass Admin";
export const ADMIN_THEME_COLOR = "#122E26"; // --brand-green-darker (sidebar + phone bar)
export const ADMIN_BACKGROUND_COLOR = "#FAF7F2"; // --cream (page background)
