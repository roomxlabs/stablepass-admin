// Nav / chrome icons, lifted from the mockups' icons.js so the shell matches
// the design 1:1. All are 24x24 line icons styled by the global `.ic` rule
// (fill:none; stroke:currentColor) except `play`, which is a solid glyph.
import type { ReactNode } from "react";

export type IconName = "home" | "play" | "bookmark" | "horseHead" | "user" | "search" | "logOut";

const PATHS: Record<Exclude<IconName, "play">, ReactNode> = {
  home: <path d="M3 11l9-8 9 8M5 9.5V21h14V9.5" />,
  bookmark: <path d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l7-5 7 5z" />,
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a8 8 0 0116 0v1" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </>
  ),
  horseHead: (
    <path d="M16 4c-.5-.5-1-1-2-1-1 0-1.5.5-2 1l-1 2c-3 .5-7 2.5-7 6 0 2 1 3 2 3.5L7 17l1 4h2l1-3 2 1 1 2h2l1-3 2-1.5c.5-.5 1-1.5 1-3 0-2.5-2-4-2-4l1-2c.5-1.5.5-3-1-3.5z" />
  ),
  logOut: <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />,
};

export function Icon({ name }: { name: IconName }) {
  if (name === "play") {
    return (
      <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
        <polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
