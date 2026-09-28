"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";

// ENG-1585 — the phone shell. Above 768px this renders exactly what the layout
// always rendered: the sticky `.admin-sidebar` in the shell's first grid
// column (the mobile bar and scrim are `display: none` there, so they take no
// grid cell). Below 768px the sidebar becomes an off-canvas drawer, opened
// from a slim brand bar at the top of the page.
//
// The drawer's CONTENT (logo, nav, sign-out form) stays in the Server
// Component layout and arrives here as `children`, so the sign-out server
// action is untouched by this client boundary.
//
// Closed-state accessibility is done in CSS, not JS: the closed drawer is
// `visibility: hidden` below 768px, so its links drop out of the tab order and
// the accessibility tree without a matchMedia listener that could disagree with
// the stylesheet about where the breakpoint is.
export default function SidebarDrawer({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    toggleRef.current?.focus();
  }, []);

  // Any navigation closes the drawer: tapping a nav link on a phone should land
  // you on the screen, not leave the menu covering it. Adjusting state while
  // rendering (React's "store the previous prop" pattern) avoids the extra
  // commit a setState-in-effect would cost.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    // Rotating / resizing past the breakpoint with the drawer open would leave
    // the scroll lock on with no visible way to close it (the toggle and close
    // buttons are desktop-hidden), so crossing to desktop closes the drawer.
    const wide = window.matchMedia?.("(min-width: 768px)");
    const onWide = (e: MediaQueryListEvent) => {
      if (e.matches) setOpen(false);
    };
    wide?.addEventListener?.("change", onWide);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    // Stop the page behind the scrim scrolling under a finger drag.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      wide?.removeEventListener?.("change", onWide);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, close]);

  return (
    <>
      <header className="admin-mobilebar">
        {/* eslint-disable-next-line @next/next/no-img-element -- fixed-height brand lockup, CSS-scaled */}
        <img src="/brand/wordmark-white.png" alt="stablepass." />
        <span className="badge">Admin</span>
        <button
          ref={toggleRef}
          type="button"
          className="admin-mobilebar-toggle"
          aria-label="Open menu"
          aria-expanded={open}
          aria-controls="admin-sidebar"
          onClick={() => setOpen(true)}
        >
          <Icon name="menu" />
        </button>
      </header>

      <div
        className="admin-drawer-scrim"
        data-open={open ? "true" : undefined}
        aria-hidden="true"
        onClick={close}
      />

      <aside
        id="admin-sidebar"
        className="admin-sidebar"
        data-open={open ? "true" : undefined}
        aria-label="Admin navigation"
        // Tapping a nav link closes the drawer even when it points at the
        // page you're already on (the pathname check above can't see that).
        onClick={(e) => {
          if ((e.target as Element).closest("a")) setOpen(false);
        }}
      >
        <button
          ref={closeRef}
          type="button"
          className="admin-drawer-close"
          aria-label="Close menu"
          onClick={close}
        >
          <Icon name="close" />
        </button>
        {children}
      </aside>
    </>
  );
}
