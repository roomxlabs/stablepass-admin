// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AdminMobileNav } from "./AdminNav";

// next/link -> plain anchor (forwarding onClick, which is how the drawer closes
// on a nav tap); next/navigation is stubbed so the component renders standalone.
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    onClick,
    className,
  }: {
    children: React.ReactNode;
    href: string;
    onClick?: () => void;
    className?: string;
  }) => (
    <a href={href} onClick={onClick} className={className}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

// jsdom's matchMedia never changes, so stand in a controllable one: the drawer
// listens to the shell media query to reset itself at desktop widths.
let mediaMatches = true;
let mediaListeners: Array<() => void> = [];

function resizeToDesktop() {
  mediaMatches = false;
  act(() => {
    mediaListeners.forEach((listener) => listener());
  });
}

beforeEach(() => {
  mediaMatches = true;
  mediaListeners = [];
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    get matches() {
      return mediaMatches;
    },
    media: query,
    addEventListener: (_event: string, listener: () => void) => {
      mediaListeners.push(listener);
    },
    removeEventListener: (_event: string, listener: () => void) => {
      mediaListeners = mediaListeners.filter((l) => l !== listener);
    },
  }));
});

function renderDrawer() {
  const signOutAction = vi.fn(async () => {});
  const utils = render(
    <AdminMobileNav email="ops@stablepass.co" initial="O" signOutAction={signOutAction} />,
  );
  return {
    ...utils,
    hamburger: screen.getByTestId("admin-hamburger"),
    drawer: screen.getByTestId("admin-drawer"),
    backdrop: screen.getByTestId("admin-drawer-backdrop"),
  };
}

afterEach(cleanup);

describe("AdminMobileNav drawer", () => {
  it("starts closed and inert, with the hamburger reporting aria-expanded=false", () => {
    const { hamburger, drawer } = renderDrawer();
    expect(hamburger.getAttribute("aria-expanded")).toBe("false");
    expect(hamburger.getAttribute("aria-label")).toBe("Open navigation");
    expect(hamburger.getAttribute("aria-controls")).toBe("admin-drawer");
    expect(drawer.className).not.toContain("open");
    // Closed drawer is out of the tab order / a11y tree.
    expect(drawer.hasAttribute("inert")).toBe(true);
  });

  it("opens on the hamburger click, toggles aria-expanded, and drops inert", () => {
    const { hamburger, drawer } = renderDrawer();
    fireEvent.click(hamburger);
    expect(hamburger.getAttribute("aria-expanded")).toBe("true");
    expect(hamburger.getAttribute("aria-label")).toBe("Close navigation");
    expect(drawer.className).toContain("open");
    expect(drawer.hasAttribute("inert")).toBe(false);
  });

  it("renders the same nav items as the sidebar", () => {
    const { drawer } = renderDrawer();
    for (const label of ["Dashboard", "Compose", "Posts", "Horses", "Trainers"]) {
      expect(screen.getByRole("link", { name: new RegExp(label) })).toBeTruthy();
    }
    expect(drawer.querySelectorAll("a").length).toBe(5);
  });

  it("closes when a nav link is tapped, returning focus to the hamburger", () => {
    const { hamburger, drawer } = renderDrawer();
    fireEvent.click(hamburger);
    expect(drawer.className).toContain("open");

    fireEvent.click(screen.getByRole("link", { name: /Horses/ }));
    expect(drawer.className).not.toContain("open");
    expect(hamburger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(hamburger);
  });

  it("closes on Escape and returns focus to the hamburger", () => {
    const { hamburger, drawer } = renderDrawer();
    fireEvent.click(hamburger);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(drawer.className).not.toContain("open");
    expect(hamburger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(hamburger);
  });

  it("closes on a backdrop click and returns focus to the hamburger", () => {
    const { hamburger, drawer, backdrop } = renderDrawer();
    fireEvent.click(hamburger);

    fireEvent.click(backdrop);
    expect(drawer.className).not.toContain("open");
    expect(hamburger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(hamburger);
  });

  it("locks body scroll only while open", () => {
    const { hamburger } = renderDrawer();
    expect(document.body.style.overflow).not.toBe("hidden");

    fireEvent.click(hamburger);
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("restores body scroll if it unmounts while still open", () => {
    const { hamburger, unmount } = renderDrawer();
    fireEvent.click(hamburger);
    expect(document.body.style.overflow).toBe("hidden");

    unmount();
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("resets when the viewport grows past the shell breakpoint", () => {
    const { hamburger, drawer } = renderDrawer();
    fireEvent.click(hamburger);
    expect(drawer.className).toContain("open");

    resizeToDesktop();

    expect(drawer.className).not.toContain("open");
    expect(document.body.style.overflow).not.toBe("hidden");
  });
});
