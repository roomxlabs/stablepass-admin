// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import { SAVE_TOAST_HOLD_MS, saveToastHoldMs, setSaveToastHoldMs } from "./Toast";
import HorseForm from "./horses/HorseForm";
import TrainerForm from "./trainers/TrainerForm";

// ENG-964 acceptance item 2 on the two forms the ticket names. The existing
// TrainerForm/HorseForm suites cover what gets SENT; nothing covered what the
// admin is TOLD, which before this ticket was nothing at all — a successful
// save simply became the list screen.
//
// These are the four things the toast wiring adds, and none of them were
// exercised anywhere else: the success message, that it lands in the polite
// live region, that navigation is DEFERRED behind the hold (so the toast is
// actually on screen before the list replaces the form), and that the deferred
// push is cancelled on unmount.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  }),
}));
vi.mock("@/lib/storage/photos", () => ({ signPhoto: async () => null }));
// The marketing-photo copy is TrainerForm's own concern (ENG-980) and has its
// own suite; stub it as a no-op success so a save reaches the toast.
vi.mock("./trainers/marketingPhoto", () => ({
  publishMarketingPhoto: async () => ({ ok: true, path: null, message: "" }),
  unpublishMarketingPhoto: async () => ({ ok: true, path: null, message: "" }),
}));

function politeRegion() {
  return document.querySelector('[aria-live="polite"]') as HTMLElement;
}
function assertiveRegion() {
  return document.querySelector('[aria-live="assertive"]') as HTMLElement;
}

// HorseForm carries no testids on the trainer select or its submit (and renders
// the submit TWICE — topbar and form footer), so drive it through the DOM the
// way HorseForm.test.tsx does rather than by accessible name. Pick the select by
// the option it OWNS, not by position — the sex select comes first in the DOM.
function fillTrainer(r: RenderResult) {
  const select = [...r.container.querySelectorAll("select")].find((el) =>
    [...el.options].some((o) => o.value === "t1"),
  ) as HTMLSelectElement;
  expect(select, "the trainer select should offer the seeded trainer").toBeTruthy();
  fireEvent.change(select, { target: { value: "t1" } });
}
function submitHorse(r: RenderResult) {
  fireEvent.submit(r.container.querySelector("form") as HTMLFormElement);
}

const TRAINERS = [
  { id: "t1", display_name: "Chris Waller", stable_name: "Waller Racing", website_url: "https://waller.example" },
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ data: { id: "new-1" } }) })),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  setSaveToastHoldMs(SAVE_TOAST_HOLD_MS);
  vi.useRealTimers();
});

describe("the save hold is a real timer, so it must stay injectable", () => {
  it("defaults to SAVE_TOAST_HOLD_MS and can be set to 0 for tests", () => {
    expect(saveToastHoldMs()).toBe(SAVE_TOAST_HOLD_MS);
    setSaveToastHoldMs(0);
    expect(saveToastHoldMs()).toBe(0);
  });

  // The regression this guards: at 900ms the hold sat ~40ms under the 1000ms
  // default `waitFor` timeout that 17 TrainerForm navigation assertions use.
  // Green on an idle machine, a flake on a loaded one.
  it("keeps a margin under RTL's 1000ms default waitFor timeout", () => {
    expect(SAVE_TOAST_HOLD_MS).toBeLessThan(1000);
  });
});

describe("HorseForm — save feedback", () => {
  it("announces the save in the polite region and defers the navigation behind the hold", async () => {
    setSaveToastHoldMs(50);
    const r = render(<HorseForm mode="create" trainers={TRAINERS} />);
    fillTrainer(r);
    submitHorse(r);

    const toast = await screen.findByText("Horse added to the library.");
    expect(within(politeRegion()).getByText("Horse added to the library.")).toBeTruthy();
    // The toast is up BEFORE the list replaces the form — that is the point.
    expect(push).not.toHaveBeenCalled();
    expect(toast).toBeTruthy();

    await waitFor(() => expect(push).toHaveBeenCalledWith("/horses"));
  });

  it("routes a save failure to the assertive region and keeps the inline banner", async () => {
    setSaveToastHoldMs(0);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: { message: "Create failed" } }) })),
    );
    const r = render(<HorseForm mode="create" trainers={TRAINERS} />);
    fillTrainer(r);
    submitHorse(r);

    // Deliberately TWO nodes: the assertive toast (announced) and the inline
    // banner (persistent, next to the fields) — so this must not be findByText.
    const both = await screen.findAllByText("Create failed");
    expect(both).toHaveLength(2);
    expect(within(assertiveRegion()).getByText("Create failed")).toBeTruthy();
    // `.form-error` has no role, so before ENG-964 this failure was announced
    // to nobody; it stays as the persistent inline record next to the fields.
    expect(document.querySelector(".form-error")?.textContent).toBe("Create failed");
    expect(push).not.toHaveBeenCalled();
  });

  it("cancels the deferred push when the form unmounts mid-hold", async () => {
    vi.useFakeTimers();
    setSaveToastHoldMs(5000);
    const r = render(<HorseForm mode="create" trainers={TRAINERS} />);
    const { unmount } = r;
    fillTrainer(r);
    submitHorse(r);
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    // Navigating away during the hold must not fire a push afterwards.
    expect(push).not.toHaveBeenCalled();
  });
});

describe("TrainerForm — save feedback", () => {
  it("announces the save in the polite region before navigating", async () => {
    setSaveToastHoldMs(50);
    render(<TrainerForm mode="create" />);
    fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "Peter Moody" } });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    await screen.findByText("Trainer added.");
    expect(within(politeRegion()).getByText("Trainer added.")).toBeTruthy();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/trainers"));
  });

  it("leaves a save FAILURE to the form's own role=alert banner — toasting it too would announce it twice", async () => {
    setSaveToastHoldMs(0);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: "Location is not valid." } }),
      })),
    );
    render(<TrainerForm mode="create" />);
    fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "Peter Moody" } });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    await screen.findByText("Location is not valid.");
    expect(screen.getByRole("alert").textContent).toBe("Location is not valid.");
    expect(within(assertiveRegion()).queryByText("Location is not valid.")).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });
});
