// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import HorseForm, { type HorseInitial, type Trainer } from "../HorseForm";

// next/link → plain anchor; the router and the storage/network layers are
// stubbed so the form renders inertly — these tests only drive the sex controls.
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({}) }));
vi.mock("@/lib/storage/photos", () => ({ signPhoto: async () => null }));

const TRAINERS: Trainer[] = [{ id: "t1", display_name: "Chris Waller", stable_name: "Chris Waller Racing" }];

function renderForm(initial: HorseInitial = {}, mode: "create" | "edit" = "create") {
  return render(<HorseForm mode={mode} trainers={TRAINERS} horseId="h1" initial={initial} />);
}

const sexSelect = () => screen.getByLabelText("Sex") as HTMLSelectElement;
const geldedBox = () => screen.getByLabelText("Gelded") as HTMLInputElement;

afterEach(cleanup);

describe("HorseForm — the sex control (ENG-616)", () => {
  it("offers exactly two selectable options: Male and Female", () => {
    renderForm();
    const selectable = Array.from(sexSelect().options).filter((o) => !o.disabled);
    expect(selectable).toHaveLength(2);
    expect(selectable.map((o) => o.value)).toEqual(["male", "female"]);
    expect(selectable.map((o) => o.textContent)).toEqual(["Male", "Female"]);
  });

  it("carries exactly one non-selectable placeholder, so 'unset' is not 'Male'", () => {
    renderForm();
    const placeholders = Array.from(sexSelect().options).filter((o) => o.disabled);
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0].value).toBe("");
  });

  it("offers no stallion anywhere in the form", () => {
    const { container } = renderForm();
    expect(container.textContent?.toLowerCase()).not.toContain("stallion");
  });

  it("renders a Gelded checkbox with the mockup's helper text", () => {
    renderForm();
    expect(geldedBox().type).toBe("checkbox");
    expect(screen.getByText(/Shows as .gelding. at any age, overriding colt or horse\./)).toBeTruthy();
  });

  it("adds no owner field (guardrail: no owner PII)", () => {
    const { container } = renderForm();
    expect(container.textContent?.toLowerCase()).not.toContain("owner");
  });
});

describe("HorseForm — selecting Female", () => {
  it("CLEARS isGelded in state, not merely disabling the input", () => {
    // A stale `true` behind a disabled control would still be submitted and
    // rejected by the database CHECK, so `checked` must actually go false.
    renderForm({ sex: "male", isGelded: true });
    expect(geldedBox().checked).toBe(true);

    fireEvent.change(sexSelect(), { target: { value: "female" } });

    expect(geldedBox().checked).toBe(false);
    expect(geldedBox().disabled).toBe(true);
  });

  it("does not silently restore Gelded when the operator switches back to Male", () => {
    renderForm({ sex: "male", isGelded: true });
    fireEvent.change(sexSelect(), { target: { value: "female" } });
    fireEvent.change(sexSelect(), { target: { value: "male" } });
    expect(geldedBox().checked).toBe(false);
    expect(geldedBox().disabled).toBe(false);
  });

  it("keeps Gelded checkable while Male is selected", () => {
    renderForm({ sex: "male", isGelded: false });
    expect(geldedBox().disabled).toBe(false);
    fireEvent.click(geldedBox());
    expect(geldedBox().checked).toBe(true);
  });
});

describe("HorseForm — prefill", () => {
  it("prefills an existing gelding as Male + checked", () => {
    renderForm({ sex: "male", isGelded: true }, "edit");
    expect(sexSelect().value).toBe("male");
    expect(geldedBox().checked).toBe(true);
  });

  it("prefills a mare as Female, unchecked and disabled", () => {
    renderForm({ sex: "female", isGelded: false }, "edit");
    expect(sexSelect().value).toBe("female");
    expect(geldedBox().checked).toBe(false);
    expect(geldedBox().disabled).toBe(true);
  });

  it("prefills a NULL-sex row with NEITHER — no defaulting to Male", () => {
    // The old form defaulted to "gelding"; defaulting is how the bad data got
    // in, so an unmapped legacy row must render unselected.
    renderForm({}, "edit");
    expect(sexSelect().value).toBe("");
    expect(sexSelect().options[sexSelect().selectedIndex].disabled).toBe(true);
    expect(geldedBox().checked).toBe(false);
    expect(geldedBox().disabled).toBe(true);
  });

  it("starts a NEW horse unselected too", () => {
    renderForm({}, "create");
    expect(sexSelect().value).toBe("");
  });
});
