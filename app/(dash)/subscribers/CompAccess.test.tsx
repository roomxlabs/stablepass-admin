// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import CompAccess, { GRANTED_TOAST, REVOKED_TOAST } from "./CompAccess";
import ToastRegion, { resetToastsForTest } from "../Toast";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const UID = "3f2b8c1e-5a4d-4e7f-9b6a-2c1d0e9f8a7b";
const ENDPOINT = `/api/admin/subscribers/${UID}/comp`;
let fetchMock: ReturnType<typeof vi.fn>;

// The real tree's shape: the island raises toasts into the ONE layout region.
function mount(canRevoke = false) {
  return render(
    <>
      <CompAccess userId={UID} memberLabel="Priya Raman" canRevoke={canRevoke} />
      <ToastRegion />
    </>,
  );
}
const polite = () => document.querySelector('[aria-live="polite"]') as HTMLElement;
const assertive = () => document.querySelector('[aria-live="assertive"]') as HTMLElement;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { granted: true } }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  resetToastsForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  refresh.mockReset();
});

describe("<CompAccess> grant", () => {
  it("opens an inline confirm with the five durations and sends NOTHING before Grant", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Comp access for Priya Raman" }));
    const select = screen.getByTestId("comp-duration") as HTMLSelectElement;
    expect([...select.options].map((o) => [o.value, o.text])).toEqual([
      ["monthly", "1 month"],
      ["two_month", "2 months"],
      ["three_month", "3 months"],
      ["six_month", "6 months"],
      ["yearly", "12 months"],
    ]);
    expect(fetchMock).not.toHaveBeenCalled();

    // Cancel backs out, still without a request.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("comp-confirm")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs the CHOSEN duration, toasts the eventual-consistency copy, and refreshes", async () => {
    mount();
    fireEvent.click(screen.getByTestId("comp-open"));
    fireEvent.change(screen.getByTestId("comp-duration"), { target: { value: "six_month" } });
    fireEvent.click(screen.getByTestId("comp-grant"));

    await within(polite()).findByText(GRANTED_TOAST);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ duration: "six_month" });
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByTestId("comp-confirm")).toBeNull();
  });

  it("on 502 raises an ERROR toast, keeps the confirm open, and does not refresh", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "revenuecat_unavailable", message: "x" } }), { status: 502 }),
    );
    mount();
    fireEvent.click(screen.getByTestId("comp-open"));
    fireEvent.click(screen.getByTestId("comp-grant"));

    await within(assertive()).findByText(/RevenueCat didn't confirm the change. It may not have been applied/);
    expect(within(polite()).queryByText(GRANTED_TOAST)).toBeNull();
    expect(screen.getByTestId("comp-confirm")).toBeTruthy();
    await waitFor(() => expect((screen.getByTestId("comp-grant") as HTMLButtonElement).disabled).toBe(false));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("on 503 says the server is not configured", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "revenuecat_not_configured" } }), { status: 503 }),
    );
    mount();
    fireEvent.click(screen.getByTestId("comp-open"));
    fireEvent.click(screen.getByTestId("comp-grant"));
    await within(assertive()).findByText(/isn't configured on this server/);
  });
});

describe("<CompAccess> keyboard", () => {
  it("focuses the duration select on open; Escape closes and returns focus to Comp", () => {
    mount();
    fireEvent.click(screen.getByTestId("comp-open"));
    expect(document.activeElement).toBe(screen.getByTestId("comp-duration"));
    fireEvent.keyDown(screen.getByTestId("comp-duration"), { key: "Escape" });
    expect(screen.queryByTestId("comp-confirm")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("comp-open"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("two Grant clicks in one tick send ONE request", async () => {
    mount();
    fireEvent.click(screen.getByTestId("comp-open"));
    const grant = screen.getByTestId("comp-grant") as HTMLButtonElement;
    // Both clicks inside ONE act(): React does not re-render between them, so
    // the button is still enabled for the second — the case `busy` state
    // cannot catch (two separate fireEvent calls would each flush a render).
    act(() => {
      grant.click();
      grant.click();
    });
    await within(polite()).findByText(GRANTED_TOAST);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("<CompAccess> revoke", () => {
  it("shows Revoke only when the row can be revoked", () => {
    mount(false);
    expect(screen.queryByTestId("comp-revoke")).toBeNull();
    cleanup();
    mount(true);
    expect(screen.getByRole("button", { name: "Revoke complimentary access for Priya Raman" })).toBeTruthy();
  });

  it("a declined confirm sends nothing", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mount(true);
    fireEvent.click(screen.getByTestId("comp-revoke"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Revoke complimentary access for Priya Raman?"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an accepted confirm DELETEs, toasts, and refreshes", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mount(true);
    fireEvent.click(screen.getByTestId("comp-revoke"));
    await within(polite()).findByText(REVOKED_TOAST);
    expect(fetchMock).toHaveBeenCalledWith(ENDPOINT, { method: "DELETE" });
    expect(refresh).toHaveBeenCalled();
  });
});
