"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./icons";

type NavItem = { href: string; label: string; icon: IconName };

// Nav matches screens/02-dashboard.html. Counts in the mockup are seeded demo
// numbers; the real badges are wired when each resource screen ships, so the
// shell renders none rather than fake ones.
const PRIMARY: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "home" },
  { href: "/compose", label: "Compose", icon: "play" },
  { href: "/posts", label: "Posts", icon: "bookmark" },
];

const LIBRARY: NavItem[] = [
  { href: "/horses", label: "Horses", icon: "horseHead" },
  { href: "/trainers", label: "Trainers", icon: "user" },
];

// The exact query app/globals.css uses for the shell breakpoint: below it the
// sidebar is hidden and the drawer is the only way to reach the nav. Sharing the
// query (rather than comparing innerWidth to 900) keeps JS and CSS from
// disagreeing at fractional viewport widths.
const SHELL_MEDIA_QUERY = "(max-width: 899px)";

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

function NavList({
  items,
  pathname,
  onNavigate,
}: {
  items: NavItem[];
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <ul className="admin-nav">
      {items.map((item) => (
        <li key={item.href}>
          <Link
            href={item.href}
            className={isActive(pathname, item.href) ? "active" : undefined}
            onClick={onNavigate}
          >
            <Icon name={item.icon} /> {item.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

// The nav itself — rendered both in the desktop sidebar and inside the mobile
// drawer. `onNavigate` lets the drawer close itself when a link is tapped.
export default function AdminNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <>
      <NavList items={PRIMARY} pathname={pathname} onNavigate={onNavigate} />
      <div className="admin-sidebar-section">Library</div>
      <NavList items={LIBRARY} pathname={pathname} onNavigate={onNavigate} />
    </>
  );
}

// Mobile chrome (< 900px): a slim brand bar with a hamburger, plus the slide-in
// drawer it controls. Both are display:none at desktop widths, so the desktop
// shell is untouched. The drawer reuses the sidebar's markup/classes verbatim so
// it carries the same design tokens as screens/02-dashboard.html.
type MobileNavProps = {
  email: string;
  initial: string;
  signOutAction: () => Promise<void>;
};

export function AdminMobileNav(props: MobileNavProps) {
  const pathname = usePathname();
  // Keying on the route is how a soft navigation closes the drawer: a new path
  // remounts the drawer, resetting `open` to false. Doing it this way (rather
  // than syncing state from an effect) keeps the reset in React's own
  // reconciliation instead of costing a cascading re-render.
  return <MobileNavDrawer key={pathname} {...props} />;
}

function MobileNavDrawer({ email, initial, signOutAction }: MobileNavProps) {
  const [open, setOpen] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  // Closing returns focus to the control that opened the drawer.
  const close = useCallback(() => {
    setOpen(false);
    hamburgerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    // Growing past the breakpoint reveals the real sidebar, so the drawer state
    // must reset — otherwise the backdrop, and the body scroll lock below,
    // would stick on a desktop-width page.
    const shellQuery = window.matchMedia(SHELL_MEDIA_QUERY);
    const onShellChange = () => {
      if (!shellQuery.matches) setOpen(false);
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    shellQuery.addEventListener("change", onShellChange);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      shellQuery.removeEventListener("change", onShellChange);
    };
  }, [open, close]);

  return (
    <>
      <div className="admin-mobile-bar">
        {/* eslint-disable-next-line @next/next/no-img-element -- fixed-height brand lockup, CSS-scaled */}
        <img src="/brand/wordmark-white.png" alt="stablepass." />
        <span className="badge">Admin</span>
        <button
          ref={hamburgerRef}
          type="button"
          className="admin-hamburger"
          data-testid="admin-hamburger"
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          aria-controls="admin-drawer"
          onClick={() => setOpen((wasOpen) => !wasOpen)}
        >
          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      </div>

      <div
        className={`admin-drawer-backdrop${open ? " open" : ""}`}
        data-testid="admin-drawer-backdrop"
        onClick={close}
        aria-hidden="true"
      />

      {/* `inert` while closed keeps the off-screen links out of the tab order
          and out of the accessibility tree. */}
      <aside
        id="admin-drawer"
        className={`admin-drawer${open ? " open" : ""}`}
        data-testid="admin-drawer"
        aria-label="Main navigation"
        inert={!open}
      >
        <div className="admin-sidebar-logo">
          {/* eslint-disable-next-line @next/next/no-img-element -- fixed-height brand lockup, CSS-scaled */}
          <img src="/brand/wordmark-white.png" alt="stablepass." />
          <span className="badge">Admin</span>
        </div>

        {/* `close`, not a bare setOpen, so focus lands back on the hamburger —
            it matters when the tapped link is the current route (no remount). */}
        <AdminNav onNavigate={close} />

        <form action={signOutAction} className="admin-sidebar-foot">
          <div className="av">{initial}</div>
          <div className="who">
            <strong>{email}</strong>
            <span>Staff · Admin</span>
          </div>
          <button type="submit" className="signout-btn" aria-label="Sign out" title="Sign out">
            <Icon name="logOut" />
          </button>
        </form>
      </aside>
    </>
  );
}
