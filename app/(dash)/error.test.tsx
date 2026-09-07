// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import DashError from "./error";

afterEach(cleanup);

// ENG-984 review, MUST-FIX 5. ENG-984 made the dashboard's data read able to
// throw for the first time (`getAdminUserIds` fails loud rather than returning
// an empty admin set). Without a boundary that throw blanked the WHOLE
// dashboard to Next's default error page. These pin the two properties that
// make the new failure mode acceptable: the operator keeps a way forward, and
// the underlying error text never reaches the screen.
describe("(dash) error boundary", () => {
  it("renders a recoverable error state with a working retry", () => {
    const reset = vi.fn();
    render(<DashError error={new Error("boom")} reset={reset} />);

    expect(screen.getByRole("alert")).toBeTruthy();
    const retry = screen.getByRole("button", { name: /try again/i });
    retry.click();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("shows the digest for a log lookup but NOT the error text (no schema/SQL leakage)", () => {
    const err = Object.assign(
      new Error('admin exclusion: could not load admin accounts: relation "app_user" does not exist'),
      { digest: "abc123" },
    );
    render(<DashError error={err} reset={() => {}} />);

    expect(screen.getByText(/abc123/)).toBeTruthy();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/relation/i);
    expect(text).not.toMatch(/app_user/);
    expect(text).not.toMatch(/admin exclusion/i);
  });

  it("reassures that nothing was written — these are read paths", () => {
    render(<DashError error={new Error("boom")} reset={() => {}} />);
    expect(document.body.textContent).toMatch(/Nothing was changed/i);
  });
});
