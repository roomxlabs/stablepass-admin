// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import DashLayout from "./layout";
import { resetToastsForTest, showToast } from "./Toast";

// This file pins the LAYOUT mount of <ToastRegion/>, which nothing else did:
// every other toast test renders <ToastRegion/> itself, so all of them stayed
// green with the `<ToastRegion />` line deleted from layout.tsx. Here the ONLY
// thing that can put a live region in the document is the layout's own JSX —
// nothing below mounts a region, and Toast is deliberately NOT mocked.
//
// Mocked out: the auth gate (it reaches Supabase + next/headers), the sign-out
// server action, and next/navigation for AdminNav's usePathname. The toast
// region and the icons are the real modules.
vi.mock("@/lib/auth/admin", () => ({
  requireAdminPage: vi.fn(async () => ({
    sb: {},
    user: { id: "u1", email: "admin@stablepass.co" },
  })),
}));
vi.mock("@/app/signin/actions", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

afterEach(() => {
  cleanup();
  resetToastsForTest();
});

// DashLayout is an async Server Component: await it, then render the element.
async function renderLayout() {
  return render(await DashLayout({ children: <p>screen content</p> }));
}

describe("(dash)/layout — the single toast region is mounted BY THE LAYOUT", () => {
  it("puts exactly one toast stack (and one region of each politeness) on the page, with nothing else mounting one", async () => {
    await renderLayout();

    // The layout really did render — otherwise the counts below are vacuous.
    expect(screen.getByText("screen content")).toBeTruthy();
    expect(document.querySelector(".admin-shell")).toBeTruthy();

    expect(document.querySelectorAll(".adm-toast-stack")).toHaveLength(1);
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    expect(document.querySelectorAll('[aria-live="assertive"]')).toHaveLength(1);
  });

  it("the region the layout mounted is live and renders a toast raised from anywhere", async () => {
    await renderLayout();
    // No region is mounted here; if the layout stopped mounting one, this text
    // could never appear.
    showToast("Saved.", "success");
    expect(await screen.findByText("Saved.")).toBeTruthy();
    const polite = document.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(polite.textContent).toContain("Saved.");
  });

  it("mounts the regions BEFORE any message lands in them — an empty stack is present on first paint", async () => {
    await renderLayout();
    const stack = document.querySelector(".adm-toast-stack") as HTMLElement;
    expect(stack).toBeTruthy();
    expect(stack.querySelectorAll('[data-testid="adm-toast"]')).toHaveLength(0);
  });
});
