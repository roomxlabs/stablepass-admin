// @vitest-environment jsdom
// Reveal password (1 Sep 2026): the eye toggle flips the field between
// type="password" and type="text", and its label always names the NEXT action.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import SignInForm from "./SignInForm";

vi.mock("./actions", () => ({
  signIn: vi.fn(),
}));

afterEach(cleanup);

describe("SignInForm reveal password", () => {
  it("masks by default and reveals on the eye toggle, both directions", () => {
    render(<SignInForm />);

    const password = document.getElementById("password") as HTMLInputElement;
    expect(password.type).toBe("password");

    const toggle = screen.getByRole("button", { name: "Show password" });
    fireEvent.click(toggle);
    expect(password.type).toBe("text");

    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(password.type).toBe("password");
  });

  it("keeps the toggle out of the form submission (type=button)", () => {
    render(<SignInForm />);

    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle.getAttribute("type")).toBe("button");
  });
});
