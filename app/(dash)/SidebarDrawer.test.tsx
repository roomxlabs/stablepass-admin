// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import SidebarDrawer from "./SidebarDrawer";

// The mocked pathname is a plain mutable variable so a test can move it (a
// simulated navigation) and then `rerender` to re-run usePathname() with the
// new value, exactly like a real route change would.
let mockPathname = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

afterEach(() => {
  cleanup();
  mockPathname = "/";
});

function renderDrawer() {
  return render(
    <SidebarDrawer>
      <a href="/posts">Posts</a>
    </SidebarDrawer>,
  );
}

describe("SidebarDrawer — closed by default", () => {
  it("renders the toggle closed, the drawer without data-open, and the children inside the aside", () => {
    renderDrawer();

    const toggle = screen.getByRole("button", { name: "Open menu" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("admin-sidebar");

    const aside = document.querySelector("#admin-sidebar") as HTMLElement;
    expect(aside.hasAttribute("data-open")).toBe(false);
    expect(aside.querySelector("a[href='/posts']")?.textContent).toBe("Posts");
  });
});

describe("SidebarDrawer — opening", () => {
  it("opening sets aria-expanded, data-open on the aside and the scrim, focuses Close menu, and locks body scroll", () => {
    renderDrawer();

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    const toggle = screen.getByRole("button", { name: "Open menu" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const aside = document.querySelector("#admin-sidebar") as HTMLElement;
    const scrim = document.querySelector(".admin-drawer-scrim") as HTMLElement;
    expect(aside.getAttribute("data-open")).toBe("true");
    expect(scrim.getAttribute("data-open")).toBe("true");

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close menu" }));
    expect(document.body.style.overflow).toBe("hidden");
  });
});

describe("SidebarDrawer — closing", () => {
  it("the close button closes it, returns focus to the toggle, and restores the previous body overflow", () => {
    document.body.style.overflow = "auto";
    renderDrawer();

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));

    const toggle = screen.getByRole("button", { name: "Open menu" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const aside = document.querySelector("#admin-sidebar") as HTMLElement;
    expect(aside.hasAttribute("data-open")).toBe(false);
    expect(document.activeElement).toBe(toggle);
    expect(document.body.style.overflow).toBe("auto");
  });

  it("Escape closes it", () => {
    renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(screen.getByRole("button", { name: "Open menu" }).getAttribute("aria-expanded")).toBe(
      "true",
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.getByRole("button", { name: "Open menu" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect((document.querySelector("#admin-sidebar") as HTMLElement).hasAttribute("data-open")).toBe(
      false,
    );
  });

  it("clicking the scrim closes it", () => {
    renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    fireEvent.click(document.querySelector(".admin-drawer-scrim") as HTMLElement);

    expect(screen.getByRole("button", { name: "Open menu" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(
      (document.querySelector(".admin-drawer-scrim") as HTMLElement).hasAttribute("data-open"),
    ).toBe(false);
  });

  it("Escape while closed does nothing and does not throw", () => {
    renderDrawer();
    expect(() => fireEvent.keyDown(document, { key: "Escape" })).not.toThrow();
    expect(screen.getByRole("button", { name: "Open menu" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });
});

describe("SidebarDrawer — navigation", () => {
  it("a pathname change closes an open drawer", () => {
    const { rerender } = renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(screen.getByRole("button", { name: "Open menu" }).getAttribute("aria-expanded")).toBe(
      "true",
    );

    mockPathname = "/posts";
    rerender(
      <SidebarDrawer>
        <a href="/posts">Posts</a>
      </SidebarDrawer>,
    );

    expect(screen.getByRole("button", { name: "Open menu" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(
      (document.querySelector("#admin-sidebar") as HTMLElement).hasAttribute("data-open"),
    ).toBe(false);
  });
});

describe("SidebarDrawer — review fixes", () => {
  it("tapping a nav link closes it even when the pathname does not change", () => {
    renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByText("Posts"));
    expect((document.querySelector("#admin-sidebar") as HTMLElement).hasAttribute("data-open")).toBe(
      false,
    );
  });

  it("crossing to the desktop breakpoint while open closes it and releases the scroll lock", () => {
    let listener: ((e: { matches: boolean }) => void) | undefined;
    const original = window.matchMedia;
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => {
        listener = fn;
      },
      removeEventListener: () => {
        listener = undefined;
      },
    })) as unknown as typeof window.matchMedia;
    try {
      document.body.style.overflow = "";
      renderDrawer();
      fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
      expect(document.body.style.overflow).toBe("hidden");
      act(() => listener?.({ matches: true }));
      expect(
        (document.querySelector("#admin-sidebar") as HTMLElement).hasAttribute("data-open"),
      ).toBe(false);
      expect(document.body.style.overflow).toBe("");
    } finally {
      window.matchMedia = original;
    }
  });
});
