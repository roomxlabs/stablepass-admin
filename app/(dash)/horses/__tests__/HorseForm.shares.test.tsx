// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import HorseForm, { type Trainer } from "../HorseForm";
import { SHARES_WEBSITE_REQUIRED } from "@/lib/horses/shares-for-sale";

// ENG-829 — Shares for-sale toggle, gated on trainer.website_url.

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({ storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }), upload: async () => ({ data: null, error: null }) }) } }),
}));
vi.mock("@/lib/storage/photos", () => ({ signPhoto: async () => null }));

type Bff = { url: string; method?: string; body: Record<string, unknown> | null };
let bff: Bff[] = [];

function stubFetch(ok = true, message = "ok") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      bff.push({
        url: String(url),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return {
        ok,
        status: ok ? 200 : 400,
        json: async () => (ok ? { data: {} } : { error: { message } }),
      };
    }),
  );
}

const WITH_SITE: Trainer = {
  id: "t-with",
  display_name: "Chris Waller",
  stable_name: "Chris Waller Racing",
  website_url: "https://wallerracing.com.au",
};
const NO_SITE: Trainer = {
  id: "t-none",
  display_name: "No Website",
  stable_name: "Nowhere Stables",
  website_url: null,
};

const toggle = () => screen.getByTestId("shares-for-sale") as HTMLInputElement;

beforeEach(() => {
  bff = [];
  push.mockClear();
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HorseForm — Shares for sale (ENG-829)", () => {
  it("renders the Shares for sale toggle", () => {
    render(<HorseForm mode="create" trainers={[WITH_SITE]} />);
    expect(screen.getByText("Shares for sale")).toBeTruthy();
    expect(toggle().checked).toBe(false);
  });

  it("disables the toggle and shows the gate copy when the trainer has no website_url", () => {
    render(<HorseForm mode="create" trainers={[NO_SITE]} initial={{ trainerId: NO_SITE.id }} />);
    expect(toggle().disabled).toBe(true);
    expect(screen.getByTestId("shares-website-required").textContent).toBe(SHARES_WEBSITE_REQUIRED);
  });

  it("enables the toggle when the selected trainer has a website_url", () => {
    render(<HorseForm mode="create" trainers={[WITH_SITE]} initial={{ trainerId: WITH_SITE.id }} />);
    expect(toggle().disabled).toBe(false);
    expect(screen.queryByTestId("shares-website-required")).toBeNull();
  });

  it("editing a for-sale horse opens with the toggle on", () => {
    render(
      <HorseForm
        mode="edit"
        horseId="h1"
        trainers={[WITH_SITE]}
        initial={{ trainerId: WITH_SITE.id, sharesForSale: true }}
      />,
    );
    expect(toggle().checked).toBe(true);
  });

  it("persists sharesForSale=true on create when the trainer has a website", async () => {
    render(<HorseForm mode="create" trainers={[WITH_SITE]} initial={{ trainerId: WITH_SITE.id }} />);
    fireEvent.click(toggle());
    fireEvent.click(screen.getAllByRole("button", { name: /Add to library/i })[0]);
    await waitFor(() => expect(bff.some((c) => c.method === "POST")).toBe(true));
    const create = bff.find((c) => c.url === "/api/admin/horses" && c.method === "POST")!;
    expect(create.body!.sharesForSale).toBe(true);
    // Boolean only — no price / vendor / owner PII (guardrails 4/6).
    expect(create.body).not.toHaveProperty("price");
    expect(create.body).not.toHaveProperty("owner");
    expect(create.body).not.toHaveProperty("vendorContact");
    expect(create.body).not.toHaveProperty("shareCount");
  });

  it("persists sharesForSale=false when the toggle is turned off on edit", async () => {
    render(
      <HorseForm
        mode="edit"
        horseId="h1"
        trainers={[WITH_SITE]}
        initial={{ trainerId: WITH_SITE.id, sharesForSale: true }}
      />,
    );
    fireEvent.click(toggle());
    expect(toggle().checked).toBe(false);
    fireEvent.click(screen.getAllByRole("button", { name: /Save changes/i })[0]);
    await waitFor(() => expect(bff.some((c) => c.method === "PATCH" && String(c.url).includes("/horses/h1"))).toBe(true));
    const patch = bff.find((c) => c.method === "PATCH" && String(c.url).includes("/api/admin/horses/h1"))!;
    expect(patch.body!.sharesForSale).toBe(false);
  });

  it("blocks submit with the gate copy if the toggle is somehow on without a website", async () => {
    // Disabled inputs do not flip checked via click; force the gated state by
    // starting with a website trainer (toggle on), then switching to no-site.
    render(<HorseForm mode="create" trainers={[WITH_SITE, NO_SITE]} initial={{ trainerId: WITH_SITE.id }} />);
    fireEvent.click(toggle());
    expect(toggle().checked).toBe(true);
    fireEvent.change(screen.getByDisplayValue(/Chris Waller/), { target: { value: NO_SITE.id } });
    // Switching trainers without a website must clear + disable the toggle.
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(true);
    expect(screen.getByTestId("shares-website-required").textContent).toBe(SHARES_WEBSITE_REQUIRED);
  });
});
